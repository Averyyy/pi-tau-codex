import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SessionActionError } from "./session-actions.js";
import { acquireSessionLaunchReservation } from "./session-launch-reservation.js";

export const MAX_SESSION_IMPORT_BYTES = 64 * 1024 * 1024;

function importError(status, message, code = "INVALID_SESSION_IMPORT") {
  return new SessionActionError(status, message, { code });
}

function safeTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function safeCwd(value) {
  return typeof value === "string"
    && value.length > 0
    && !/[\u0000-\u001F\u007F-\u009F]/u.test(value)
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

function existingDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function validateProjectPath(projectPath) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath) || !existingDirectory(projectPath)) {
    throw importError(400, "projectPath must be an absolute existing directory");
  }
  return projectPath;
}

function decodeImportBody(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buffer.length > MAX_SESSION_IMPORT_BYTES) {
    throw importError(413, `Session import cannot exceed ${MAX_SESSION_IMPORT_BYTES} bytes`);
  }
  try {
    return { buffer, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    throw importError(400, "Session import must be valid UTF-8");
  }
}

function parseImportLines(text) {
  const lines = text.split("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw importError(400, `Invalid JSON on line ${index + 1}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw importError(400, `JSON object required on line ${index + 1}`);
    }
    records.push({ index, value });
  }
  if (records.length === 0) throw importError(400, "Session import is empty");
  return { lines, records };
}

function validateGraph(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (typeof entry.type !== "string" || !entry.type) {
      throw importError(400, "Every session entry must have a type");
    }
    if (typeof entry.id !== "string" || !entry.id) {
      throw importError(400, "Every session entry must have an id");
    }
    if (byId.has(entry.id)) throw importError(400, `Duplicate session entry id: ${entry.id}`);
    if (entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId)) {
      throw importError(400, `Invalid parentId for entry ${entry.id}`);
    }
    if (!safeTimestamp(entry.timestamp)) {
      throw importError(400, `Invalid timestamp for entry ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw importError(400, `Missing parent ${entry.parentId} for entry ${entry.id}`);
    }
    if (entry.type === "label" && (typeof entry.targetId !== "string" || !byId.has(entry.targetId))) {
      throw importError(400, `Invalid label target for entry ${entry.id}`);
    }
  }

  const state = new Map();
  for (const entry of entries) {
    if (state.get(entry.id) === 2) continue;
    const chain = [];
    let current = entry;
    while (current && state.get(current.id) !== 2) {
      if (state.get(current.id) === 1) throw importError(400, "Session entry graph contains a cycle");
      state.set(current.id, 1);
      chain.push(current.id);
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
    for (const id of chain) state.set(id, 2);
  }
}

function validateSessionImport(body, { SessionManager, currentSessionVersion, projectPath }) {
  const { text } = decodeImportBody(body);
  const { records } = parseImportLines(text);
  const header = records[0].value;
  if (header.type !== "session") throw importError(400, "The first session object must be the session header");
  if (records.slice(1).some((record) => record.value.type === "session")) {
    throw importError(400, "Session import must contain exactly one session header");
  }
  if (header.version !== currentSessionVersion) {
    throw importError(409, `Session version must be ${currentSessionVersion}`);
  }
  if (typeof header.id !== "string" || !header.id) throw importError(400, "Invalid session id");
  if (!safeCwd(header.cwd)) throw importError(400, "Invalid session cwd");
  if (!safeTimestamp(header.timestamp)) throw importError(400, "Invalid session timestamp");
  try {
    SessionManager.inMemory(header.cwd, { id: header.id });
  } catch (error) {
    throw importError(400, `Invalid session id: ${error?.message || String(error)}`);
  }

  const entries = records.slice(1).map((record) => record.value);
  validateGraph(entries);
  const cwdExists = existingDirectory(header.cwd);
  const cwd = cwdExists ? header.cwd : projectPath === undefined ? header.cwd : validateProjectPath(projectPath);
  const outputHeader = !cwdExists && projectPath !== undefined ? { ...header, cwd } : header;
  const output = Buffer.from([outputHeader, ...entries].map(JSON.stringify).join("\n") + "\n");
  return { cwd, cwdExists, entryCount: entries.length, header, output };
}

export async function readSessionImportBody(request) {
  if ((request.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/x-ndjson") {
    throw importError(415, "Content-Type must be application/x-ndjson");
  }
  const contentLength = request.headers?.["content-length"];
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_SESSION_IMPORT_BYTES)) {
    request.resume();
    throw importError(413, `Session import cannot exceed ${MAX_SESSION_IMPORT_BYTES} bytes`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_SESSION_IMPORT_BYTES) {
      request.resume();
      throw importError(413, `Session import cannot exceed ${MAX_SESSION_IMPORT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (request.aborted) throw importError(400, "Request was aborted");
  return Buffer.concat(chunks);
}

export function inspectSessionImport(options) {
  const parsed = validateSessionImport(options.body, options);
  return {
    sessionFile: null,
    cwd: parsed.cwd,
    id: parsed.header.id,
    entryCount: parsed.entryCount,
    requiresProject: !parsed.cwdExists && options.projectPath === undefined,
  };
}

function storedHeaderError(sessionFile) {
  return importError(500, `Stored session has an invalid header: ${sessionFile}`, "SESSION_STORAGE_CORRUPT");
}

function parseStoredHeader(sessionFile, bytes) {
  let header;
  try {
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r$/, "");
    header = JSON.parse(line);
  } catch {
    throw storedHeaderError(sessionFile);
  }
  if (!header || typeof header !== "object" || Array.isArray(header)
    || header.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw storedHeaderError(sessionFile);
  }
  return header;
}

function readStoredHeader(sessionFile) {
  const descriptor = fs.openSync(sessionFile, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const lineChunks = [];
  let lineBytes = 0;
  let scannedBytes = 0;
  try {
    while (scannedBytes < MAX_SESSION_IMPORT_BYTES) {
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, MAX_SESSION_IMPORT_BYTES - scannedBytes),
        null,
      );
      if (bytesRead === 0) {
        if (lineBytes === 0) throw storedHeaderError(sessionFile);
        return parseStoredHeader(sessionFile, Buffer.concat(lineChunks, lineBytes));
      }
      scannedBytes += bytesRead;
      let offset = 0;
      while (offset < bytesRead) {
        const newline = chunk.indexOf(0x0A, offset);
        const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        if (end > offset) {
          const part = Buffer.from(chunk.subarray(offset, end));
          lineChunks.push(part);
          lineBytes += part.length;
        }
        if (newline === -1 || newline >= bytesRead) break;
        const bytes = Buffer.concat(lineChunks, lineBytes);
        let nonEmpty;
        try {
          nonEmpty = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
        } catch {
          throw storedHeaderError(sessionFile);
        }
        if (nonEmpty) return parseStoredHeader(sessionFile, bytes);
        lineChunks.length = 0;
        lineBytes = 0;
        offset = newline + 1;
      }
    }
    throw storedHeaderError(sessionFile);
  } finally {
    fs.closeSync(descriptor);
  }
}

