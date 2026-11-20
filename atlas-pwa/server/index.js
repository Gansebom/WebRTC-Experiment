import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { ConversationStore, summary } from "./store.js";
import { runTurn, atlasModel } from "./atlas.js";
import { runMockTurn } from "./mock.js";
import { taniumConfigured } from "./tanium-auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PORT = Number(process.env.PORT) || 8787;
const MOCK = process.env.ATLAS_MOCK === "1";
const PASSCODE = process.env.APP_PASSCODE;

if (!PASSCODE) {
  console.error("APP_PASSCODE is required: it protects your Tanium access. See .env.example.");
  process.exit(1);
}
if (!MOCK && !taniumConfigured()) {
  console.error(
    "Tanium is not configured. Set TANIUM_MCP_URL and either TANIUM_MCP_TOKEN or the " +
      "TANIUM_OAUTH_* variables (see .env.example), or run `npm run mock` for demo mode.",
  );
  process.exit(1);
}

const store = new ConversationStore(process.env.DATA_DIR || path.join(root, "data", "conversations"));
await store.init();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Security headers for the app shell.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
  next();
});

// ---- auth -------------------------------------------------------------
const passHash = crypto.createHash("sha256").update(PASSCODE).digest();
function authorized(req) {
  const header = req.get("authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const hash = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(hash, passHash);
}
const api = express.Router();
api.use((req, res, next) => (authorized(req) ? next() : res.status(401).json({ error: "Unauthorized" })));

// ---- routes -----------------------------------------------------------
api.get("/status", (req, res) => {
  res.json({ mock: MOCK, model: MOCK ? "demo" : atlasModel, tanium: MOCK ? false : taniumConfigured() });
});

api.get("/conversations", async (req, res, next) => {
  try {
    res.json(await store.list());
  } catch (e) {
    next(e);
  }
});

api.post("/conversations", async (req, res, next) => {
  try {
    res.status(201).json(await store.create());
  } catch (e) {
    next(e);
  }
});

api.get("/conversations/:id", async (req, res, next) => {
  try {
    const c = await store.get(req.params.id);
    c ? res.json(c) : res.status(404).json({ error: "Not found" });
  } catch (e) {
    next(e);
  }
});

api.patch("/conversations/:id", async (req, res, next) => {
  try {
    const c = await store.get(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    const title = String(req.body?.title ?? "").trim().slice(0, 120);
    if (!title) return res.status(400).json({ error: "Title required" });
    c.title = title;
    res.json(summary(await store.save(c)));
  } catch (e) {
    next(e);
  }
});

api.delete("/conversations/:id", async (req, res, next) => {
  try {
    await store.remove(req.params.id);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// Send a message; the reply streams back as Server-Sent Events.
const busy = new Set();
api.post("/conversations/:id/messages", async (req, res, next) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Message required" });
  if (text.length > 20000) return res.status(413).json({ error: "Message too long" });

  let convo;
  try {
    convo = await store.get(req.params.id);
  } catch (e) {
    return next(e);
  }
  if (!convo) return res.status(404).json({ error: "Not found" });
  if (busy.has(convo.id)) return res.status(409).json({ error: "Atlas is still answering on this page" });
  busy.add(convo.id);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const run = MOCK ? runMockTurn : runTurn;
    const result = await run(convo.messages, text, {
      signal: controller.signal,
      onText: (t) => send("text", { text: t }),
      onThinking: (t) => send("thinking", { text: t }),
      onBlock: (b) => {
        if (b.type === "mcp_tool_use") send("tool_use", { id: b.id, name: b.name, input: b.input });
        else if (b.type === "mcp_tool_result") send("tool_result", { id: b.tool_use_id, isError: b.is_error });
      },
    });

    // Store the turn only once it finished, so history stays a clean
    // user/assistant alternation and the API content is kept unmodified.
    convo.messages.push(result.userMessage, result.assistantMessage);
    if (convo.messages.length === 2) convo.title = makeTitle(text);
    await store.save(convo);

    send("done", {
      stopReason: result.stopReason,
      message: result.assistantMessage,
      conversation: summary(convo),
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error("turn failed:", err);
      send("error", { message: describeError(err) });
    }
  } finally {
    clearInterval(heartbeat);
    busy.delete(convo.id);
    res.end();
  }
});

app.use("/api", api);
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// ---- static PWA ---------------------------------------------------------
app.use(
  express.static(path.join(root, "public"), {
    setHeaders(res, file) {
      if (file.endsWith("sw.js") || file.endsWith(".html") || file.endsWith(".webmanifest")) {
        res.setHeader("Cache-Control", "no-cache");
      }
      if (file.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
    },
  }),
);
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(root, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Server error" });
});

app.listen(PORT, () => {
  console.log(`Tanium Atlas PWA on http://localhost:${PORT} ${MOCK ? "(demo mode)" : `(model ${atlasModel})`}`);
});

// ---- helpers ----------------------------------------------------------
function makeTitle(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the server.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.error?.error?.message || err.message;
    if (/mcp/i.test(msg)) return `Couldn't reach the Tanium Atlas MCP server: ${msg}`;
    return `Request rejected: ${msg}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Check the server's network.";
  if (err instanceof Anthropic.APIError) return `AI service error (${err.status ?? "unknown"}). Try again.`;
  return err.message || "Something went wrong.";
}
