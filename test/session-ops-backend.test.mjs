import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertCurrentSessionReference,
  branchSession,
  duplicateSession,
  forkSession,
  labelHistoricalSession,
  MAX_BROWSER_DRAFT_BYTES,
  normalizeBrowserDraft,
  normalizeEntryLabel,
  readSessionTree,
} from "../extensions/session-ops.js";
import { acquireSessionLaunchReservation } from "../extensions/session-launch-reservation.js";

const CURRENT_SESSION_VERSION = 3;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tau-session-ops-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeSession(directory, entries, version = CURRENT_SESSION_VERSION) {
  const sessionFile = path.join(directory, "source.jsonl");
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      type: "session",
      version,
      id: "session-1",
      timestamp: "2026-07-12T00:00:00.000Z",
      cwd: directory,
    }),
    ...entries.map(JSON.stringify),
  ].join("\n") + "\n");
  return fs.realpathSync(sessionFile);
}

function entry(type, id, parentId, extra = {}) {
  return {
    type,
    id,
    parentId,
    timestamp: `2026-07-12T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
    ...extra,
  };
}

function user(id, parentId, content) {
  return entry("message", id, parentId, { message: { role: "user", content } });
}

function assistant(id, parentId) {
  return entry("message", id, parentId, {
    message: { role: "assistant", content: [], provider: "openai", model: "gpt-5" },
  });
}

function createManager(sessionFile, options = {}) {
  const lines = fs.readFileSync(sessionFile, "utf8").trimEnd().split("\n").map(JSON.parse);
  const header = lines[0];
  const entries = lines.slice(1);
  const byId = new Map(entries.map((item) => [item.id, item]));
  const manager = {
    getSessionFile: () => sessionFile,
    getCwd: () => header.cwd,
    getSessionId: () => header.id,
    getSessionName: () => options.name,
    getHeader: () => header,
    getEntry: (id) => byId.get(id),
    getLeafId: () => options.leafId === undefined ? entries.at(-1)?.id ?? null : options.leafId,
    getBranch(id) {
      const branch = [];
      let current = id ? byId.get(id) : undefined;
      while (current) {
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return branch.reverse();
    },
    getTree: () => options.roots || entries.map((item) => ({ entry: item, children: [] })),
    createBranchedSession(id) {
      options.onBranch?.(id);
      const output = options.branchPath || path.join(path.dirname(sessionFile), `branch-${id}.jsonl`);
      if (options.persistBranch !== false) {
        fs.writeFileSync(output, `${JSON.stringify({ ...header, id: `branch-${id}` })}\n`);
      }
      if (options.changeSource) fs.appendFileSync(sessionFile, "{\"changed\":true}\n");
      return output;
    },
    appendLabelChange(id, label) {
      options.onLabel?.(id, label);
      fs.appendFileSync(sessionFile, `${JSON.stringify({
        type: "label",
        id: "label-1",
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-07-12T00:01:00.000Z",
        targetId: id,
        label,
      })}\n`);
    },
  };
  return manager;
}

function operationOptions(t, sessionFile, SessionManager, overrides = {}) {
  const instancesDir = path.join(path.dirname(sessionFile), "instances");
  return {
    SessionManager,
    sessionFile,
    liveSessionManager: undefined,
    currentSessionFile: null,
    currentSessionVersion: CURRENT_SESSION_VERSION,
    getRunningInstances: () => [],
    instancesDir,
    resolveSessionFile: (candidate) => fs.realpathSync(candidate),
    ...overrides,
  };
}

test("tree uses Pi's raw live tree and rejects a different active writer", (t) => {
  const directory = temporaryDirectory(t);
  const sessionFile = writeSession(directory, [user("user-1", null, "Hello")]);
  const roots = [{ entry: { id: "orphan", parentId: "missing" }, children: [], label: "Keep" }];
  const live = createManager(sessionFile, { roots, name: "Named" });
  const options = {
    SessionManager: { open: () => assert.fail("current tree must reuse the live manager") },
    sessionFile,
    liveSessionManager: live,
    currentSessionVersion: CURRENT_SESSION_VERSION,
    getRunningInstances: () => [{ pid: process.pid, sessionFile, port: 3001 }],
    resolveSessionFile: (candidate) => fs.realpathSync(candidate),
  };

  const result = readSessionTree(options);
  assert.equal(result.sessionFile, sessionFile);
  assert.equal(result.leafId, "user-1");
  assert.deepEqual(result.activePath, ["user-1"]);
  assert.equal(result.roots, roots);

  assert.throws(
    () => readSessionTree({
      ...options,
      getRunningInstances: () => [{ pid: process.pid + 1, sessionFile, port: 4111 }],
    }),
    (error) => error.status === 409 && error.ownerPort === 4111,
  );
});

test("fork and duplicate branch a fresh snapshot without changing the live manager or source", (t) => {
  const directory = temporaryDirectory(t);
  const entries = [
    entry("model_change", "model", null),
    user("user-1", "model", "Hello"),
    assistant("assistant-1", "user-1"),
    user("user-2", "assistant-1", [
      { type: "text", text: "Again" },
      { type: "image", data: "ignored" },
      { type: "text", text: " exactly" },
    ]),
  ];
  const sessionFile = writeSession(directory, entries);
  const before = fs.readFileSync(sessionFile);
  const branchTargets = [];
  const SessionManager = {
    open: () => createManager(sessionFile, { onBranch: (id) => branchTargets.push(id) }),
  };
  const live = {
    getSessionFile: () => sessionFile,
    createBranchedSession: () => assert.fail("branching must not mutate the live manager"),
  };
  const base = operationOptions(t, sessionFile, SessionManager, {
    liveSessionManager: live,
    currentSessionFile: sessionFile,
    getRunningInstances: () => [{ pid: process.pid, sessionFile, port: 3001 }],
  });

  const fork = forkSession({ ...base, entryId: "user-2" });
  assert.equal(fork.kind, "session");
  assert.equal(fork.draft, "Again exactly");
  assert.equal(fork.cwd, directory);
  assert.equal(fs.statSync(fork.sessionFile).isFile(), true);
  assert.equal(fs.readFileSync(sessionFile).equals(before), true);
  assert.equal(branchTargets[0], "assistant-1");

  const duplicate = duplicateSession(base);
  assert.equal(duplicate.kind, "session");
  assert.equal(branchTargets[1], "user-2");
  assert.equal(fs.readFileSync(sessionFile).equals(before), true);
  assert.deepEqual(fs.readdirSync(base.instancesDir), []);
});

test("a first-user fork becomes a new task; missing duplicate and branch files are rejected", (t) => {
  const directory = temporaryDirectory(t);
  const rootSession = writeSession(directory, [
    user("user-root", null, "Root prompt"),
    assistant("assistant-root", "user-root"),
  ]);
  const rootManager = createManager(rootSession, {
    onBranch: () => assert.fail("a root fork must not call createBranchedSession"),
  });
  assert.deepEqual(forkSession({
    ...operationOptions(t, rootSession, { open: () => rootManager }),
    entryId: "user-root",
  }), {
    kind: "new-task",
    cwd: directory,
    draft: "Root prompt",
  });

  const nestedDirectory = path.join(directory, "nested");
  fs.mkdirSync(nestedDirectory);
  const sessionFile = writeSession(nestedDirectory, [
    entry("model_change", "model", null),
    user("user-1", "model", "First prompt"),
  ]);
  const manager = createManager(sessionFile, { persistBranch: false });
  const options = operationOptions(t, sessionFile, { open: () => manager });
  assert.deepEqual(forkSession({ ...options, entryId: "user-1" }), {
    kind: "new-task",
    cwd: nestedDirectory,
    draft: "First prompt",
  });
  assert.throws(
    () => duplicateSession(options),
    (error) => error.status === 409 && /assistant response/.test(error.message),
  );
  assert.throws(
    () => branchSession({ ...options, entryId: "user-1" }),
    (error) => error.status === 409 && /assistant response/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(nestedDirectory, "branch-user-1.jsonl")), false);
});

test("an unpersisted live root fork is exact and never opens or mutates the manager", (t) => {
  const directory = temporaryDirectory(t);
  const missingSession = path.join(directory, "not-yet-persisted.jsonl");
  const root = user("user-root", null, "Draft me");
  const nested = user("user-nested", "model", "Cannot lose base history");
  const live = {
    getSessionFile: () => missingSession,
    getCwd: () => directory,
    getEntry: (id) => ({ "user-root": root, "user-nested": nested }[id]),
    createBranchedSession: () => assert.fail("the live manager must not be mutated"),
  };
  const options = operationOptions(t, missingSession, {
    open: () => assert.fail("an unpersisted session cannot be opened"),
  }, {
    liveSessionManager: live,
    currentSessionFile: missingSession,
  });

  assert.deepEqual(forkSession({ ...options, entryId: "user-root" }), {
    kind: "new-task",
    cwd: directory,
    draft: "Draft me",
  });
  live.getEntry = (id) => ({
    "user-root": root,
    "user-nested": nested,
    model: entry("model_change", "model", null),
  }[id]);
  live.getBranch = (id) => id === "model" ? [live.getEntry("model")] : [];
  assert.deepEqual(forkSession({ ...options, entryId: "user-nested" }), {
    kind: "new-task",
    cwd: directory,
    draft: "Cannot lose base history",
  });
  assert.throws(() => duplicateSession(options), (error) => error.status === 409);
});

test("a source race removes only the newly created branch", (t) => {
  const directory = temporaryDirectory(t);
  const sessionFile = writeSession(directory, [
    user("user-1", null, "Hello"),
    assistant("assistant-1", "user-1"),
  ]);
  const branchPath = path.join(directory, "created-branch.jsonl");
  const manager = createManager(sessionFile, { branchPath, changeSource: true });

  assert.throws(
    () => branchSession({
      ...operationOptions(t, sessionFile, { open: () => manager }),
      entryId: "assistant-1",
    }),
    (error) => error.status === 409 && /changed while branching/.test(error.message) && !/cleanup failed/.test(error.message),
  );
  assert.equal(fs.existsSync(branchPath), false);
  assert.equal(fs.existsSync(sessionFile), true);
});

test("historical labels are reserved append-only writes and active labels stay on WS", (t) => {
  const directory = temporaryDirectory(t);
  const sessionFile = writeSession(directory, [user("user-1", null, "Hello"), assistant("assistant-1", "user-1")]);
  const instancesDir = path.join(directory, "instances");
  const labels = [];
  const SessionManager = {
    open: () => createManager(sessionFile, { onLabel: (...args) => labels.push(args) }),
  };
  const options = operationOptions(t, sessionFile, SessionManager, { instancesDir });
  const before = fs.readFileSync(sessionFile);

  assert.deepEqual(labelHistoricalSession({
    ...options,
    entryId: "user-1",
    label: "  Important  ",
  }), { entryId: "user-1", label: "Important" });
  assert.equal(fs.readFileSync(sessionFile).subarray(0, before.length).equals(before), true);
  assert.deepEqual(labels, [["user-1", "Important"]]);

  assert.throws(
    () => labelHistoricalSession({
      ...options,
      entryId: "user-1",
      label: null,
      currentSessionFile: sessionFile,
    }),
    (error) => error.status === 409 && /active/.test(error.message),
  );

  const held = acquireSessionLaunchReservation(instancesDir, {
    launchId: "held",
    ownerPid: process.pid,
    sessionFile,
  });
  assert.throws(
    () => labelHistoricalSession({ ...options, entryId: "user-1", label: "Busy" }),
    (error) => error.status === 409 && /busy/.test(error.message),
  );
  held.release();
});

test("active labels reject stale sessions and launch drafts have an exact byte bound", (t) => {
  const directory = temporaryDirectory(t);
  const current = writeSession(directory, [user("user-1", null, "Hello")]);
  const otherDirectory = path.join(directory, "other");
  fs.mkdirSync(otherDirectory);
  const other = writeSession(otherDirectory, [user("user-2", null, "Other")]);
  const resolve = (candidate) => fs.realpathSync(candidate);

  assert.doesNotThrow(() => assertCurrentSessionReference(current, current, resolve));
  assert.throws(
    () => assertCurrentSessionReference(other, current, resolve),
    (error) => error.status === 409 && /changed/.test(error.message),
  );
  assert.equal(normalizeEntryLabel("  label  "), "label");
  assert.equal(normalizeEntryLabel("  "), undefined);
  assert.equal(normalizeBrowserDraft("x".repeat(MAX_BROWSER_DRAFT_BYTES)), "x".repeat(MAX_BROWSER_DRAFT_BYTES));
  assert.throws(
    () => normalizeBrowserDraft("x".repeat(MAX_BROWSER_DRAFT_BYTES + 1)),
    (error) => error.status === 413,
  );
});

test("real Pi SessionManager preserves branch, tree, and label semantics", (t) => {
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
  const packageJson = path.join(piRoot, "package.json");
  if (!fs.existsSync(packageJson)) {
    t.skip("Pi package root is not available");
    return;
  }

  const directory = temporaryDirectory(t);
  const packageName = JSON.parse(fs.readFileSync(packageJson, "utf8")).name;
  const operationsUrl = pathToFileURL(path.resolve("extensions/session-ops.js")).href;
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { CURRENT_SESSION_VERSION, SessionManager } from ${JSON.stringify(packageName)};
    import {
      branchSession,
      duplicateSession,
      forkSession,
      labelHistoricalSession,
      readSessionTree,
    } from ${JSON.stringify(operationsUrl)};

    const root = ${JSON.stringify(directory)};
    const cwd = path.join(root, "project");
    const sessions = path.join(root, "sessions");
    const instancesDir = path.join(root, "instances");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const resolveSessionFile = (candidate) => fs.realpathSync(candidate);
    const common = (sessionFile) => ({
      SessionManager,
      sessionFile,
      currentSessionFile: null,
      currentSessionVersion: CURRENT_SESSION_VERSION,
      getRunningInstances: () => [],
      instancesDir,
      resolveSessionFile,
    });

    const manager = SessionManager.create(cwd, sessions);
    manager.appendModelChange("openai", "gpt-5");
    manager.appendThinkingLevelChange("high");
    const firstUser = manager.appendMessage({
      role: "user",
      content: "First",
      timestamp: Date.now(),
    });
    const firstAssistant = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const editedUser = manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Edit" },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: " me" },
      ],
      timestamp: Date.now(),
    });
    const originalManagerFile = manager.getSessionFile();
    const sourceFile = fs.realpathSync(originalManagerFile);
    const sourceBytes = fs.readFileSync(sourceFile);

    const fork = forkSession({ ...common(sourceFile), entryId: editedUser });
    assert.equal(fork.kind, "session");
    assert.equal(fork.draft, "Edit me");
    assert.equal(fs.readFileSync(sourceFile).equals(sourceBytes), true);
    assert.equal(manager.getSessionFile(), originalManagerFile);
    const forkManager = SessionManager.open(fork.sessionFile);
    assert.equal(forkManager.getLeafId(), firstAssistant);
    assert.equal(forkManager.getHeader().parentSession, sourceFile);

    const duplicate = duplicateSession(common(sourceFile));
    assert.equal(duplicate.kind, "session");
    assert.equal(SessionManager.open(duplicate.sessionFile).getHeader().parentSession, sourceFile);
    assert.equal(fs.readFileSync(sourceFile).equals(sourceBytes), true);

    const opened = branchSession({ ...common(sourceFile), entryId: firstAssistant });
    assert.equal(SessionManager.open(opened.sessionFile).getLeafId(), firstAssistant);

    const fresh = SessionManager.create(cwd, path.join(root, "fresh-sessions"));
    fresh.appendModelChange("openai", "gpt-5");
    fresh.appendThinkingLevelChange("high");
    const rootUser = fresh.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Root" }, { type: "text", text: " draft" }],
      timestamp: Date.now(),
    });
    const freshFile = fresh.getSessionFile();
    assert.equal(fs.existsSync(freshFile), false);
    assert.deepEqual(forkSession({
      ...common(freshFile),
      liveSessionManager: fresh,
      currentSessionFile: freshFile,
      entryId: rootUser,
    }), { kind: "new-task", cwd, draft: "Root draft" });
    assert.equal(fs.existsSync(freshFile), false);

    const treeFile = path.join(sessions, "tree.jsonl");
    fs.writeFileSync(treeFile, [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "tree-session",
        timestamp: "2026-07-12T00:00:00.000Z",
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-07-12T00:00:01.000Z",
        message: { role: "user", content: "Root" },
      }),
      JSON.stringify({
        type: "custom",
        id: "later",
        parentId: "root",
        timestamp: "2026-07-12T00:00:03.000Z",
        customType: "test",
      }),
      JSON.stringify({
        type: "custom",
        id: "earlier",
        parentId: "root",
        timestamp: "2026-07-12T00:00:02.000Z",
        customType: "test",
      }),
      JSON.stringify({
        type: "custom",
        id: "orphan",
        parentId: "missing",
        timestamp: "2026-07-12T00:00:04.000Z",
        customType: "test",
      }),
      JSON.stringify({
        type: "label",
        id: "label",
        parentId: "orphan",
        timestamp: "2026-07-12T00:00:05.000Z",
        targetId: "root",
        label: "Marked",
      }),
    ].join("\\n") + "\\n");
    const canonicalTreeFile = fs.realpathSync(treeFile);
    const tree = readSessionTree({
      SessionManager,
      sessionFile: canonicalTreeFile,
      currentSessionVersion: CURRENT_SESSION_VERSION,
      getRunningInstances: () => [],
      resolveSessionFile,
    });
    assert.deepEqual(tree.roots.map((node) => node.entry.id), ["root", "orphan"]);
    assert.deepEqual(tree.roots[0].children.map((node) => node.entry.id), ["earlier", "later"]);
    assert.equal(tree.roots[0].label, "Marked");
    assert.deepEqual(tree.activePath, ["orphan", "label"]);

    const beforeLabel = fs.readFileSync(sourceFile);
    assert.deepEqual(labelHistoricalSession({
      ...common(sourceFile),
      entryId: firstUser,
      label: "  Real label  ",
    }), { entryId: firstUser, label: "Real label" });
    assert.equal(fs.readFileSync(sourceFile).subarray(0, beforeLabel.length).equals(beforeLabel), true);
    assert.equal(SessionManager.open(sourceFile).getLabel(firstUser), "Real label");
    assert.throws(
      () => labelHistoricalSession({
        ...common(sourceFile),
        currentSessionFile: sourceFile,
        entryId: firstUser,
        label: null,
      }),
      (error) => error.status === 409,
    );
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: piRoot,
    stdio: "pipe",
  });
});
