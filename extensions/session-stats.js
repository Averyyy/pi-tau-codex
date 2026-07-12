export function aggregateSessionStats(entries, tree) {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalMessages = 0;
  let compactions = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  for (const entry of entries) {
    if (entry.type === "compaction") {
      compactions++;
      continue;
    }
    if (entry.type !== "message") continue;

    totalMessages++;
    const message = entry.message;
    if (message.role === "user") userMessages++;
    if (message.role === "toolResult") toolResults++;
    if (message.role !== "assistant") continue;

    assistantMessages++;
    toolCalls += Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall").length
      : 0;
    const usage = message.usage;
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      tokens[key] += usage[key] || 0;
      cost[key] += usage.cost?.[key] || 0;
    }
    cost.total += usage.cost?.total || 0;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

  let branchPoints = 0;
  const pending = [...tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.children.length > 1) branchPoints++;
    pending.push(...node.children);
  }

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    compactions,
    branchPoints,
    tokens,
    cost,
  };
}
