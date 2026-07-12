import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createContextSettingsManager,
  parseChangelog,
  readAboutInfo,
  readEnabledModelScope,
  readProviderAccounts,
  writeEnabledModelScope,
} from "../extensions/settings-parity.js";

function modelRegistry(authStorage) {
  const models = [
    { provider: "openai", id: "gpt-5", name: "GPT-5" },
    { provider: "anthropic", id: "claude", name: "Claude" },
  ];
  return {
    authStorage,
    getAll: () => models,
    getProviderDisplayName: (id) => ({ openai: "OpenAI", anthropic: "Anthropic" })[id] || id,
    getProviderAuthStatus: (id) => ({
      configured: id === "openai",
      ...(id === "openai" ? { source: "stored", label: "OAuth" } : {}),
    }),
  };
}

test("provider accounts expose status and capabilities without credentials", () => {
  let reloaded = 0;
  const authStorage = {
    reload: () => { reloaded++; },
    drainErrors: () => [],
    getOAuthProviders: () => [{ id: "openai" }],
    list: () => ["openai"],
    has: (id) => id === "openai",
    get: () => { throw new Error("credential access is forbidden"); },
  };

  const result = readProviderAccounts(modelRegistry(authStorage));
  assert.equal(reloaded, 1);
  assert.deepEqual(result.providers.find(({ id }) => id === "openai"), {
    id: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    supportsApiKey: true,
    canSignOut: true,
    status: "signed_in",
    source: "stored",
    label: "OAuth",
  });
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("settings manager creation preserves the public context trust boundary", () => {
  const calls = [];
  const SettingsManager = {
    create: (...args) => {
      calls.push(args);
      return { created: true };
    },
  };
  const ctx = { cwd: "/trusted/by-context", isProjectTrusted: () => false };

  assert.deepEqual(createContextSettingsManager(SettingsManager, ctx, "/agent"), { created: true });
  assert.deepEqual(calls, [[
    "/trusted/by-context",
    "/agent",
    { projectTrusted: false },
  ]]);
});

test("malformed auth storage is returned as a visible provider error", () => {
  const authStorage = {
    reload: () => {},
    drainErrors: () => [
      new Error("Unexpected token in auth.json"),
      new Error("Unexpected token in auth.json"),
    ],
    getOAuthProviders: () => [],
    list: () => [],
    has: () => false,
  };

  const result = readProviderAccounts(modelRegistry(authStorage));
  assert.deepEqual(result.errors, ["Unexpected token in auth.json"]);
  assert.equal(result.providers.every(({ status }) => status === "error"), true);
});

test("model scope changes only exact provider/id entries and preserves other patterns", async () => {
  const globalSettings = { enabledModels: ["openai/gpt-5", "anthropic/*", "retired/model"] };
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    setEnabledModels: (next) => { globalSettings.enabledModels = next; },
    flush: async () => {},
    drainErrors: () => [],
  };
  const registry = modelRegistry({});

  const initial = readEnabledModelScope(registry, settingsManager);
  assert.deepEqual(initial.preservedPatterns, ["anthropic/*", "retired/model"]);
  assert.equal(initial.models.find(({ ref }) => ref === "anthropic/claude").selected, false);

  const saved = await writeEnabledModelScope(registry, settingsManager, ["anthropic/claude"]);
  assert.deepEqual(globalSettings.enabledModels, ["anthropic/*", "retired/model", "anthropic/claude"]);
  assert.deepEqual(saved.preservedPatterns, ["anthropic/*", "retired/model"]);

  await assert.rejects(
    writeEnabledModelScope(registry, settingsManager, ["unknown/model"]),
    /Unknown model/,
  );
});

test("selecting every known model clears an unnecessary exact scope", async () => {
  const globalSettings = { enabledModels: ["openai/gpt-5"] };
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    setEnabledModels: (next) => { globalSettings.enabledModels = next; },
    flush: async () => {},
    drainErrors: () => [],
  };

  await writeEnabledModelScope(
    modelRegistry({}),
    settingsManager,
    ["openai/gpt-5", "anthropic/claude"],
  );
  assert.equal(globalSettings.enabledModels, undefined);
});

