import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  normalizeSessionName,
  readSessionActionBody,
  readSessionInfo,
  renameHistoricalSession,
  sendSessionExport,
} from "../extensions/session-actions.js";
import { acquireSessionLaunchReservation } from "../extensions/session-launch-reservation.js";

const CURRENT_SESSION_VERSION = 3;

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeSession(directory, version = CURRENT_SESSION_VERSION) {
  const sessionFile = path.join(directory, "session.jsonl");
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      type: "session",
      version,
      id: "session-1",
      timestamp: "2026-07-12T00:00:00.000Z",
      cwd: directory,
    }),
    JSON.stringify({
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-12T00:00:01.000Z",
      message: { role: "user", content: "Hello" },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-12T00:00:02.000Z",
      message: { role: "assistant", content: [], provider: "openai", model: "gpt-5" },
    }),
  ].join("\n") + "\n");
  return fs.realpathSync(sessionFile);
}

function fakeSessionManager() {
  return {
    open(sessionFile) {
      let name;
      return {
        appendSessionInfo(nextName) {
          name = nextName;
          fs.appendFileSync(sessionFile, `${JSON.stringify({
            type: "session_info",
            id: "info-1",
            parentId: "assistant-1",
            timestamp: "2026-07-12T00:00:03.000Z",
            name: nextName,
          })}\n`);
        },
        getSessionName: () => name,
      };
    },
  };
}

function renameOptions(sessionFile, instancesDir, overrides = {}) {
  return {
    SessionManager: fakeSessionManager(),
    sessionFile,
    name: "  Renamed  ",
    currentSessionFile: null,
    getRunningInstances: () => [],
    instancesDir,
    resolveSessionFile: (candidate) => fs.realpathSync(candidate),
    currentSessionVersion: CURRENT_SESSION_VERSION,
    ...overrides,
  };
}

