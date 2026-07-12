import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { acquireSessionLaunchReservation } from "./session-launch-reservation.js";
import { aggregateSessionStats } from "./session-stats.js";

const execFileAsync = promisify(execFile);
const SESSION_ACTION_BODY_LIMIT = 16 * 1024;

export class SessionActionError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

function fileState(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileState(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

export function assertCurrentSessionVersion(sessionFile, currentVersion) {
  const content = fs.readFileSync(sessionFile, "utf8");
  const firstLine = content.slice(0, content.indexOf("\n") === -1 ? content.length : content.indexOf("\n"));
  const header = JSON.parse(firstLine);
  if (header?.type !== "session" || !Number.isInteger(header.version)) {
    throw new SessionActionError(400, "Invalid Pi session header");
  }
  if (header.version !== currentVersion) {
    throw new SessionActionError(
      409,
      `Session version ${header.version} must be migrated by Pi before this operation`,
    );
  }
}

export function sameCanonicalSession(candidate, target, resolveSessionFile) {
  if (!candidate) return false;
  try {
    return resolveSessionFile(fs.realpathSync(candidate)) === target;
  } catch {
    return false;
  }
}

function assertNotLive(sessionFile, currentSessionFile, getRunningInstances, resolveSessionFile) {
  const owner = getRunningInstances().find((instance) =>
    sameCanonicalSession(instance.sessionFile, sessionFile, resolveSessionFile));
  if (sameCanonicalSession(currentSessionFile, sessionFile, resolveSessionFile) || owner) {
    throw new SessionActionError(409, "Session is active", {
      ...(owner?.port ? { ownerPort: owner.port } : {}),
    });
  }
}

export function normalizeSessionName(name) {
  if (typeof name !== "string") throw new SessionActionError(400, "Name must be a string");
  const normalized = name.trim();
  if (!normalized) throw new SessionActionError(400, "Name cannot be empty");
  if (normalized.length > 200) {
    throw new SessionActionError(400, "Name cannot exceed 200 characters");
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new SessionActionError(400, "Name cannot contain control characters");
  }
  return normalized;
}

export function readSessionActionBody(request, allowedKeys) {
  return new Promise((resolve, reject) => {
    if (request.aborted || request.destroyed) {
      reject(new SessionActionError(400, "Request was aborted"));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > SESSION_ACTION_BODY_LIMIT) {
        settled = true;
        request.resume();
        reject(new SessionActionError(413, "Request body is too large"));
        return;
      }
      chunks.push(buffer);
    });
    request.once("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new SessionActionError(400, "Request was aborted"));
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        reject(error);
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        reject(new SessionActionError(400, "JSON object required"));
        return;
      }
      const unsupported = Object.keys(payload).find((key) => !allowedKeys.includes(key));
      if (unsupported) {
        reject(new SessionActionError(400, `Unsupported request field: ${unsupported}`));
        return;
      }
      resolve(payload);
    });
  });
}

export function renameHistoricalSession({
  SessionManager,
  sessionFile,
  name,
  currentSessionFile,
  getRunningInstances,
  instancesDir,
  resolveSessionFile,
  currentSessionVersion,
}) {
  const normalizedName = normalizeSessionName(name);

  const reservation = acquireSessionLaunchReservation(instancesDir, {
    launchId: randomUUID(),
    ownerPid: process.pid,
    sessionFile,
  });
  if (!reservation.acquired) throw new SessionActionError(409, "Session is busy");

  try {
    assertNotLive(sessionFile, currentSessionFile, getRunningInstances, resolveSessionFile);
    const initial = fileState(fs.statSync(sessionFile));
    assertCurrentSessionVersion(sessionFile, currentSessionVersion);
    if (!sameFileState(initial, fileState(fs.statSync(sessionFile)))) {
      throw new SessionActionError(409, "Session changed during version check");
    }
    const manager = SessionManager.open(sessionFile);
    if (!sameFileState(initial, fileState(fs.statSync(sessionFile)))) {
      throw new SessionActionError(409, "Session changed while opening");
    }

    assertNotLive(sessionFile, currentSessionFile, getRunningInstances, resolveSessionFile);
    const beforeAppend = fileState(fs.statSync(sessionFile));
    if (!sameFileState(initial, beforeAppend)) {
      throw new SessionActionError(409, "Session changed before rename");
    }

    manager.appendSessionInfo(normalizedName);
    const afterAppend = fileState(fs.statSync(sessionFile));
    if (
      afterAppend.dev !== beforeAppend.dev
      || afterAppend.ino !== beforeAppend.ino
      || afterAppend.size <= beforeAppend.size
    ) {
      throw new SessionActionError(409, "Session was not appended safely");
    }
    return { name: manager.getSessionName() || normalizedName };
  } finally {
    reservation.release();
  }
}

