import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  assertCurrentSessionVersion,
  assertSessionNotLive,
  sameCanonicalSession,
  sameSessionFileState,
  sessionFileState,
  SessionActionError,
} from "./session-actions.js";
import { acquireSessionLaunchReservation } from "./session-launch-reservation.js";

export const MAX_BROWSER_DRAFT_BYTES = 64 * 1024;

export function normalizeSessionEntryId(entryId) {
  if (typeof entryId !== "string" || !entryId) {
    throw new SessionActionError(400, "valid entryId required");
  }
  return entryId;
}

export function normalizeEntryLabel(label) {
  if (label === null) return undefined;
  if (typeof label !== "string") {
    throw new SessionActionError(400, "label must be a string or null");
  }
  const normalized = label.trim();
  if (!normalized) return undefined;
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new SessionActionError(400, "label cannot contain control characters");
  }
  return normalized;
}

export function normalizeBrowserDraft(draft) {
  if (typeof draft !== "string") throw new SessionActionError(400, "draft must be a string");
  if (Buffer.byteLength(draft, "utf8") > MAX_BROWSER_DRAFT_BYTES) {
    throw new SessionActionError(413, `draft cannot exceed ${MAX_BROWSER_DRAFT_BYTES} bytes`);
  }
  return draft;
}

function assertStableSession(sessionFile, expected, message) {
  if (!sameSessionFileState(expected, sessionFileState(fs.statSync(sessionFile)))) {
    throw new SessionActionError(409, message);
  }
}

function openStableSession({ SessionManager, sessionFile, currentSessionVersion, resolveSessionFile }) {
  const stat = fs.statSync(sessionFile);
  if (!stat.isFile()) throw new SessionActionError(400, "Session must be a regular file");
  const initial = sessionFileState(stat);
  assertCurrentSessionVersion(sessionFile, currentSessionVersion);
  assertStableSession(sessionFile, initial, "Session changed during version check");
  const manager = SessionManager.open(sessionFile);
  assertStableSession(sessionFile, initial, "Session changed while opening");
  if (!sameCanonicalSession(manager.getSessionFile(), sessionFile, resolveSessionFile)) {
    throw new SessionActionError(409, "Pi opened a different session file");
  }
  return { manager, initial };
}

function sameSessionReference(candidate, target, resolveSessionFile) {
  return candidate === target || sameCanonicalSession(candidate, target, resolveSessionFile);
}

export function assertCurrentSessionReference(sessionFile, currentSessionFile, resolveSessionFile) {
  if (!sameSessionReference(currentSessionFile, sessionFile, resolveSessionFile)) {
    throw new SessionActionError(409, "The active session changed");
  }
}

function assertNoOtherWriter({ sessionFile, currentSessionFile, getRunningInstances, resolveSessionFile }) {
  const current = sameSessionReference(currentSessionFile, sessionFile, resolveSessionFile);
  const owner = getRunningInstances().find((instance) =>
    sameSessionReference(instance.sessionFile, sessionFile, resolveSessionFile)
    && (!current || instance.pid !== process.pid));
  if (owner) {
    throw new SessionActionError(409, "Session is active in another Pi instance", {
      ...(owner.port ? { ownerPort: owner.port } : {}),
    });
  }
  return current;
}

function sessionTreeResult(manager, sessionFile) {
  const leafId = manager.getLeafId();
  const header = manager.getHeader();
  return {
    sessionFile,
    cwd: manager.getCwd(),
    sessionId: manager.getSessionId(),
    name: manager.getSessionName() || null,
    parentSession: header?.parentSession || null,
    leafId,
    activePath: leafId ? manager.getBranch(leafId).map((entry) => entry.id) : [],
    roots: manager.getTree(),
  };
}

