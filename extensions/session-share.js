import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { SessionActionError, withSessionHtmlExport } from "./session-actions.js";

const execFileAsync = promisify(execFile);
const FALLBACK = "html_download";

function shareError(status, message, code) {
  return new SessionActionError(status, message, { code, fallback: FALLBACK });
}

function unavailable(code) {
  return { available: false, code, fallback: FALLBACK };
}

export async function readShareCapability(runExecFile = execFileAsync) {
  try {
    await runExecFile("gh", ["--version"], { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    if (error?.code === "ENOENT") return unavailable("GH_MISSING");
    throw shareError(502, "GitHub CLI availability check failed", "GH_CHECK_FAILED");
  }
  try {
    await runExecFile("gh", ["auth", "status"], { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    if (error?.code === "ENOENT") return unavailable("GH_MISSING");
    if (typeof error?.code === "number") return unavailable("GH_UNAUTHENTICATED");
    throw shareError(502, "GitHub CLI authentication check failed", "GH_CHECK_FAILED");
  }
  return { available: true };
}

function gistUrl(stdout) {
  const value = typeof stdout === "string" ? stdout.trim() : "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw shareError(502, "GitHub CLI returned an invalid gist URL", "GH_INVALID_URL");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "gist.github.com"
    || url.port
    || url.search
    || url.hash
    || !/^\/[A-Za-z0-9-]+\/[0-9a-f]+$/.test(url.pathname)
  ) {
    throw shareError(502, "GitHub CLI returned an invalid gist URL", "GH_INVALID_URL");
  }
  return url.href;
}

export async function shareSessionAsGist({
  sessionFile,
  runExecFile = execFileAsync,
  tempRoot = os.tmpdir(),
}) {
  const capability = await readShareCapability(runExecFile);
  if (!capability.available) {
    throw shareError(
      409,
      capability.code === "GH_MISSING" ? "GitHub CLI is not installed" : "GitHub CLI is not authenticated",
      capability.code,
    );
  }
  return withSessionHtmlExport({ sessionFile, runExecFile, tempRoot }, async (outputFile) => {
    let result;
    try {
      result = await runExecFile("gh", ["gist", "create", outputFile], {
        cwd: os.homedir(),
        encoding: "utf8",
        timeout: 30_000,
      });
    } catch {
      const current = await readShareCapability(runExecFile);
      if (!current.available) {
        throw shareError(
          409,
          current.code === "GH_MISSING" ? "GitHub CLI became unavailable" : "GitHub CLI authentication became unavailable",
          current.code,
        );
      }
      throw shareError(502, "GitHub gist creation failed", "GH_GIST_FAILED");
    }
    return { url: gistUrl(result.stdout) };
  });
}
