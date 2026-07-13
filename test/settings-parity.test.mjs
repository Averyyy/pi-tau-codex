import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createContextSettingsManager,
  isModelInEffectiveScope,
  parseChangelog,
  readAboutInfo,
  readEnabledModelScope,
  readProviderAccounts,
  validateDefaultModelSelection,
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
    hasConfiguredAuth: (model) => model.provider === "openai",
    getProviderDisplayName: (id) => ({ openai: "OpenAI", anthropic: "Anthropic" })[id] || id,
    getProviderAuthStatus: (id) => ({
      configured: id === "openai",
      ...(id === "openai" ? { source: "stored", label: "OAuth" } : {}),
    }),
  };
}

async function resolveTestModelScope(patterns, registry) {
  assert.equal(patterns.length, 1);
  const pattern = patterns[0];
  const refs = {
    "openai/gpt-5": ["openai/gpt-5"],
    "openai/gpt-5:high": ["openai/gpt-5"],
    "openai/gpt-5:invalid": ["openai/gpt-5"],
    "openai/*": ["openai/gpt-5"],
    "anthropic/claude": ["anthropic/claude"],
    "anthropic/*": ["anthropic/claude"],
  }[pattern] || [];
  const available = registry.getAll().filter((model) => registry.hasConfiguredAuth(model));
  const scopedModels = refs.flatMap((ref) => {
    const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === ref);
    return model ? [{ model, ...(pattern.endsWith(":high") ? { thinkingLevel: "high" } : {}) }] : [];
  });
  const diagnostics = pattern.endsWith(":invalid")
    ? [{ type: "warning", message: `Invalid thinking level in ${pattern}`, pattern }]
    : scopedModels.length === 0
      ? [{ type: "warning", message: `No models match pattern ${pattern}`, pattern }]
      : [];
  return { scopedModels, diagnostics };
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

test("provider accounts distinguish environment availability from stored sign-in", () => {
  const authStorage = {
    reload: () => {},
    drainErrors: () => [],
    getOAuthProviders: () => [],
    list: () => [],
    has: () => false,
  };
  const registry = modelRegistry(authStorage);
  registry.hasConfiguredAuth = (model) => model.provider === "anthropic";
  registry.getProviderAuthStatus = (id) => id === "anthropic"
    ? { configured: true, source: "environment", label: "ANTHROPIC_API_KEY" }
    : { configured: false };

  const provider = readProviderAccounts(registry).providers.find(({ id }) => id === "anthropic");
  assert.deepEqual(provider, {
    id: "anthropic",
    name: "Anthropic",
    supportsOAuth: false,
    supportsApiKey: true,
    canSignOut: false,
    status: "available",
    source: "environment",
    label: "ANTHROPIC_API_KEY",
  });
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

test("model scope resolves wildcards and preserves only patterns with no available match", async () => {
  const globalSettings = { enabledModels: ["openai/gpt-5", "anthropic/*", "retired/model"] };
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    setEnabledModels: (next) => { globalSettings.enabledModels = next; },
    flush: async () => {},
    drainErrors: () => [],
  };
  const registry = modelRegistry({});
  registry.hasConfiguredAuth = () => true;

  const initial = await readEnabledModelScope(registry, settingsManager, resolveTestModelScope);
  assert.deepEqual(initial.preservedPatterns, ["retired/model"]);
  assert.equal(initial.models.find(({ ref }) => ref === "anthropic/claude").selected, true);

  const saved = await writeEnabledModelScope(
    registry,
    settingsManager,
    "selected",
    ["anthropic/claude"],
    resolveTestModelScope,
  );
  assert.deepEqual(globalSettings.enabledModels, ["retired/model", "anthropic/claude"]);
  assert.deepEqual(saved.preservedPatterns, ["retired/model"]);

  await assert.rejects(
    writeEnabledModelScope(
      registry,
      settingsManager,
      "selected",
      ["unknown/model"],
      resolveTestModelScope,
    ),
    /not available/,
  );
});

test("thinking suffixes use Pi diagnostics without becoming preserved matches", async () => {
  const globalSettings = {
    enabledModels: ["openai/gpt-5:high", "openai/gpt-5:invalid", "retired/model"],
  };
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    setEnabledModels: (next) => { globalSettings.enabledModels = next; },
    flush: async () => {},
    drainErrors: () => [],
  };
  const registry = modelRegistry({});

  const scope = await readEnabledModelScope(registry, settingsManager, resolveTestModelScope);
  assert.equal(scope.models.find(({ ref }) => ref === "openai/gpt-5").selected, true);
  assert.deepEqual(scope.preservedPatterns, ["retired/model"]);
  assert.deepEqual(scope.diagnostics.map(({ pattern }) => pattern), [
    "openai/gpt-5:invalid",
    "retired/model",
  ]);

  await writeEnabledModelScope(
    registry,
    settingsManager,
    "selected",
    ["openai/gpt-5"],
    resolveTestModelScope,
  );
  assert.deepEqual(globalSettings.enabledModels, ["retired/model", "openai/gpt-5"]);
});

