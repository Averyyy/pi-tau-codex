import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  inspectSessionImport,
  installSessionImport,
  MAX_SESSION_IMPORT_BYTES,
} from "../extensions/session-import.js";

const VERSION = 3;
const execFileAsync = promisify(execFile);
const mirrorSource = fs.readFileSync(new URL("../extensions/mirror-server.ts", import.meta.url), "utf8");

function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tau-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function body(cwd, changes = {}) {
  const values = [
    { type: "session", version: VERSION, id: "session-1", timestamp: "2026-07-12T00:00:00.000Z", cwd },
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-07-12T00:00:01.000Z", message: { role: "user", content: "Hi" } },
    { type: "custom", id: "custom-1", parentId: "user-1", timestamp: "2026-07-12T00:00:02.000Z", customType: "qa", data: { exact: true } },
    { type: "label", id: "label-1", parentId: "custom-1", timestamp: "2026-07-12T00:00:03.000Z", targetId: "user-1", label: "Keep" },
  ];
  Object.assign(values[0], changes.header);
  if (changes.entries) values.splice(1, values.length - 1, ...changes.entries);
  return Buffer.from(values.map(JSON.stringify).join("\n") + "\n");
}

function manager(storageRoot) {
  return {
    inMemory(_cwd, { id }) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw new Error("bad id");
    },
    create(cwd, sessionDir, { id }) {
      const directory = sessionDir || path.join(storageRoot, "project");
      fs.mkdirSync(directory, { recursive: true });
      return {
        getSessionDir: () => directory,
        getSessionFile: () => path.join(directory, `generated_${id}.jsonl`),
        getCwd: () => cwd,
      };
    },
  };
}

function installStorage(storageRoot) {
  return { storageRoot, instancesDir: path.join(storageRoot, "instances") };
}

test("inspect fully validates without writing and requests a project for a missing cwd", (t) => {
  const storage = root(t);
  const source = Buffer.concat([Buffer.from("\n\n"), body(path.join(storage, "missing"))]);
  const before = fs.readdirSync(storage);
  assert.deepEqual(inspectSessionImport({ body: source, SessionManager: manager(storage), currentSessionVersion: VERSION }), {
    sessionFile: null,
    cwd: path.join(storage, "missing"),
    id: "session-1",
    entryCount: 3,
    requiresProject: true,
  });
  assert.deepEqual(fs.readdirSync(storage), before);
});

test("validation rejects malformed objects, headers, topology, labels, timestamps, ids, and size", (t) => {
  const directory = root(t);
  const SessionManager = manager(directory);
  const common = { SessionManager, currentSessionVersion: VERSION };
  const invalid = [
    Buffer.from('{"type":"session"}\nnope\n'),
    Buffer.from('[]\n'),
    body(directory, { header: { version: 2 } }),
    body(directory, { header: { id: "../bad" } }),
    body(directory, { header: { timestamp: "today" } }),
    body(directory, { entries: [
      { type: "custom", id: "same", parentId: null, timestamp: "2026-07-12T00:00:01.000Z" },
      { type: "custom", id: "same", parentId: null, timestamp: "2026-07-12T00:00:02.000Z" },
    ] }),
    body(directory, { entries: [{ type: "custom", id: "orphan", parentId: "missing", timestamp: "2026-07-12T00:00:01.000Z" }] }),
    body(directory, { entries: [
      { type: "custom", id: "a", parentId: "b", timestamp: "2026-07-12T00:00:01.000Z" },
      { type: "custom", id: "b", parentId: "a", timestamp: "2026-07-12T00:00:02.000Z" },
    ] }),
    body(directory, { entries: [{ type: "label", id: "label", parentId: null, timestamp: "2026-07-12T00:00:01.000Z", targetId: "missing" }] }),
  ];
  for (const value of invalid) assert.throws(() => inspectSessionImport({ ...common, body: value }));
  assert.throws(
    () => inspectSessionImport({ ...common, body: Buffer.alloc(MAX_SESSION_IMPORT_BYTES + 1) }),
    (error) => error.status === 413 && error.code === "INVALID_SESSION_IMPORT",
  );
});

test("header-only and multi-root sessions preserve Pi resetLeaf semantics", (t) => {
  const directory = root(t);
  assert.deepEqual(inspectSessionImport({
    body: body(directory, { entries: [] }),
    SessionManager: manager(directory),
    currentSessionVersion: VERSION,
  }), {
    sessionFile: null,
    cwd: directory,
    id: "session-1",
    entryCount: 0,
    requiresProject: false,
  });
  assert.equal(inspectSessionImport({
    body: body(directory, { entries: [
      { type: "custom", id: "root-a", parentId: null, timestamp: "2026-07-12T00:00:01.000Z" },
      { type: "custom", id: "root-b", parentId: null, timestamp: "2026-07-12T00:00:02.000Z" },
    ] }),
    SessionManager: manager(directory),
    currentSessionVersion: VERSION,
  }).entryCount, 2);
});

