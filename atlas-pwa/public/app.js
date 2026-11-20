import { renderMarkdown } from "./md.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  login: $("#login"), loginForm: $("#login-form"), passcode: $("#passcode"), loginError: $("#login-error"),
  app: $("#app"), sidebar: $("#sidebar"), scrim: $("#scrim"), list: $("#conversation-list"), search: $("#search"),
  menu: $("#menu"), title: $("#title"), chatMenu: $("#chat-menu"), newChat: $("#new-chat"), newChatSide: $("#new-chat-side"),
  scroller: $("#scroller"), messages: $("#messages"), empty: $("#empty"),
  composer: $("#composer"), input: $("#input"), send: $("#send"), stop: $("#stop"),
  status: $("#status-pill"), sheet: $("#sheet"), toast: $("#toast"),
};

const TOKEN_KEY = "atlas.passcode";
const LIST_CACHE_KEY = "atlas.conversations";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  token: store.get(TOKEN_KEY),
  conversations: [],
  current: null, // full conversation object, or null for an unsaved new chat
  streaming: null, // AbortController while Atlas is answering
  stickToBottom: true,
};

// ---------------------------------------------------------------- api
async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    lock("That passcode didn't work.");
    throw new Error("Unauthorized");
  }
  if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res;
}
const getJSON = async (path) => (await api(path)).json();

// ---------------------------------------------------------------- auth
function lock(message = "") {
  state.token = null;
  store.del(TOKEN_KEY);
  els.app.hidden = true;
  els.login.hidden = false;
  els.loginError.textContent = message;
  els.passcode.value = "";
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  state.token = els.passcode.value;
  try {
    await getJSON("/status");
    store.set(TOKEN_KEY, state.token);
    await start();
  } catch (err) {
    if (err.message !== "Unauthorized") els.loginError.textContent = "Can't reach the Atlas server.";
  }
});
for (const b of document.querySelectorAll("[data-lock]")) b.addEventListener("click", () => lock());

// ---------------------------------------------------------------- layout
const compactMQ = matchMedia("(max-width: 699.98px) and (not (horizontal-viewport-segments: 2))");
const isCompact = () => compactMQ.matches;

function openDrawer(open) {
  if (!isCompact()) open = false;
  els.app.classList.toggle("drawer-open", open);
  els.scrim.hidden = !open;
  els.sidebar.inert = isCompact() && !open;
}
els.menu.addEventListener("click", () => openDrawer(true));
els.scrim.addEventListener("click", () => openDrawer(false));
// Folding/unfolding the phone switches between screens: reset the drawer.
compactMQ.addEventListener("change", () => openDrawer(false));

// Edge-swipe to open the drawer, swipe left to close it (compact only).
let touch = null;
document.addEventListener("touchstart", (e) => {
  if (!isCompact() || e.touches.length !== 1) return;
  const t = e.touches[0];
  const open = els.app.classList.contains("drawer-open");
  if ((!open && t.clientX < 24) || open) touch = { x: t.clientX, y: t.clientY, open };
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = Math.abs(t.clientY - touch.y);
  if (dy < 60) {
    if (!touch.open && dx > 60) openDrawer(true);
    if (touch.open && dx < -60) openDrawer(false);
  }
  touch = null;
}, { passive: true });

// Keep the app exactly as tall as the visible area so the composer sits
// right above the iOS keyboard.
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${h}px`);
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("scroll", syncViewport);
window.addEventListener("orientationchange", () => setTimeout(syncViewport, 300));
syncViewport();

// ---------------------------------------------------------------- sidebar
function groupLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Previous 7 days";
  if (diff < 30) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function renderList() {
  const q = els.search.value.trim().toLowerCase();
  const items = state.conversations.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q),
  );
  els.list.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "list-empty";
    p.textContent = q ? "No matching pages" : "No pages";
    els.list.append(p);
    return;
  }
  let last = null;
  for (const c of items) {
    const label = groupLabel(c.updatedAt);
    if (label !== last) {
      const g = document.createElement("div");
      g.className = "group-label";
      g.textContent = label;
      els.list.append(g);
      last = label;
    }
    const a = document.createElement("a");
    a.className = "convo";
    a.href = `#/c/${c.id}`;
    if (state.current?.id === c.id) a.setAttribute("aria-current", "page");
    a.textContent = c.title;
    a.title = c.title;
    els.list.append(a);
  }
}
els.search.addEventListener("input", renderList);

async function loadList() {
  try {
    state.conversations = await getJSON("/conversations");
    store.set(LIST_CACHE_KEY, JSON.stringify(state.conversations));
    setStatusOnline(true);
  } catch (err) {
    if (err.message === "Unauthorized") return;
    state.conversations = JSON.parse(store.get(LIST_CACHE_KEY) || "[]");
    setStatusOnline(false);
  }
  renderList();
}

function upsertSummary(s) {
  state.conversations = [s, ...state.conversations.filter((c) => c.id !== s.id)];
  store.set(LIST_CACHE_KEY, JSON.stringify(state.conversations));
  renderList();
}

