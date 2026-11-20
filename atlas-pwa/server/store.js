// File-backed conversation store. One JSON file per conversation, so a
// conversation's full API history (including thinking and MCP tool blocks,
// which must be sent back unchanged on later turns) is kept exactly as the
// API returned it.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ID_RE = /^[a-z0-9-]{8,64}$/;

export class ConversationStore {
  constructor(dir) {
    this.dir = dir;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  #file(id) {
    if (!ID_RE.test(id)) throw Object.assign(new Error("Invalid id"), { status: 400 });
    return path.join(this.dir, `${id}.json`);
  }

  async list() {
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const items = await Promise.all(
      names.map(async (n) => {
        try {
          const c = JSON.parse(await fs.readFile(path.join(this.dir, n), "utf8"));
          return summary(c);
        } catch {
          return null;
        }
      }),
    );
    // Chats whose first message never completed have no turns; keep them out of history.
    return items.filter((c) => c && c.turns > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.#file(id), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async create(title = "New chat") {
    const now = new Date().toISOString();
    const convo = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, messages: [] };
    await this.save(convo);
    return convo;
  }

  async save(convo) {
    convo.updatedAt = new Date().toISOString();
    const file = this.#file(convo.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(convo));
    await fs.rename(tmp, file);
    return convo;
  }

  async remove(id) {
    await fs.rm(this.#file(id), { force: true });
  }
}

export function summary(c) {
  const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    preview: lastUser ? textOf(lastUser.content).slice(0, 120) : "",
    turns: c.messages.filter((m) => m.role === "user").length,
  };
}

export function textOf(content) {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
