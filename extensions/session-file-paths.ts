import * as fs from "node:fs";
import * as path from "node:path";

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireSessionFileExtension(filePath: string) {
  if (path.extname(filePath) !== ".jsonl") {
    throw new Error("Session file must be a .jsonl file");
  }
}

/**
 * Resolve an existing Pi session file without allowing a session API request to
 * escape the configured sessions root. The final path must be a real regular
 * .jsonl file; this also rejects symlinked files and directory escapes.
 */
export function resolveSessionFilePath(
  sessionsRoot: string,
  requestedPath: string,
  options: { allowAbsolute?: boolean } = {},
): string {
  if (typeof requestedPath !== "string" || !requestedPath) {
    throw new Error("Session file path required");
  }
  if (!options.allowAbsolute && path.isAbsolute(requestedPath)) {
    throw new Error("Session file path must be relative");
  }

  const rootPath = path.resolve(sessionsRoot);
  const candidatePath = path.resolve(
    path.isAbsolute(requestedPath) ? requestedPath : path.join(rootPath, requestedPath),
  );
  if (!isWithinDirectory(rootPath, candidatePath)) {
    throw new Error("Session file must be inside the sessions directory");
  }
  requireSessionFileExtension(candidatePath);

  const candidateStat = fs.lstatSync(candidatePath);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error("Session file must be a regular file");
  }

  const rootRealPath = fs.realpathSync(rootPath);
  const realPath = fs.realpathSync(candidatePath);
  if (!isWithinDirectory(rootRealPath, realPath)) {
    throw new Error("Session file must be inside the sessions directory");
  }
  requireSessionFileExtension(realPath);

  return realPath;
}
