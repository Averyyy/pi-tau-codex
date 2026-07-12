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

test("API-key login explicitly marks browser input as secret", async () => {
  const login = getWebParityCommand("login");
  let inputOptions;
  let stored;
  const authStorage = {
    reload: () => {},
    drainErrors: () => [],
    getAll: () => ({}),
    getOAuthProviders: () => [],
    set: (provider, credential) => { stored = { provider, credential }; },
  };
  const ctx = {
    signal: undefined,
    modelRegistry: {
      authStorage,
      getAll: () => [{ provider: "openai" }],
      getProviderDisplayName: () => "OpenAI",
      refresh: () => {},
    },
    ui: {
      input: async (_title, _placeholder, options) => {
        inputOptions = options;
        return "test-key";
      },
      notify: () => {},
    },
  };

  await login.handler("openai api-key", ctx, {});
  assert.equal(inputOptions.secret, true);
  assert.deepEqual(stored, {
    provider: "openai",
    credential: { type: "api_key", key: "test-key" },
  });
});

test("OAuth manual codes are secret while ordinary OAuth prompts stay visible", async () => {
  const login = getWebParityCommand("login");
  const inputs = [];
  const authStorage = {
    reload: () => {},
    drainErrors: () => [],
    getAll: () => ({}),
    getOAuthProviders: () => [{ id: "openai" }],
    login: async (_provider, callbacks) => {
      await callbacks.onManualCodeInput();
      await callbacks.onPrompt({ message: "Account name", placeholder: "name", allowEmpty: false });
    },
  };
  const ctx = {
    signal: undefined,
    modelRegistry: {
      authStorage,
      getAll: () => [{ provider: "openai" }],
      getProviderDisplayName: () => "OpenAI",
      refresh: () => {},
    },
    ui: {
      input: async (title, _placeholder, options) => {
        inputs.push({ title, options });
        return "value";
      },
      notify: () => {},
    },
  };

  await login.handler("openai oauth", ctx, {});
  assert.equal(inputs[0].options.secret, true);
  assert.equal(inputs[1].options.secret, undefined);
});
