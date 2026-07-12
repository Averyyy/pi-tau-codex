import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  acquireSessionLaunchReservation,
  completeSessionLaunchReservation,
  readSessionLaunchReservation,
} from "../extensions/session-launch-reservation.js";

const execFileAsync = promisify(execFile);
const reservationModule = new URL("../extensions/session-launch-reservation.js", import.meta.url).href;

async function createInstancesDir(t) {
  const instancesDir = await mkdtemp(join(tmpdir(), "tau-session-launch-"));
  t.after(() => rm(instancesDir, { recursive: true, force: true }));
  return instancesDir;
}

async function acquireInChild(instancesDir, launchId, sessionFile) {
  const source = `
    import { acquireSessionLaunchReservation } from ${JSON.stringify(reservationModule)};
    const reservation = acquireSessionLaunchReservation(
      ${JSON.stringify(instancesDir)},
      { launchId: ${JSON.stringify(launchId)}, ownerPid: process.pid, sessionFile: ${JSON.stringify(sessionFile)} },
    );
    process.stdout.write(JSON.stringify({ acquired: reservation.acquired }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", source]);
  return JSON.parse(stdout);
}

test("writes a complete private JSON reservation and removes its temp file", async (t) => {
  const instancesDir = await createInstancesDir(t);
  const reservation = { launchId: "launch-a", ownerPid: process.pid, sessionFile: "/session.jsonl" };
  const acquired = acquireSessionLaunchReservation(instancesDir, reservation);

  assert.equal(acquired.acquired, true);
  assert.deepEqual(acquired.reservation, reservation);
  assert.equal(await readFile(acquired.path, "utf8"), `${JSON.stringify(reservation)}\n`);
  assert.deepEqual(readSessionLaunchReservation(acquired.path), reservation);
  assert.equal((await stat(acquired.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(instancesDir), [basename(acquired.path)]);
  assert.equal(acquired.release(), true);
});

test("rejects malformed or non-exact reservation JSON", async (t) => {
  const reservationPath = join(await createInstancesDir(t), "reservation.lock");

  await writeFile(reservationPath, "not JSON\n");
  assert.throws(() => readSessionLaunchReservation(reservationPath), SyntaxError);

  await writeFile(
    reservationPath,
    `${JSON.stringify({
      launchId: "launch-a",
      ownerPid: process.pid,
      sessionFile: "/session.jsonl",
      extra: true,
    })}\n`,
  );
  assert.throws(() => readSessionLaunchReservation(reservationPath), TypeError);
});

test("a child process cannot replace an existing reservation", async (t) => {
  const instancesDir = await createInstancesDir(t);
  const sessionFile = "/session.jsonl";
  const parent = acquireSessionLaunchReservation(instancesDir, {
    launchId: "parent",
    ownerPid: process.pid,
    sessionFile,
  });

  assert.deepEqual(await acquireInChild(instancesDir, "child", sessionFile), { acquired: false });
  assert.deepEqual(readSessionLaunchReservation(parent.path), parent.reservation);
  parent.release();
});

test("a reservation remains after its owner process exits", async (t) => {
  const instancesDir = await createInstancesDir(t);
  const sessionFile = "/session.jsonl";

  assert.deepEqual(await acquireInChild(instancesDir, "dead-owner", sessionFile), { acquired: true });
  const blocked = acquireSessionLaunchReservation(instancesDir, {
    launchId: "next-launch",
    ownerPid: process.pid,
    sessionFile,
  });
  assert.equal(blocked.acquired, false);
  assert.equal(readSessionLaunchReservation(blocked.path).launchId, "dead-owner");
});

test("completion removes only the exact reservation", async (t) => {
  const instancesDir = await createInstancesDir(t);
  const reservation = { launchId: "launch-a", ownerPid: process.pid, sessionFile: "/session.jsonl" };
  const acquired = acquireSessionLaunchReservation(instancesDir, reservation);

  assert.equal(
    completeSessionLaunchReservation(instancesDir, {
      launchId: "wrong-launch",
      sessionFile: reservation.sessionFile,
    }),
    false,
  );
  assert.equal(existsSync(acquired.path), true);
  assert.equal(
    completeSessionLaunchReservation(instancesDir, {
      launchId: reservation.launchId,
      sessionFile: reservation.sessionFile,
    }),
    true,
  );
  assert.equal(existsSync(acquired.path), false);
});

test("release leaves a replacement reservation in place", async (t) => {
  const instancesDir = await createInstancesDir(t);
  const original = acquireSessionLaunchReservation(instancesDir, {
    launchId: "original",
    ownerPid: process.pid,
    sessionFile: "/session.jsonl",
  });
  const replacement = {
    launchId: "original",
    ownerPid: process.pid,
    sessionFile: "/other-session.jsonl",
  };

  await rm(original.path);
  await writeFile(original.path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  assert.equal(original.release(), false);
  assert.deepEqual(readSessionLaunchReservation(original.path), replacement);
});