export function readSessionTree({
  SessionManager,
  sessionFile,
  liveSessionManager,
  currentSessionVersion,
  getRunningInstances,
  resolveSessionFile,
}) {
  const currentSessionFile = liveSessionManager?.getSessionFile() || null;
  const isCurrent = assertNoOtherWriter({
    sessionFile,
    currentSessionFile,
    getRunningInstances,
    resolveSessionFile,
  });
  if (isCurrent) return sessionTreeResult(liveSessionManager, sessionFile);

  const { manager, initial } = openStableSession({
    SessionManager,
    sessionFile,
    currentSessionVersion,
    resolveSessionFile,
  });
  const result = sessionTreeResult(manager, sessionFile);
  assertStableSession(sessionFile, initial, "Session changed while reading tree");
  return result;
}

function extractUserMessageText(content) {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function branchContainsAssistant(manager, targetId) {
  return targetId !== null && manager.getBranch(targetId).some((entry) =>
    entry.type === "message" && entry.message.role === "assistant");
}

function removeCreatedBranch(sessionFile, sourceFile) {
  if (typeof sessionFile !== "string" || !fs.existsSync(sessionFile)) return;
  const candidate = path.resolve(sessionFile);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("refusing to remove a non-regular branch result");
  }
  const canonical = fs.realpathSync(candidate);
  if (canonical === sourceFile || path.dirname(canonical) !== path.dirname(sourceFile)) {
    throw new Error("refusing to remove a branch outside the source session directory");
  }
  fs.unlinkSync(candidate);
}

function cleanupBranchAfterFailure(error, sessionFile, sourceFile) {
  try {
    removeCreatedBranch(sessionFile, sourceFile);
  } catch (cleanupError) {
    if (error instanceof Error) {
      error.message += `; cleanup failed: ${cleanupError.message || String(cleanupError)}`;
    }
  }
  throw error;
}

function createSessionBranch({
  mode,
  SessionManager,
  sessionFile,
  entryId,
  liveSessionManager,
  currentSessionFile,
  currentSessionVersion,
  getRunningInstances,
  instancesDir,
  resolveSessionFile,
}) {
  const reservation = acquireSessionLaunchReservation(instancesDir, {
    launchId: randomUUID(),
    ownerPid: process.pid,
    sessionFile,
  });
  if (!reservation.acquired) throw new SessionActionError(409, "Session is busy");
  try {
    const isCurrent = assertNoOtherWriter({
      sessionFile,
      currentSessionFile,
      getRunningInstances,
      resolveSessionFile,
    });
    if (isCurrent && !fs.existsSync(sessionFile)) {
      if (mode !== "fork") {
        throw new SessionActionError(409, "This session is not persisted yet");
      }
      const selectedId = normalizeSessionEntryId(entryId);
      const selected = liveSessionManager?.getEntry(selectedId);
      if (!selected) throw new SessionActionError(404, "Session entry not found");
      if (selected.type !== "message" || selected.message.role !== "user") {
        throw new SessionActionError(400, "Fork target must be a user message");
      }
      if (selected.parentId !== null) {
        normalizeSessionEntryId(selected.parentId);
        if (!liveSessionManager.getEntry(selected.parentId)) {
          throw new SessionActionError(409, "Fork target has a missing parent entry");
        }
      }
      if (branchContainsAssistant(liveSessionManager, selected.parentId)) {
        throw new SessionActionError(409, "This session is not persisted yet");
      }
      return {
        kind: "new-task",
        cwd: liveSessionManager.getCwd(),
        draft: extractUserMessageText(selected.message.content),
      };
    }

    const { manager, initial } = openStableSession({
      SessionManager,
      sessionFile,
      currentSessionVersion,
      resolveSessionFile,
    });
    assertNoOtherWriter({
      sessionFile,
      currentSessionFile,
      getRunningInstances,
      resolveSessionFile,
    });

    let targetId;
    let draft = "";
    if (mode === "duplicate") {
      targetId = manager.getLeafId();
      if (targetId === null) throw new SessionActionError(400, "Cannot duplicate an empty session");
      normalizeSessionEntryId(targetId);
    } else {
      const selectedId = normalizeSessionEntryId(entryId);
      const selected = manager.getEntry(selectedId);
      if (!selected) throw new SessionActionError(404, "Session entry not found");
      if (mode === "fork") {
        if (selected.type !== "message" || selected.message.role !== "user") {
          throw new SessionActionError(400, "Fork target must be a user message");
        }
        draft = extractUserMessageText(selected.message.content);
        targetId = selected.parentId;
        if (targetId !== null) {
          normalizeSessionEntryId(targetId);
          if (!manager.getEntry(targetId)) {
            throw new SessionActionError(409, "Fork target has a missing parent entry");
          }
        }
      } else {
        targetId = selectedId;
      }
    }

    const cwd = manager.getCwd();
    assertStableSession(sessionFile, initial, "Session changed before branching");
    if (mode === "fork" && !branchContainsAssistant(manager, targetId)) {
      return { kind: "new-task", cwd, draft };
    }

    let branchedSessionFile;
    try {
      branchedSessionFile = manager.createBranchedSession(targetId);
      assertStableSession(sessionFile, initial, "Session changed while branching");
      if (!branchedSessionFile) {
        throw new SessionActionError(409, "The source session is not persisted");
      }
      if (!fs.existsSync(branchedSessionFile)) {
        throw new SessionActionError(
          409,
          "This branch cannot be opened until it contains an assistant response",
        );
      }

      const canonicalBranch = resolveSessionFile(branchedSessionFile);
      if (canonicalBranch === sessionFile || !fs.statSync(canonicalBranch).isFile()) {
        throw new SessionActionError(409, "Pi returned an invalid branched session");
      }
      return {
        kind: "session",
        sessionFile: canonicalBranch,
        cwd,
        ...(mode === "fork" ? { draft } : {}),
      };
    } catch (error) {
      cleanupBranchAfterFailure(error, branchedSessionFile, sessionFile);
    }
  } finally {
    reservation.release();
  }
}