test("all mode clears the exact scope while selecting every available model stays explicit", async () => {
  const globalSettings = { enabledModels: ["openai/gpt-5"] };
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    setEnabledModels: (next) => { globalSettings.enabledModels = next; },
    flush: async () => {},
    drainErrors: () => [],
  };

  const registry = modelRegistry({});
  registry.hasConfiguredAuth = () => true;
  await writeEnabledModelScope(
    registry,
    settingsManager,
    "selected",
    ["openai/gpt-5", "anthropic/claude"],
    resolveTestModelScope,
  );
  assert.deepEqual(globalSettings.enabledModels, ["openai/gpt-5", "anthropic/claude"]);

  await writeEnabledModelScope(registry, settingsManager, "all", [], resolveTestModelScope);
  assert.equal(globalSettings.enabledModels, undefined);
});

test("all mode lists only available models without marking them as exact selections", async () => {
  const settingsManager = {
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
    drainErrors: () => [],
  };

  const scope = await readEnabledModelScope(modelRegistry({}), settingsManager, resolveTestModelScope);
  assert.equal(scope.mode, "all");
  assert.deepEqual(scope.models.map(({ ref }) => ref), ["openai/gpt-5"]);
  assert.equal(scope.models.every(({ selected }) => selected === false), true);
});

test("unavailable exact models are preserved instead of presented as selectable", async () => {
  const globalSettings = { enabledModels: ["openai/gpt-5", "anthropic/claude"] };
  const settingsManager = {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    setEnabledModels: (next) => { globalSettings.enabledModels = next; },
    flush: async () => {},
    drainErrors: () => [],
  };
  const registry = modelRegistry({});

  const scope = await readEnabledModelScope(registry, settingsManager, resolveTestModelScope);
  assert.deepEqual(scope.models.map(({ ref }) => ref), ["openai/gpt-5"]);
  assert.deepEqual(scope.preservedPatterns, ["anthropic/claude"]);

  await writeEnabledModelScope(
    registry,
    settingsManager,
    "selected",
    ["openai/gpt-5"],
    resolveTestModelScope,
  );
  assert.deepEqual(globalSettings.enabledModels, ["anthropic/claude", "openai/gpt-5"]);
});

