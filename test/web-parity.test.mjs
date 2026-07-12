import assert from "node:assert/strict";
import test from "node:test";

import webParityExtension, { getWebParityCommand } from "../extensions/web-parity.ts";

test("quit requires confirmation and delegates shutdown to its host after acknowledgement", async () => {
  const quit = getWebParityCommand("quit");
  let shutdowns = 0;
  const ctx = {
    signal: undefined,
    shutdown: () => { shutdowns++; },
    ui: { confirm: async () => false },
  };

  assert.deepEqual(await quit.handler("", ctx, {}), { command: "quit", status: "ok" });
  assert.equal(shutdowns, 0);

  ctx.ui.confirm = async () => true;
  assert.deepEqual(await quit.handler("", ctx, {}), { command: "quit", status: "shutdown" });
  assert.equal(shutdowns, 0);

  let registeredQuit;
  webParityExtension({
    registerCommand: (name, command) => {
      if (name === "tau-quit") registeredQuit = command;
    },
  });
  await registeredQuit.handler("", ctx);
  assert.equal(shutdowns, 1);
});