let statusInfo = null;
function setStatusOnline(online) {
  if (!online) {
    els.status.textContent = "Offline";
    els.status.className = "pill offline";
  } else if (statusInfo) {
    els.status.textContent = statusInfo.mock ? "Demo mode" : "Connected to Atlas";
    els.status.className = statusInfo.mock ? "pill demo" : "pill";
  }
}

// ---------------------------------------------------------------- routing
function route() {
  const m = location.hash.match(/^#\/c\/([a-z0-9-]+)$/);
  openDrawer(false);
  if (m) openConversation(m[1]);
  else showNewChat();
}
window.addEventListener("hashchange", route);

function newChat() {
  if (location.hash === "#/" || location.hash === "") showNewChat();
  else location.hash = "#/";
  openDrawer(false);
  if (!isCompact()) els.input.focus();
}
els.newChat.addEventListener("click", newChat);
els.newChatSide.addEventListener("click", newChat);

function showNewChat() {
  state.current = null;
  els.title.textContent = "New page";
  els.chatMenu.hidden = true;
  els.messages.replaceChildren();
  els.empty.hidden = false;
  renderList();
}

async function openConversation(id) {
  if (state.current?.id === id) return;
  try {
    const convo = await getJSON(`/conversations/${id}`);
    state.current = convo;
    els.title.textContent = convo.title;
    els.chatMenu.hidden = false;
    els.empty.hidden = convo.messages.length > 0;
    els.messages.replaceChildren(...renderHistory(convo.messages));
    renderList();
    scrollToBottom(true);
  } catch (err) {
    if (err.message === "Unauthorized") return;
    toast(navigator.onLine ? "Couldn't open that page." : "You're offline.");
    location.hash = "#/";
  }
}

// ---------------------------------------------------------------- rendering
function renderHistory(messages) {
  const nodes = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      nodes.push(userBubble(text));
    } else if (m.role === "assistant") {
      const view = assistantView();
      for (const block of m.content) view.addBlock(block);
      view.finish();
      nodes.push(view.el);
    }
  }
  return nodes;
}

function userBubble(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  return el;
}

const TOOL_LABELS = (name) => name.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Builds one assistant reply, either from stored blocks or from a live stream. */
function assistantView() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  const steps = document.createElement("div");
  steps.className = "steps";
  const body = document.createElement("div");
  body.className = "body";
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = "<i></i><i></i><i></i>";
  el.append(steps, body, typing);
  typing.hidden = true;

  let text = "";
  let thought = "";
  let thinkingEl = null;
  const chips = new Map();
  let frame = 0;

  const renderBody = () => {
    frame = 0;
    body.innerHTML = renderMarkdown(text);
  };
  const scheduleBody = () => {
    if (!frame) frame = requestAnimationFrame(() => { renderBody(); scrollToBottom(); });
  };

  const ensureThinking = () => {
    if (thinkingEl) return thinkingEl;
    thinkingEl = document.createElement("details");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML = "<summary>Working</summary><div class=\"thought\"></div>";
    el.insertBefore(thinkingEl, steps);
    return thinkingEl;
  };

  const addChip = (id, name) => {
    const chip = document.createElement("span");
    chip.className = "chip running";
    chip.innerHTML = '<i class="dot"></i><span></span>';
    chip.lastChild.textContent = TOOL_LABELS(name);
    chip.title = name;
    steps.append(chip);
    chips.set(id, chip);
  };
  const finishChip = (id, isError) => {
    const chip = chips.get(id);
    if (chip) chip.className = `chip ${isError ? "err" : "ok"}`;
  };

  return {
    el,
    setWaiting(on) { typing.hidden = !on; },
    appendText(t) { text += t; typing.hidden = true; scheduleBody(); },
    appendThinking(t) {
      thought += t;
      const d = ensureThinking();
      d.querySelector(".thought").textContent = thought;
    },
    toolUse(id, name) { addChip(id, name); typing.hidden = false; scrollToBottom(); },
    toolResult(id, isError) { finishChip(id, isError); },
    addBlock(b) {
      if (b.type === "text") { text += (text && !text.endsWith("\n") ? "\n\n" : "") + b.text; }
      else if (b.type === "thinking" && b.thinking) { thought += (thought ? "\n\n" : "") + b.thinking; ensureThinking().querySelector(".thought").textContent = thought; }
      else if (b.type === "mcp_tool_use") addChip(b.id, b.name);
      else if (b.type === "mcp_tool_result") finishChip(b.tool_use_id, b.is_error);
      else if (b.type === "fallback") this.note("Answered by a fallback model.");
    },
    note(msg, isError = false) {
      const n = document.createElement("div");
      n.className = `note${isError ? " err" : ""}`;
      n.textContent = msg;
      el.append(n);
    },
    finish() {
      if (frame) cancelAnimationFrame(frame);
      renderBody();
      typing.hidden = true;
      for (const chip of steps.querySelectorAll(".chip.running")) chip.className = "chip";
      steps.hidden = !steps.childElementCount;
    },
  };
}