test("project override drives effective read scope while global entries remain available for explanation", async () => {
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
  registry.hasConfiguredAuth = () => true;

  const scope = await readEnabledModelScope(registry, settingsManager, resolveTestModelScope);
  assert.equal(scope.projectOverride, true);
  assert.equal(scope.mode, "selected");
  assert.deepEqual(scope.projectPatterns, ["anthropic/claude"]);
  assert.deepEqual(scope.patterns, ["openai/gpt-5"]);
  assert.deepEqual(scope.effectivePatterns, ["anthropic/claude"]);
  assert.equal(scope.models.find(({ ref }) => ref === "openai/gpt-5").selected, false);
  assert.equal(scope.models.find(({ ref }) => ref === "anthropic/claude").selected, true);
  await assert.rejects(
    writeEnabledModelScope(
      registry,
      settingsManager,
      "selected",
      ["openai/gpt-5"],
      resolveTestModelScope,
    ),
    /Project \.pi\/settings\.json overrides enabledModels/,
  );
  assert.equal(writes, 0);
  assert.deepEqual(globalSettings.enabledModels, ["openai/gpt-5"]);

  delete projectSettings.enabledModels;
  await assert.rejects(
    writeEnabledModelScope(registry, settingsManager, "selected", [], resolveTestModelScope),
    /Select at least one model/,
  );
  assert.equal(writes, 0);

  globalSettings.enabledModels = ["retired/*"];
  const preservedOnly = await writeEnabledModelScope(
    registry,
    settingsManager,
    "selected",
    [],
    resolveTestModelScope,
  );
  assert.deepEqual(preservedOnly.patterns, ["retired/*"]);
  assert.deepEqual(preservedOnly.preservedPatterns, ["retired/*"]);
  assert.equal(writes, 1);
});

test("effective model scope uses the injected Pi resolver", async () => {
  const registry = modelRegistry({});
  registry.hasConfiguredAuth = () => true;
  const settingsManager = { getEnabledModels: () => ["anthropic/*"] };
  const anthropic = registry.getAll().find(({ provider }) => provider === "anthropic");
  const openai = registry.getAll().find(({ provider }) => provider === "openai");

  assert.equal(await isModelInEffectiveScope(
    registry,
    settingsManager,
    anthropic,
    resolveTestModelScope,
  ), true);
  assert.equal(await isModelInEffectiveScope(
    registry,
    settingsManager,
    openai,
    resolveTestModelScope,
  ), false);
  assert.equal(await isModelInEffectiveScope(
    registry,
    { getEnabledModels: () => undefined },
    openai,
    resolveTestModelScope,
  ), true);
});

test("default model validation rejects authenticated models outside the project scope", async () => {
  const registry = modelRegistry({});
  registry.hasConfiguredAuth = () => true;
  const settingsManager = { getEnabledModels: () => ["anthropic/*"] };

  await assert.rejects(
    validateDefaultModelSelection(
      registry,
      settingsManager,
      "openai",
      "gpt-5",
      resolveTestModelScope,
    ),
    /outside the effective enabledModels scope/,
  );
  assert.equal(
    await validateDefaultModelSelection(
      registry,
      settingsManager,
      "anthropic",
      "claude",
      resolveTestModelScope,
    ),
    registry.getAll()[1],
  );
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
    const { SettingsManager, resolveModelScopeWithDiagnostics } = await import(${JSON.stringify(packageName)});
    const { isModelInEffectiveScope, readEnabledModelScope, writeEnabledModelScope } = await import(${JSON.stringify(serviceUrl)});
    const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: true });
    const registry = {
      getAll: () => [
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
        { provider: "anthropic", id: "claude", name: "Claude" },
      ],
      getAvailable: () => registry.getAll(),
      getProviderDisplayName: (provider) => provider,
      hasConfiguredAuth: () => true,
    };
    const scope = await readEnabledModelScope(registry, manager, resolveModelScopeWithDiagnostics);
    assert.equal(scope.projectOverride, true);
    assert.deepEqual(scope.patterns, ["openai/gpt-5"]);
    assert.deepEqual(scope.effectivePatterns, ["anthropic/claude"]);
    assert.equal(scope.models.find((model) => model.ref === "openai/gpt-5").selected, false);
    assert.equal(scope.models.find((model) => model.ref === "anthropic/claude").selected, true);
    assert.equal(await isModelInEffectiveScope(
      registry,
      manager,
      registry.getAll()[0],
      resolveModelScopeWithDiagnostics,
    ), false);
    assert.equal(await isModelInEffectiveScope(
      registry,
      manager,
      registry.getAll()[1],
      resolveModelScopeWithDiagnostics,
    ), true);
    await assert.rejects(
      writeEnabledModelScope(
        registry,
        manager,
        "selected",
        ["anthropic/claude"],
        resolveModelScopeWithDiagnostics,
      ),
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