export function forkSession(options) {
  return createSessionBranch({ ...options, mode: "fork" });
}

export function duplicateSession(options) {
  return createSessionBranch({ ...options, mode: "duplicate" });
}

export function branchSession(options) {
  return createSessionBranch({ ...options, mode: "branch" });
}

export function labelHistoricalSession({
  SessionManager,
  sessionFile,
  entryId,
  label,
  currentSessionFile,
  currentSessionVersion,
  getRunningInstances,
  instancesDir,
  resolveSessionFile,
}) {
  const targetId = normalizeSessionEntryId(entryId);
  const normalizedLabel = normalizeEntryLabel(label);
  const reservation = acquireSessionLaunchReservation(instancesDir, {
    launchId: randomUUID(),
    ownerPid: process.pid,
    sessionFile,
  });
  if (!reservation.acquired) throw new SessionActionError(409, "Session is busy");

  try {
    assertSessionNotLive(sessionFile, currentSessionFile, getRunningInstances, resolveSessionFile);
    const { manager, initial } = openStableSession({
      SessionManager,
      sessionFile,
      currentSessionVersion,
      resolveSessionFile,
    });
    if (!manager.getEntry(targetId)) throw new SessionActionError(404, "Session entry not found");
    assertSessionNotLive(sessionFile, currentSessionFile, getRunningInstances, resolveSessionFile);
    assertStableSession(sessionFile, initial, "Session changed before labeling");

    const beforeAppend = sessionFileState(fs.statSync(sessionFile));
    manager.appendLabelChange(targetId, normalizedLabel);
    const afterAppend = sessionFileState(fs.statSync(sessionFile));
    if (
      afterAppend.dev !== beforeAppend.dev
      || afterAppend.ino !== beforeAppend.ino
      || afterAppend.size <= beforeAppend.size
    ) {
      throw new SessionActionError(409, "Session label was not appended safely");
    }
    return { entryId: targetId, label: normalizedLabel ?? null };
  } finally {
    reservation.release();
  }
}
