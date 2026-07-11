import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSessionFilePath } from "../extensions/session-file-paths.ts";

async function createSessionFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tau-session-paths-"));
  const sessions = path.join(root, "sessions");
  const nested = path.join(sessions, "project", "nested");
  const outside = path.join(root, "outside");
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(nested, "session.jsonl"), '{"type":"session"}\n');
  await writeFile(path.join(nested, "not-a-session.txt"), "nope\n");
  await writeFile(path.join(outside, "outside.jsonl"), '{"secret":true}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { sessions, nested, outside };
}

test("allows nested regular Pi session files inside the sessions root", async (t) => {
  const { sessions, nested } = await createSessionFixture(t);
  const sessionFile = path.join(nested, "session.jsonl");
  const expected = await realpath(sessionFile);

  assert.equal(
    resolveSessionFilePath(sessions, path.join("project", "nested", "session.jsonl")),
    expected,
  );
  assert.equal(
    resolveSessionFilePath(sessions, sessionFile, { allowAbsolute: true }),
    expected,
  );
});

test("read paths reject traversal and absolute paths", async (t) => {
  const { sessions, outside } = await createSessionFixture(t);
  const outsideFile = path.join(outside, "outside.jsonl");

  assert.throws(
    () => resolveSessionFilePath(sessions, path.join("..", "outside", "outside.jsonl")),
    /inside the sessions directory/,
  );
  assert.throws(
    () => resolveSessionFilePath(sessions, outsideFile),
    /must be relative/,
  );
});

test("delete and launch validation rejects non-session files and symlink escapes", async (t) => {
  const { sessions, nested, outside } = await createSessionFixture(t);
  const outsideFile = path.join(outside, "outside.jsonl");
  const linkedFile = path.join(nested, "linked.jsonl");
  const linkedDirectory = path.join(sessions, "linked-directory");
  await symlink(outsideFile, linkedFile);
  await symlink(outside, linkedDirectory);

  assert.throws(
    () => resolveSessionFilePath(sessions, path.join("project", "nested", "not-a-session.txt"), { allowAbsolute: true }),
    /.jsonl/,
  );
  assert.throws(
    () => resolveSessionFilePath(sessions, linkedFile, { allowAbsolute: true }),
    /regular file/,
  );
  assert.throws(
    () => resolveSessionFilePath(sessions, path.join(linkedDirectory, "outside.jsonl"), { allowAbsolute: true }),
    /inside the sessions directory/,
  );
  assert.throws(
    () => resolveSessionFilePath(sessions, outsideFile, { allowAbsolute: true }),
    /inside the sessions directory/,
  );
});
