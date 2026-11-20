// Demo mode (ATLAS_MOCK=1): a fake Atlas turn so the app can be tried on a
// phone without Anthropic or Tanium credentials. Nothing here touches Tanium.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

export async function runMockTurn(history, userText, hooks) {
  const { signal } = hooks;
  const userMessage = { role: "user", content: [{ type: "text", text: userText }] };
  const content = [];

  const thinking = "Checking which endpoints match the question before answering.";
  hooks.onThinking?.(thinking);
  content.push({ type: "thinking", thinking, signature: "mock" });
  await sleep(400, signal);

  const toolUse = {
    type: "mcp_tool_use",
    id: `mcptoolu_mock_${Date.now()}`,
    name: "ask_atlas",
    server_name: "tanium-atlas",
    input: { question: userText },
  };
  hooks.onBlock?.(toolUse);
  content.push(toolUse);
  await sleep(900, signal);

  const toolResult = {
    type: "mcp_tool_result",
    tool_use_id: toolUse.id,
    is_error: false,
    content: [{ type: "text", text: '{"endpoints_online": 1284, "critical_patches_missing": 37}' }],
  };
  hooks.onBlock?.(toolResult);
  content.push(toolResult);

  const reply = `**Demo mode** — this reply is simulated, not live Tanium data.

You asked: _${userText.replace(/[_*`]/g, "")}_

| Metric | Value |
| --- | --- |
| Endpoints online | 1,284 |
| Missing critical patches | 37 |
| Turn number | ${history.filter((m) => m.role === "user").length + 1} |

Set \`ANTHROPIC_API_KEY\` and \`TANIUM_MCP_URL\` and restart without \`ATLAS_MOCK\` to talk to Atlas.`;

  for (const chunk of reply.match(/[\s\S]{1,12}/g)) {
    hooks.onText?.(chunk);
    await sleep(25, signal);
  }
  content.push({ type: "text", text: reply });

  return { userMessage, assistantMessage: { role: "assistant", content }, stopReason: "end_turn" };
}