test("install rewrites only a missing cwd header, preserves entries, and rejects collisions", (t) => {
  const storage = root(t);
  const project = path.join(storage, "target");
  fs.mkdirSync(project);
  const SessionManager = manager(storage);
  const source = Buffer.concat([Buffer.from("\n\n"), body(path.join(storage, "missing"))]);
  const sourceBefore = Buffer.from(source);
  const result = installSessionImport({
    body: source,
    SessionManager,
    currentSessionVersion: VERSION,
    projectPath: project,
    ...installStorage(storage),
  });
  const installed = fs.readFileSync(result.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(fs.readFileSync(result.sessionFile, "utf8").startsWith('{"type":"session"'), true);
  assert.equal(installed[0].cwd, project);
  assert.deepEqual(installed.slice(1), source.toString().trim().split("\n").slice(1).map(JSON.parse));
  assert.equal(source.equals(sourceBefore), true);
  assert.deepEqual(fs.readdirSync(path.dirname(result.sessionFile)), [path.basename(result.sessionFile)]);
  assert.throws(
    () => installSessionImport({
      body: source,
      SessionManager,
      currentSessionVersion: VERSION,
      projectPath: project,
      ...installStorage(storage),
    }),
    (error) => error.status === 409 && error.code === "SESSION_COLLISION",
  );
});

test("target collision leaves the existing file and no temporary import", (t) => {
  const storage = root(t);
  const project = path.join(storage, "project");
  fs.mkdirSync(project);
  const SessionManager = manager(storage);
  const target = path.join(storage, "project", "2026-07-12T00-00-00-000Z_session-1.jsonl");
  fs.writeFileSync(target, "occupied");
  assert.throws(
    () => installSessionImport({
      body: body(project),
      SessionManager,
      currentSessionVersion: VERSION,
      ...installStorage(storage),
    }),
    (error) => error.status === 409 && error.code === "SESSION_COLLISION",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "occupied");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
});

test("collision scans do not read a large stored session past its header", (t) => {
  const storage = root(t);
  const project = path.join(storage, "project");
  fs.mkdirSync(project);
  const existing = path.join(storage, "large.jsonl");
  fs.writeFileSync(existing, `${JSON.stringify({
    type: "session",
    version: VERSION,
    id: "large-existing",
    timestamp: "2026-07-12T00:00:00.000Z",
    cwd: project,
  })}\n`);
  fs.truncateSync(existing, 128 * 1024 * 1024);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSync(file, ...args) {
    if (path.resolve(file) === existing) throw new Error("large session was read in full");
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    const result = installSessionImport({
      body: body(project, { header: { id: "large-new" } }),
      SessionManager: manager(storage),
      currentSessionVersion: VERSION,
      ...installStorage(storage),
    });
    assert.equal(fs.existsSync(result.sessionFile), true);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("a corrupt stored session header fails with a typed storage error", (t) => {
  const storage = root(t);
  const project = path.join(storage, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(storage, "corrupt.jsonl"), '{"type":"session"\n');
  assert.throws(
    () => installSessionImport({
      body: body(project, { header: { id: "new-session" } }),
      SessionManager: manager(storage),
      currentSessionVersion: VERSION,
      ...installStorage(storage),
    }),
    (error) => error.status === 500 && error.code === "SESSION_STORAGE_CORRUPT",
  );
});

test("the route never treats an opened file directory as configured session storage", () => {
  const route = mirrorSource.slice(
    mirrorSource.indexOf("const importMatch"),
    mirrorSource.indexOf('if (urlPath === "/api/share/capability"'),
  );
  assert.match(mirrorSource, /const CONFIGURED_SESSION_DIR = process\.env\.PI_CODING_AGENT_SESSION_DIR \? SESSIONS_DIR : undefined/);
  assert.match(route, /sessionDir: CONFIGURED_SESSION_DIR/);
  assert.doesNotMatch(route, /latestCtx|getSessionDir|usesDefaultSessionDir/);
});

test("real Pi leaves one winner when the same id is concurrently imported into different cwd targets", async (t) => {
  let executable;
  try {
    executable = execFileSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" })
      .split(/\r?\n/, 1)[0];
  } catch {
    t.skip("Pi runtime is not installed");
    return;
  }
  const piRoot = path.dirname(path.dirname(fs.realpathSync(executable)));
  const packageJson = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
  const directory = root(t);
  const projects = [path.join(directory, "project-a"), path.join(directory, "project-b")];
  for (const project of projects) fs.mkdirSync(project);
  const agentDir = path.join(directory, "agent");
  const storageRoot = path.join(agentDir, "sessions");
  const instancesDir = path.join(directory, "instances");
  const importUrl = pathToFileURL(path.resolve("extensions/session-import.js")).href;
  const sources = projects.map((project) => body(project).toString("base64"));
  const script = `
    import path from "node:path";
    import { SessionManager, CURRENT_SESSION_VERSION } from ${JSON.stringify(packageJson.name)};
    import { installSessionImport } from ${JSON.stringify(importUrl)};
    const body = Buffer.from(process.argv[1], "base64");
    const cwd = JSON.parse(body.toString("utf8").split("\\n", 1)[0]).cwd;
    try {
      const result = installSessionImport({
        body,
        SessionManager,
        currentSessionVersion: CURRENT_SESSION_VERSION,
        storageRoot: ${JSON.stringify(storageRoot)},
        instancesDir: ${JSON.stringify(instancesDir)},
      });
      const opened = SessionManager.open(result.sessionFile);
      if (opened.getSessionId() !== "session-1" || opened.getEntries().at(-1)?.type !== "label") throw new Error("bad import");
      const listed = await SessionManager.list(cwd, path.dirname(result.sessionFile));
      if (!listed.some((entry) => entry.path === result.sessionFile)) throw new Error("not listed");
      process.stdout.write(JSON.stringify({ status: "installed", result }));
    } catch (error) {
      if (error?.code !== "SESSION_COLLISION") throw error;
      process.stdout.write(JSON.stringify({ status: "collision" }));
    }
  `;
  const options = {
    cwd: piRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
  };
  const results = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, sources[0]], options),
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, sources[1]], options),
  ]);
  const statuses = results.map((result) => JSON.parse(result.stdout).status).sort();
  assert.deepEqual(statuses, ["collision", "installed"]);
  const sessionFiles = fs.readdirSync(storageRoot, { recursive: true })
    .filter((file) => file.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 1);
  assert.deepEqual(fs.readdirSync(instancesDir), []);
});
