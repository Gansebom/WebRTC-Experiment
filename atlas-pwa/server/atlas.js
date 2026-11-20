// Runs one chat turn: Claude, connected to the Tanium Atlas MCP server through
// the Messages API MCP connector, answers with live Tanium data.
import Anthropic from "@anthropic-ai/sdk";
import { getTaniumToken } from "./tanium-auth.js";

const MODEL = process.env.ATLAS_MODEL || "claude-opus-5-5";
// Opus 5.5 defaults to "medium"; set explicitly so it is visible and tunable.
const EFFORT = process.env.ATLAS_EFFORT || "medium";
const MCP_SERVER_NAME = "tanium-atlas";
const MAX_CONTINUATIONS = 5; // pause_turn resumptions per user turn

const SYSTEM_PROMPT = `You are Tanium Atlas Mobile, an assistant for IT and security operators, used from an iPhone.

You are connected to the operator's Tanium environment through the Tanium Atlas MCP server. Use its tools to answer questions about endpoints, software, vulnerabilities, compliance, performance and incidents with live data rather than guessing. If a tool returns an error or no data, say so plainly.

Before any action that changes endpoints (deploying packages or patches, running actions, quarantining, restarting, changing configuration), describe exactly what would run and on which machines, and ask the operator to confirm in the chat first. Read-only questions need no confirmation.

You are read on a phone screen. Lead with the answer, keep paragraphs short, and use small Markdown tables or bullet lists for lists of endpoints or findings. Summarize large result sets (counts, top items) and offer to drill in instead of pasting everything.`;

let client;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

/**
 * @param {Array} history  Prior API messages (stored unchanged).
 * @param {string} userText
 * @param {object} hooks   { onText, onThinking, onBlock, signal }
 * @returns {Promise<{ userMessage, assistantMessage, stopReason }>}
 */
export async function runTurn(history, userText, hooks) {
  const token = await getTaniumToken();
  const userMessage = { role: "user", content: [{ type: "text", text: userText }] };
  const assistantContent = [];
  let stopReason = null;

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const messages = [...history, userMessage];
    // A paused turn is resumed by sending the partial assistant turn back as-is.
    if (assistantContent.length) messages.push({ role: "assistant", content: assistantContent });

    const stream = anthropic().beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        betas: ["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" },
        system: SYSTEM_PROMPT,
        mcp_servers: [
          {
            type: "url",
            name: MCP_SERVER_NAME,
            url: process.env.TANIUM_MCP_URL,
            ...(token ? { authorization_token: token } : {}),
          },
        ],
        tools: [{ type: "mcp_toolset", mcp_server_name: MCP_SERVER_NAME }],
        messages,
      },
      { signal: hooks.signal },
    );

    stream.on("text", (delta) => hooks.onText?.(delta));
    stream.on("thinking", (delta) => hooks.onThinking?.(delta));
    stream.on("contentBlock", (block) => hooks.onBlock?.(block));

    const message = await stream.finalMessage();
    assistantContent.push(...message.content);
    stopReason = message.stop_reason;
    if (stopReason !== "pause_turn") break;
  }

  return {
    userMessage,
    assistantMessage: { role: "assistant", content: assistantContent },
    stopReason,
  };
}

export const atlasModel = MODEL;
