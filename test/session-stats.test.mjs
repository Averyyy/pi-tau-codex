import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSessionStats } from "../extensions/session-stats.js";

test("session stats count messages, tool blocks, compactions, branches, tokens, and cost", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "hello" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }, { type: "toolCall" }, { type: "toolCall" }],
        usage: {
          input: 10,
          output: 4,
          cacheRead: 3,
          cacheWrite: 2,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
      },
    },
    { type: "message", message: { role: "toolResult", content: [] } },
    { type: "compaction" },
    { type: "session_info", name: "not a message" },
  ];
  const leaf = { entry: {}, children: [] };
  const tree = [{ entry: {}, children: [leaf, { entry: {}, children: [leaf] }] }];

  assert.deepEqual(aggregateSessionStats(entries, tree), {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 2,
    toolResults: 1,
    totalMessages: 3,
    compactions: 1,
    branchPoints: 1,
    tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, total: 19 },
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
});