function normalizeModel(model) {
  return model ? { provider: model.provider, id: model.id || model.modelId } : null;
}

export function buildSessionInfo({
  manager,
  sessionFile = manager.getSessionFile() || null,
  model,
  thinkingLevel,
  contextUsage,
}) {
  const header = manager.getHeader();
  return {
    ...aggregateSessionStats(manager.getEntries(), manager.getTree()),
    sessionId: manager.getSessionId(),
    sessionFile,
    cwd: manager.getCwd(),
    parentSession: header?.parentSession || null,
    name: manager.getSessionName() || null,
    model: normalizeModel(model),
    thinkingLevel,
    contextUsage: contextUsage || null,
  };
}

export function readSessionInfo({
  SessionManager,
  sessionFile,
  liveSessionManager,
  liveModel,
  liveThinking,
  liveContextUsage,
  currentSessionVersion,
  resolveSessionFile,
}) {
  const isLive = !!liveSessionManager && sameCanonicalSession(
    liveSessionManager.getSessionFile(),
    sessionFile,
    resolveSessionFile,
  );
  let manager = liveSessionManager;
  if (!isLive) {
    const initial = fileState(fs.statSync(sessionFile));
    assertCurrentSessionVersion(sessionFile, currentSessionVersion);
    if (!sameFileState(initial, fileState(fs.statSync(sessionFile)))) {
      throw new SessionActionError(409, "Session changed during version check");
    }
    manager = SessionManager.open(sessionFile);
    if (!sameFileState(initial, fileState(fs.statSync(sessionFile)))) {
      throw new SessionActionError(409, "Session changed while opening");
    }
  }
  const context = manager.buildSessionContext();
  return buildSessionInfo({
    manager,
    sessionFile,
    model: isLive ? liveModel : context.model,
    thinkingLevel: isLive ? liveThinking : context.thinkingLevel,
    contextUsage: isLive ? liveContextUsage : null,
  });
}

function downloadNames(sessionFile, extension) {
  const stem = path.basename(sessionFile, path.extname(sessionFile));
  const unicodeStem = stem.replace(/[\u0000-\u001F\u007F-\u009F]/gu, "_").slice(0, 120) || "session";
  const safeStem = stem.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
  return {
    ascii: `${safeStem}.${extension}`,
    encoded: encodeURIComponent(`${unicodeStem}.${extension}`)
      .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`),
  };
}

function attachmentHeaders(sessionFile, extension, size) {
  const names = downloadNames(sessionFile, extension);
  return {
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${names.ascii}"; filename*=UTF-8''${names.encoded}`,
    "Content-Length": size,
    "Content-Type": extension === "html"
      ? "text/html; charset=utf-8"
      : "application/x-ndjson",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function sendSessionExport(response, {
  format,
  sessionFile,
  runExecFile = execFileAsync,
  tempRoot = os.tmpdir(),
}) {
  if (response.destroyed || response.closed) return;
  if (format === "jsonl") {
    const fd = fs.openSync(sessionFile, "r");
    let closeFd = true;
    try {
      const stat = fs.fstatSync(fd);
      response.writeHead(200, attachmentHeaders(sessionFile, "jsonl", stat.size));
      if (stat.size === 0) {
        fs.closeSync(fd);
        closeFd = false;
        response.end();
        return;
      }
      const stream = fs.createReadStream(sessionFile, { fd, start: 0, end: stat.size - 1 });
      closeFd = false;
      await pipeline(stream, response);
    } finally {
      if (closeFd) fs.closeSync(fd);
    }
    return;
  }
  if (format !== "html") throw new SessionActionError(400, "format must be html or jsonl");

  const tempDir = fs.mkdtempSync(path.join(tempRoot, "tau-export-"));
  const tempSessionFile = path.join(tempDir, "session.jsonl");
  const outputFile = path.join(tempDir, "session.html");
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  try {
    if (response.destroyed || response.closed) controller.abort();
    if (controller.signal.aborted) return;
    const sourceState = fileState(fs.statSync(sessionFile));
    fs.copyFileSync(sessionFile, tempSessionFile);
    if (!sameFileState(sourceState, fileState(fs.statSync(sessionFile)))) {
      throw new SessionActionError(409, "Session changed while preparing export");
    }
    await runExecFile("pi", ["--export", tempSessionFile, outputFile], {
      cwd: tempDir,
      encoding: "utf8",
      timeout: 30_000,
      signal: controller.signal,
    });
    if (response.destroyed) return;
    const stat = fs.statSync(outputFile);
    response.writeHead(200, attachmentHeaders(sessionFile, "html", stat.size));
    await pipeline(fs.createReadStream(outputFile), response);
  } finally {
    response.off("close", abort);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