function* sessionHeaders(storageRoot) {
  if (!fs.existsSync(storageRoot)) return;
  const pending = [storageRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && path.extname(entry.name) === ".jsonl") {
        yield { sessionFile: candidate, header: readStoredHeader(candidate) };
      }
    }
  }
}

function atomicInstall(targetFile, content) {
  const temporaryFile = path.join(path.dirname(targetFile), `.${path.basename(targetFile)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryFile, targetFile);
  } catch (error) {
    if (error?.code === "EEXIST") throw importError(409, "Session already exists", "SESSION_COLLISION");
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryFile, { force: true });
  }
}

export function installSessionImport(options) {
  const parsed = validateSessionImport(options.body, options);
  if (!parsed.cwdExists && options.projectPath === undefined) {
    throw importError(409, "An existing projectPath is required", "IMPORT_PROJECT_REQUIRED");
  }
  if (typeof options.storageRoot !== "string" || typeof options.instancesDir !== "string") {
    throw new TypeError("storageRoot and instancesDir are required");
  }
  const reservationKey = path.join(options.storageRoot, `.tau-import-${parsed.header.id}`);
  const reservation = acquireSessionLaunchReservation(options.instancesDir, {
    launchId: randomUUID(),
    ownerPid: process.pid,
    sessionFile: reservationKey,
  });
  if (!reservation.acquired) throw importError(409, "Session id is being imported", "SESSION_COLLISION");
  try {
    const targetManager = options.SessionManager.create(parsed.cwd, options.sessionDir, { id: parsed.header.id });
    const fileTimestamp = parsed.header.timestamp.replace(/[:.]/g, "-");
    const targetFile = path.join(targetManager.getSessionDir(), `${fileTimestamp}_${parsed.header.id}.jsonl`);
    if (fs.existsSync(targetFile)) {
      throw importError(409, "Session file already exists", "SESSION_COLLISION");
    }
    for (const { header } of sessionHeaders(options.storageRoot)) {
      if (header.id === parsed.header.id) {
        throw importError(409, "Session id already exists", "SESSION_COLLISION");
      }
    }
    atomicInstall(targetFile, parsed.output);
    const collisions = [];
    for (const stored of sessionHeaders(options.storageRoot)) {
      if (stored.header.id === parsed.header.id) collisions.push(stored);
    }
    if (collisions.length !== 1 || fs.realpathSync(collisions[0].sessionFile) !== fs.realpathSync(targetFile)) {
      fs.rmSync(targetFile, { force: true });
      throw importError(409, "Session id already exists", "SESSION_COLLISION");
    }
    return {
      sessionFile: fs.realpathSync(targetFile),
      cwd: parsed.cwd,
      id: parsed.header.id,
      entryCount: parsed.entryCount,
    };
  } finally {
    reservation.release();
  }
}
