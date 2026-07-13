import assert from "node:assert/strict";
import test from "node:test";

import {
  createPackageMutationQueue,
  createPiPackageRuntime,
  listPiPackages,
  mutatePiPackage,
  readMcpCapability,
} from "../extensions/package-parity.js";

function settingsManager({ trusted = true, errors = [] } = {}) {
  return {
    drainErrors: () => errors.splice(0),
    flush: async () => {},
    isProjectTrusted: () => trusted,
  };
}

test("package runtime preserves cwd, agent dir, and project trust", () => {
  const calls = [];
  const SettingsManager = {
    create: (...args) => {
      calls.push(["settings", ...args]);
      return { settings: true };
    },
  };
  class DefaultPackageManager {
    constructor(options) {
      calls.push(["packages", options]);
    }
  }
  const ctx = { cwd: "/repo", isProjectTrusted: () => false };

  createPiPackageRuntime(DefaultPackageManager, SettingsManager, ctx, "/agent");

  assert.deepEqual(calls, [
    ["settings", "/repo", "/agent", { projectTrusted: false }],
    ["packages", { cwd: "/repo", agentDir: "/agent", settingsManager: { settings: true } }],
  ]);
});

test("package mutation queue serializes work and continues after failure", async () => {
  const run = createPackageMutationQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = run(async () => {
    events.push("first:start");
    await gate;
    events.push("first:end");
  });
  const second = run(async () => {
    events.push("second");
    throw new Error("expected");
  });
  const third = run(async () => { events.push("third"); });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  release();
  await first;
  await assert.rejects(second, /expected/);
  await third;
  assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
});

test("package list skips missing installs and returns structured resolved resources", async () => {
  const missingDecisions = [];
  const packageManager = {
    listConfiguredPackages: () => [
      { source: "npm:ready", scope: "user", filtered: false, installedPath: "/packages/ready" },
      { source: "npm:missing", scope: "project", filtered: true },
    ],
    resolve: async (onMissing) => {
      missingDecisions.push(await onMissing("npm:missing"));
      return {
        extensions: [{
          path: "/packages/ready/index.js",
          enabled: true,
          metadata: { source: "npm:ready", scope: "user", origin: "package", baseDir: "/packages/ready" },
        }],
        skills: [],
        prompts: [{
          path: "/repo/.pi/prompts/review.md",
          enabled: false,
          metadata: { source: "local", scope: "project", origin: "top-level" },
        }],
        themes: [],
      };
    },
  };

  const result = await listPiPackages(packageManager, settingsManager());

  assert.deepEqual(missingDecisions, ["skip"]);
  assert.deepEqual(result.packages, [
    {
      source: "npm:ready",
      scope: "global",
      filtered: false,
      missing: false,
      installedPath: "/packages/ready",
    },
    { source: "npm:missing", scope: "project", filtered: true, missing: true },
  ]);
  assert.deepEqual(result.resources.extensions[0], {
    path: "/packages/ready/index.js",
    enabled: true,
    source: "npm:ready",
    scope: "global",
    origin: "package",
    baseDir: "/packages/ready",
  });
  assert.equal(result.resources.prompts[0].scope, "project");
});

test("package mutations use Pi package APIs and always require reload", async () => {
  const calls = [];
  const packageManager = {
    listConfiguredPackages: () => [
      { source: "npm:global", scope: "user" },
      { source: "git:project", scope: "project" },
    ],
    installAndPersist: async (...args) => calls.push(["install", ...args]),
    removeAndPersist: async (...args) => {
      calls.push(["remove", ...args]);
      return true;
    },
    install: async (...args) => calls.push(["refresh", ...args]),
  };
  const settings = settingsManager();

  assert.deepEqual(
    await mutatePiPackage(packageManager, settings, "install", { source: " npm:new ", scope: "global" }),
    { source: "npm:new", scope: "global", reloadRequired: true },
  );
  assert.deepEqual(
    await mutatePiPackage(packageManager, settings, "remove", { source: "git:project", scope: "project" }),
    { source: "git:project", scope: "project", reloadRequired: true },
  );
  assert.deepEqual(
    await mutatePiPackage(packageManager, settings, "update", { source: "npm:global", scope: "global" }),
    { source: "npm:global", scope: "global", reloadRequired: true },
  );
  assert.deepEqual(calls, [
    ["install", "npm:new", { local: false }],
    ["remove", "git:project", { local: true }],
    ["refresh", "npm:global", { local: false }],
  ]);
});

test("package update refreshes only the requested configured scope", async () => {
  const calls = [];
  const packageManager = {
    listConfiguredPackages: () => [
      { source: "npm:shared", scope: "user" },
      { source: "npm:shared", scope: "project" },
    ],
    install: async (...args) => calls.push(["install", ...args]),
    update: () => assert.fail("scope-agnostic update must not be called"),
  };

  await mutatePiPackage(
    packageManager,
    settingsManager(),
    "update",
    { source: "npm:shared", scope: "project" },
  );

  assert.deepEqual(calls, [["install", "npm:shared", { local: true }]]);
});

test("package mutation validates scope, configured source, trust, and settings health", async () => {
  const untouched = {
    listConfiguredPackages: () => [],
    installAndPersist: () => assert.fail("must not install"),
  };

  await assert.rejects(
    mutatePiPackage(untouched, settingsManager(), "install", { source: "pkg", scope: "temporary" }),
    /scope must be/,
  );
  await assert.rejects(
    mutatePiPackage(untouched, settingsManager(), "install", { source: "x".repeat(4097), scope: "global" }),
    /4096 UTF-8 bytes/,
  );
  await assert.rejects(
    mutatePiPackage(untouched, settingsManager({ trusted: false }), "install", { source: "pkg", scope: "project" }),
    /Project is not trusted/,
  );
  await assert.rejects(
    mutatePiPackage(untouched, settingsManager({ errors: [{ scope: "global", error: new Error("bad JSON") }] }), "install", { source: "pkg", scope: "global" }),
    /settings are invalid: global: bad JSON/,
  );
  await assert.rejects(
    mutatePiPackage(untouched, settingsManager(), "remove", { source: "pkg", scope: "global" }),
    /not configured/,
  );
});

test("MCP capability reports the absent explicit adapter", () => {
  assert.deepEqual(readMcpCapability("0.80.6"), {
    available: false,
    reason: "Tau has no MCP adapter for Pi 0.80.6; MCP cannot be managed from the browser.",
  });
});
