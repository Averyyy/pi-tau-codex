import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readShareCapability, shareSessionAsGist } from "../extensions/session-share.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-share-"));
  const tempRoot = path.join(root, "temp");
  fs.mkdirSync(tempRoot);
  const sessionFile = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, tempRoot, sessionFile };
}

test("share capability distinguishes a missing gh binary from unavailable auth", async () => {
  assert.deepEqual(await readShareCapability(async () => {
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  }), { available: false, code: "GH_MISSING", fallback: "html_download" });

  let calls = 0;
  assert.deepEqual(await readShareCapability(async () => {
    calls += 1;
    if (calls === 2) {
      const error = new Error("not logged in");
      error.code = 1;
      throw error;
    }
    return { stdout: "gh version" };
  }), { available: false, code: "GH_UNAUTHENTICATED", fallback: "html_download" });

  await assert.rejects(
    readShareCapability(async (_command, args) => {
      if (args[0] === "auth") {
        const error = new Error("timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return { stdout: "gh version" };
    }),
    (error) => error.code === "GH_CHECK_FAILED" && error.fallback === "html_download",
  );
});

test("share exports a stable HTML snapshot and creates a secret gist with execFile", async (t) => {
  const { tempRoot, sessionFile } = fixture(t);
  const calls = [];
  const before = fs.readFileSync(sessionFile);
  const result = await shareSessionAsGist({
    sessionFile,
    tempRoot,
    runExecFile: async (command, args) => {
      calls.push([command, args]);
      if (command === "pi") {
        assert.notEqual(args[1], sessionFile);
        fs.writeFileSync(args[2], "<html>snapshot</html>");
        return { stdout: "" };
      }
      if (args[0] === "gist") {
        assert.deepEqual(args.slice(0, 2), ["gist", "create"]);
        assert.equal(args.includes("--public"), false);
        assert.equal(fs.readFileSync(args[2], "utf8"), "<html>snapshot</html>");
        return { stdout: "https://gist.github.com/avery/0123abcdef\n" };
      }
      return { stdout: "ok" };
    },
  });
  assert.deepEqual(result, { url: "https://gist.github.com/avery/0123abcdef" });
  assert.equal(fs.readFileSync(sessionFile).equals(before), true);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  assert.equal(calls.some(([, args]) => args[0] === "gist"), true);
});

test("share reports an auth race and always removes temporary files", async (t) => {
  const { tempRoot, sessionFile } = fixture(t);
  let gistFailed = false;
  await assert.rejects(
    shareSessionAsGist({
      sessionFile,
      tempRoot,
      runExecFile: async (command, args) => {
        if (command === "pi") {
          fs.writeFileSync(args[2], "<html></html>");
          return { stdout: "" };
        }
        if (args[0] === "gist") {
          gistFailed = true;
          throw new Error("token expired");
        }
        if (args[0] === "auth" && gistFailed) {
          const error = new Error("not logged in");
          error.code = 1;
          throw error;
        }
        return { stdout: "ok" };
      },
    }),
    (error) => error.status === 409
      && error.code === "GH_UNAUTHENTICATED"
      && error.fallback === "html_download",
  );
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test("share rejects non-gist URLs and cleans the export", async (t) => {
  const { tempRoot, sessionFile } = fixture(t);
  await assert.rejects(
    shareSessionAsGist({
      sessionFile,
      tempRoot,
      runExecFile: async (command, args) => {
        if (command === "pi") fs.writeFileSync(args[2], "<html></html>");
        return { stdout: args[0] === "gist" ? "https://example.com/not-a-gist" : "ok" };
      },
    }),
    (error) => error.status === 502 && error.code === "GH_INVALID_URL",
  );
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});