test("empty and project-overridden global scopes are rejected without writes", async () => {
  const globalSettings = { enabledModels: ["openai/gpt-5"] };
  const projectSettings = { enabledModels: ["anthropic/claude"] };
  let writes = 0;
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => projectSettings,
    setEnabledModels: () => { writes++; },
    flush: async () => {},
    drainErrors: () => [],
  };
  const registry = modelRegistry({});

  const scope = readEnabledModelScope(registry, settingsManager);
  assert.equal(scope.projectOverride, true);
  assert.deepEqual(scope.projectPatterns, ["anthropic/claude"]);
  assert.equal(scope.models.find(({ ref }) => ref === "openai/gpt-5").selected, true);
  assert.equal(scope.models.find(({ ref }) => ref === "anthropic/claude").selected, false);
  await assert.rejects(
    writeEnabledModelScope(registry, settingsManager, ["openai/gpt-5"]),
    /Project \.pi\/settings\.json overrides enabledModels/,
  );
  assert.equal(writes, 0);
  assert.deepEqual(globalSettings.enabledModels, ["openai/gpt-5"]);

  delete projectSettings.enabledModels;
  await assert.rejects(writeEnabledModelScope(registry, settingsManager, []), /Select at least one model/);
  assert.equal(writes, 0);

  globalSettings.enabledModels = ["anthropic/*"];
  const preservedOnly = await writeEnabledModelScope(registry, settingsManager, []);
  assert.deepEqual(preservedOnly.patterns, ["anthropic/*"]);
  assert.deepEqual(preservedOnly.preservedPatterns, ["anthropic/*"]);
  assert.equal(writes, 1);
});

test("real SettingsManager never promotes a project model override into global settings", (t) => {
  let executable;
  try {
    executable = execFileSync(process.platform === "win32" ? "where" : "which", ["pi"], {
      encoding: "utf8",
    }).split(/\r?\n/, 1)[0];
  } catch {
    t.skip("Pi runtime is not installed");
    return;
  }

  const piRoot = path.dirname(path.dirname(fs.realpathSync(executable)));
  const piPackageJson = path.join(piRoot, "package.json");
  if (!fs.existsSync(piPackageJson)) {
    t.skip("Pi package root is not available");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-real-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    enabledModels: ["openai/gpt-5"],
  }));
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
    enabledModels: ["anthropic/claude"],
  }));

  const packageName = JSON.parse(fs.readFileSync(piPackageJson, "utf8")).name;
  const serviceUrl = pathToFileURL(path.resolve("extensions/settings-parity.js")).href;
  const script = `
    import assert from "node:assert/strict";
    const { SettingsManager } = await import(${JSON.stringify(packageName)});
    const { readEnabledModelScope, writeEnabledModelScope } = await import(${JSON.stringify(serviceUrl)});
    const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: true });
    const registry = {
      getAll: () => [
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
        { provider: "anthropic", id: "claude", name: "Claude" },
      ],
      getProviderDisplayName: (provider) => provider,
    };
    const scope = readEnabledModelScope(registry, manager);
    assert.equal(scope.projectOverride, true);
    assert.equal(scope.models.find((model) => model.ref === "openai/gpt-5").selected, true);
    assert.equal(scope.models.find((model) => model.ref === "anthropic/claude").selected, false);
    await assert.rejects(
      writeEnabledModelScope(registry, manager, ["anthropic/claude"]),
      /Project \\.pi\\/settings\\.json overrides enabledModels/,
    );
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: piRoot,
    stdio: "pipe",
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).enabledModels,
    ["openai/gpt-5"],
  );
});

test("about info uses public package files and parses version sections", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-about-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), [
    "# Changelog",
    "",
    "## [2.0.0] - 2026-07-12",
    "",
    "### Added",
    "- New UI",
    "",
    "## [1.0.0] - 2026-01-01",
    "",
    "- First release",
  ].join("\n"));
  const tauPackage = path.join(root, "tau-package.json");
  fs.writeFileSync(tauPackage, JSON.stringify({ version: "0.1.1" }));

  assert.deepEqual(parseChangelog("## [1.2.3] - today\n\nDone"), [{
    version: "1.2.3",
    date: "today",
    body: "Done",
  }]);
  const about = readAboutInfo({
    piVersion: "2.0.0",
    piPackageDir: root,
    tauPackageJsonPath: tauPackage,
  });
  assert.equal(about.tauVersion, "0.1.1");
  assert.deepEqual(about.changelog.map(({ version }) => version), ["2.0.0", "1.0.0"]);
});