test("historical rename is append-only and rejects active or reserved writers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-rename-"));
  try {
    const sessionFile = writeSession(root);
    const instancesDir = path.join(root, "instances");
    const before = fs.readFileSync(sessionFile);
    assert.deepEqual(renameHistoricalSession(renameOptions(sessionFile, instancesDir)), { name: "Renamed" });
    const after = fs.readFileSync(sessionFile);
    assert.equal(after.subarray(0, before.length).equals(before), true);
    assert.match(after.subarray(before.length).toString(), /"type":"session_info"/);
    assert.deepEqual(fs.readdirSync(instancesDir), []);

    const symlink = path.join(root, "active-link.jsonl");
    fs.symlinkSync(sessionFile, symlink);
    const unchanged = fs.readFileSync(sessionFile);
    assert.throws(
      () => renameHistoricalSession(renameOptions(sessionFile, instancesDir, {
        getRunningInstances: () => [
          { sessionFile: path.join(root, "deleted.jsonl"), port: 4000 },
          { sessionFile: symlink, port: 4111 },
        ],
      })),
      (error) => error.status === 409 && error.ownerPort === 4111,
    );
    assert.equal(fs.readFileSync(sessionFile).equals(unchanged), true);

    const held = acquireSessionLaunchReservation(instancesDir, {
      launchId: "held",
      ownerPid: process.pid,
      sessionFile,
    });
    assert.throws(
      () => renameHistoricalSession(renameOptions(sessionFile, instancesDir)),
      (error) => error.status === 409 && /busy/.test(error.message),
    );
    held.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rename and historical info reject old versions without changing bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-version-"));
  try {
    const sessionFile = writeSession(root, 2);
    const before = fs.readFileSync(sessionFile);
    const SessionManager = { open: () => assert.fail("old sessions must not be opened") };
    assert.throws(
      () => renameHistoricalSession(renameOptions(sessionFile, path.join(root, "instances"), { SessionManager })),
      (error) => error.status === 409 && /migrated by Pi/.test(error.message),
    );
    assert.throws(
      () => readSessionInfo({ SessionManager, sessionFile, currentSessionVersion: CURRENT_SESSION_VERSION }),
      (error) => error.status === 409 && /migrated by Pi/.test(error.message),
    );
    assert.equal(fs.readFileSync(sessionFile).equals(before), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session names reject empty, control, and overlong values", () => {
  assert.equal(normalizeSessionName("  Useful name  "), "Useful name");
  assert.throws(() => normalizeSessionName(" "), /cannot be empty/);
  assert.throws(() => normalizeSessionName("line\nbreak"), /control characters/);
  assert.throws(() => normalizeSessionName("x".repeat(201)), /200 characters/);
});

test("session action bodies are small strict JSON objects", async () => {
  const valid = new PassThrough();
  const parsed = readSessionActionBody(valid, ["name"]);
  valid.end('{"name":"Renamed"}');
  assert.deepEqual(await parsed, { name: "Renamed" });

  const extra = new PassThrough();
  const rejectedExtra = readSessionActionBody(extra, ["name"]);
  extra.end('{"name":"Renamed","outputPath":"/tmp/file"}');
  await assert.rejects(rejectedExtra, /Unsupported request field: outputPath/);

  const large = new PassThrough();
  const rejectedLarge = readSessionActionBody(large, ["name"]);
  large.end(JSON.stringify({ name: "x".repeat(17 * 1024) }));
  await assert.rejects(rejectedLarge, (error) => error.status === 413);
});

test("historical session info matches the flat live stats contract", (t) => {
  const entries = [
    { type: "message", message: { role: "user", content: "Hi" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall" }],
        usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: { total: 0.25 } },
      },
    },
    { type: "message", message: { role: "toolResult", content: [] } },
  ];
  const root = temporaryDirectory(t, "tau-info-");
  const sessionFile = writeSession(root);
  const manager = {
    getSessionFile: () => sessionFile,
    buildSessionContext: () => ({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "high",
    }),
    getHeader: () => ({ parentSession: "/sessions/parent.jsonl" }),
    getSessionId: () => "session-1",
    getCwd: () => "/project",
    getSessionName: () => "Named",
    getEntries: () => entries,
    getTree: () => [{ children: [{ children: [] }, { children: [] }] }],
  };
  const SessionManager = { open: () => manager };
  const info = readSessionInfo({
    SessionManager,
    sessionFile,
    currentSessionVersion: CURRENT_SESSION_VERSION,
    resolveSessionFile: (candidate) => fs.realpathSync(candidate),
  });
  assert.equal(info.sessionFile, sessionFile);
  assert.equal(info.parentSession, "/sessions/parent.jsonl");
  assert.equal(info.thinkingLevel, "high");
  assert.equal(info.totalMessages, 3);
  assert.equal(info.toolCalls, 1);
  assert.deepEqual(info.model, { provider: "openai", id: "gpt-5" });
  assert.equal(info.contextUsage, null);
  assert.equal(Object.hasOwn(info, "stats"), false);
});

test("session info reuses a canonically equivalent live manager", (t) => {
  const root = temporaryDirectory(t, "tau-live-info-");
  const sessionFile = writeSession(root);
  const symlink = path.join(root, "live-link.jsonl");
  fs.symlinkSync(sessionFile, symlink);
  const manager = {
    getSessionFile: () => symlink,
    buildSessionContext: () => ({ model: null, thinkingLevel: "off" }),
    getHeader: () => null,
    getSessionId: () => "live-session",
    getCwd: () => root,
    getSessionName: () => undefined,
    getEntries: () => [],
    getTree: () => [],
  };
  const info = readSessionInfo({
    SessionManager: { open: () => assert.fail("live sessions must reuse their manager") },
    sessionFile,
    liveSessionManager: manager,
    liveModel: { provider: "openai", id: "gpt-live" },
    liveThinking: "medium",
    liveContextUsage: { tokens: 42 },
    resolveSessionFile: (candidate) => fs.realpathSync(candidate),
  });
  assert.equal(info.sessionFile, sessionFile);
  assert.deepEqual(info.model, { provider: "openai", id: "gpt-live" });
  assert.equal(info.thinkingLevel, "medium");
  assert.deepEqual(info.contextUsage, { tokens: 42 });
  assert.equal(info.parentSession, null);
  assert.equal(info.name, null);
});