// ---------------------------------------------------------------- scrolling
els.scroller.addEventListener("scroll", () => {
  const s = els.scroller;
  state.stickToBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}, { passive: true });
function scrollToBottom(force = false) {
  if (force || state.stickToBottom) els.scroller.scrollTop = els.scroller.scrollHeight;
}

// ---------------------------------------------------------------- composer
const finePointer = matchMedia("(pointer: fine)");
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
  els.send.disabled = !els.input.value.trim() || !!state.streaming;
}
els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
  // Hardware keyboard (e.g. inner screen with a keyboard): Enter sends.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && finePointer.matches) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (text && !state.streaming) sendMessage(text);
});
els.stop.addEventListener("click", () => state.streaming?.abort());
for (const b of document.querySelectorAll(".suggestion")) {
  b.addEventListener("click", () => sendMessage(b.textContent));
}

function setStreaming(controller) {
  state.streaming = controller;
  els.send.hidden = !!controller;
  els.stop.hidden = !controller;
  autosize();
}

async function sendMessage(text) {
  els.input.value = "";
  autosize();
  if (isCompact()) els.input.blur();

  const controller = new AbortController();
  setStreaming(controller);
  els.empty.hidden = true;
  const bubble = userBubble(text);
  const view = assistantView();
  els.messages.append(bubble, view.el);
  view.setWaiting(true);
  scrollToBottom(true);

  let finished = false;
  try {
    if (!state.current) {
      const convo = await (await api("/conversations", { method: "POST" })).json();
      state.current = convo;
      history.replaceState(null, "", `#/c/${convo.id}`);
      els.chatMenu.hidden = false;
    }
    const convoId = state.current.id;
    const res = await api(`/conversations/${convoId}/messages`, { method: "POST", body: { text }, signal: controller.signal });

    for await (const { event, data } of readSSE(res.body)) {
      if (event === "text") view.appendText(data.text);
      else if (event === "thinking") view.appendThinking(data.text);
      else if (event === "tool_use") view.toolUse(data.id, data.name);
      else if (event === "tool_result") view.toolResult(data.id, data.isError);
      else if (event === "error") throw new Error(data.message);
      else if (event === "done") {
        finished = true;
        view.finish();
        if (data.stopReason === "refusal") view.note("Atlas declined to answer this request.", true);
        else if (data.stopReason === "max_tokens") view.note("The reply hit its length limit.");
        if (state.current?.id === convoId) {
          state.current.messages.push({ role: "user", content: [{ type: "text", text }] }, data.message);
          state.current.title = data.conversation.title;
          els.title.textContent = data.conversation.title;
        }
        upsertSummary(data.conversation);
      }
    }
    if (!finished) throw new Error("The connection closed before Atlas finished.");
  } catch (err) {
    view.finish();
    const stopped = err.name === "AbortError";
    if (err.message !== "Unauthorized") {
      view.note(stopped ? "Stopped. This exchange wasn't saved." : `${err.message} This exchange wasn't saved.`, !stopped);
    }
    if (!els.input.value) { els.input.value = text; autosize(); }
  } finally {
    setStreaming(null);
    scrollToBottom();
  }
}

async function* readSSE(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

// ---------------------------------------------------------------- chat options
function openSheet(open) { els.sheet.hidden = !open; }
els.chatMenu.addEventListener("click", () => openSheet(true));
els.title.addEventListener("click", () => state.current && renameCurrent());
els.sheet.addEventListener("click", async (e) => {
  const action = e.target.closest("button")?.dataset.action;
  if (e.target === els.sheet || action === "cancel") return openSheet(false);
  openSheet(false);
  if (action === "rename") renameCurrent();
  if (action === "delete") deleteCurrent();
});

async function renameCurrent() {
  const c = state.current;
  const title = prompt("Rename page", c.title)?.trim();
  if (!title || title === c.title) return;
  try {
    const s = await (await api(`/conversations/${c.id}`, { method: "PATCH", body: { title } })).json();
    c.title = s.title;
    els.title.textContent = s.title;
    upsertSummary(s);
  } catch { toast("Couldn't rename the page."); }
}

async function deleteCurrent() {
  const c = state.current;
  if (!confirm(`Delete "${c.title}"? This can't be undone.`)) return;
  try {
    await api(`/conversations/${c.id}`, { method: "DELETE" });
    state.conversations = state.conversations.filter((x) => x.id !== c.id);
    store.set(LIST_CACHE_KEY, JSON.stringify(state.conversations));
    newChat();
  } catch { toast("Couldn't delete the page."); }
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

window.addEventListener("online", loadList);
window.addEventListener("offline", () => setStatusOnline(false));

// ---------------------------------------------------------------- boot
async function start() {
  els.login.hidden = true;
  els.app.hidden = false;
  openDrawer(false);
  try { statusInfo = await getJSON("/status"); } catch (err) { if (err.message === "Unauthorized") return; }
  await loadList();
  route();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

if (state.token) start();
else lock();
