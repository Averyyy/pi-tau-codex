import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function getPiExportArgs(sessionFile) {
  return ["--export", sessionFile];
}

export function parsePiExportOutput(output) {
  const line = output.trim().split(/\r?\n/).at(-1);
  const prefix = "Exported to: ";
  if (!line?.startsWith(prefix) || line.length === prefix.length) {
    throw new Error("Pi did not return an exported HTML path");
  }
  return line.slice(prefix.length);
}

export async function exportSessionToHtml(sessionFile, cwd) {
  const { stdout } = await execFileAsync("pi", getPiExportArgs(sessionFile), {
    cwd,
    timeout: 30_000,
    encoding: "utf8",
  });
  return parsePiExportOutput(stdout);
}
