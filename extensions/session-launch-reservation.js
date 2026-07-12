import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";

export function getSessionLaunchReservationPath(instancesDir, canonicalSessionFile) {
  const key = createHash("sha256").update(canonicalSessionFile).digest("hex");
  return path.join(instancesDir, `session-launch-${key}.lock`);
}

function validateSessionLaunchReservation(reservation) {
  if (
    reservation === null ||
    typeof reservation !== "object" ||
    Array.isArray(reservation) ||
    Object.keys(reservation).length !== 3 ||
    !Object.hasOwn(reservation, "launchId") ||
    !Object.hasOwn(reservation, "ownerPid") ||
    !Object.hasOwn(reservation, "sessionFile") ||
    typeof reservation.launchId !== "string" ||
    reservation.launchId.length === 0 ||
    !Number.isSafeInteger(reservation.ownerPid) ||
    reservation.ownerPid <= 0 ||
    typeof reservation.sessionFile !== "string" ||
    reservation.sessionFile.length === 0
  ) {
    throw new TypeError("Invalid session launch reservation");
  }
  return reservation;
}

export function readSessionLaunchReservation(reservationPath) {
  return validateSessionLaunchReservation(JSON.parse(fs.readFileSync(reservationPath, "utf8")));
}

function removeMatchingReservation(reservationPath, { launchId, sessionFile }) {
  try {
    const current = readSessionLaunchReservation(reservationPath);
    if (current.launchId !== launchId || current.sessionFile !== sessionFile) return false;
    fs.unlinkSync(reservationPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function acquireSessionLaunchReservation(
  instancesDir,
  { launchId, ownerPid, sessionFile },
) {
  const reservation = validateSessionLaunchReservation({ launchId, ownerPid, sessionFile });
  fs.mkdirSync(instancesDir, { recursive: true });
  const reservationPath = getSessionLaunchReservationPath(instancesDir, sessionFile);
  const temporaryPath = `${reservationPath}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(reservation)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      fs.linkSync(temporaryPath, reservationPath);
    } catch (error) {
      if (error?.code === "EEXIST") return { acquired: false, path: reservationPath };
      throw error;
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }

  return {
    acquired: true,
    path: reservationPath,
    reservation,
    release: () => removeMatchingReservation(reservationPath, reservation),
  };
}

export function completeSessionLaunchReservation(instancesDir, { launchId, sessionFile }) {
  return removeMatchingReservation(
    getSessionLaunchReservationPath(instancesDir, sessionFile),
    { launchId, sessionFile },
  );
}