class CaptureResponse extends Writable {
  constructor(onWrite) {
    super();
    this.body = [];
    this.headers = {};
    this.statusCode = null;
    this.onWrite = onWrite;
  }

  _write(chunk, _encoding, callback) {
    this.body.push(Buffer.from(chunk));
    this.onWrite?.();
    this.onWrite = null;
    callback();
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }
}

test("exports stream JSONL and HTML attachments with safe headers and cleanup", async (t) => {
  const root = temporaryDirectory(t, "tau-export-test-");
  const sessionFile = path.join(root, 'unsafe"\r\nname.jsonl');
  fs.writeFileSync(sessionFile, '{"type":"session","version":2}\n');

  const jsonlResponse = new CaptureResponse();
  await sendSessionExport(jsonlResponse, { format: "jsonl", sessionFile });
  assert.equal(Buffer.concat(jsonlResponse.body).toString(), fs.readFileSync(sessionFile, "utf8"));
  assert.equal(jsonlResponse.statusCode, 200);
  assert.equal(/[\r\n]/.test(jsonlResponse.headers["Content-Disposition"]), false);
  assert.match(jsonlResponse.headers["Content-Disposition"], /filename\*=UTF-8''/);
  assert.equal(jsonlResponse.headers["X-Content-Type-Options"], "nosniff");

  const tempRoot = path.join(root, "temp");
  fs.mkdirSync(tempRoot);
  const before = fs.readFileSync(sessionFile);
  let childCall;
  const htmlResponse = new CaptureResponse();
  await sendSessionExport(htmlResponse, {
    format: "html",
    sessionFile,
    tempRoot,
    runExecFile: async (...args) => {
      childCall = args;
      fs.writeFileSync(args[1][2], "<html>done</html>");
    },
  });
  assert.equal(childCall[0], "pi");
  assert.deepEqual(childCall[1].slice(0, 1), ["--export"]);
  assert.notEqual(childCall[1][1], sessionFile);
  assert.equal(path.dirname(childCall[1][1]), path.dirname(childCall[1][2]));
  assert.equal(fs.readFileSync(sessionFile).equals(before), true);
  assert.equal(Buffer.concat(htmlResponse.body).toString(), "<html>done</html>");
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test("JSONL export keeps the initial inode size when the live source grows", async (t) => {
  const root = temporaryDirectory(t, "tau-export-snapshot-");
  const sessionFile = path.join(root, "growing.jsonl");
  const initial = "x".repeat(128 * 1024);
  fs.writeFileSync(sessionFile, initial);
  const response = new CaptureResponse(() => fs.appendFileSync(sessionFile, "new bytes"));

  await sendSessionExport(response, { format: "jsonl", sessionFile });

  assert.equal(Number(response.headers["Content-Length"]), Buffer.byteLength(initial));
  assert.equal(Buffer.concat(response.body).toString(), initial);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), `${initial}new bytes`);
});

test("HTML export cleans temporary files on child failure and client abort", async (t) => {
  const root = temporaryDirectory(t, "tau-export-failure-");
  const sessionFile = writeSession(root);
  const tempRoot = path.join(root, "temp");
  fs.mkdirSync(tempRoot);

  await assert.rejects(
    sendSessionExport(new CaptureResponse(), {
      format: "html",
      sessionFile,
      tempRoot,
      runExecFile: async () => { throw new Error("export failed"); },
    }),
    /export failed/,
  );
  assert.deepEqual(fs.readdirSync(tempRoot), []);

  const response = new CaptureResponse();
  await assert.rejects(
    sendSessionExport(response, {
      format: "html",
      sessionFile,
      tempRoot,
      runExecFile: async (_command, _args, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setImmediate(() => response.emit("close"));
      }),
    }),
    /aborted/,
  );
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});
