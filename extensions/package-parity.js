import { createContextSettingsManager } from "./settings-parity.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function drainSettingsErrors(settingsManager) {
  return settingsManager.drainErrors().map(({ scope, error }) => `${scope}: ${errorMessage(error)}`);
}

function normalizeScope(scope) {
  if (scope !== "global" && scope !== "project") {
    throw new Error('scope must be "global" or "project"');
  }
  return scope;
}

function normalizeSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("source must be a non-empty string");
  }
  if (source.includes("\0")) throw new Error("source must not contain NUL bytes");
  const normalized = source.trim();
  if (Buffer.byteLength(normalized, "utf8") > 4096) {
    throw new Error("source must not exceed 4096 UTF-8 bytes");
  }
  return normalized;
}

function publicScope(scope) {
  return scope === "user" ? "global" : scope;
}

function publicResource(resource) {
  return {
    path: resource.path,
    enabled: resource.enabled,
    source: resource.metadata.source,
    scope: publicScope(resource.metadata.scope),
    origin: resource.metadata.origin,
    ...(resource.metadata.baseDir ? { baseDir: resource.metadata.baseDir } : {}),
  };
}

export function createPackageMutationQueue() {
  let tail = Promise.resolve();
  return function run(operation) {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createPiPackageRuntime(DefaultPackageManager, SettingsManager, ctx, agentDir) {
  const settingsManager = createContextSettingsManager(SettingsManager, ctx, agentDir);
  return {
    settingsManager,
    packageManager: new DefaultPackageManager({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
    }),
  };
}

export async function listPiPackages(packageManager, settingsManager) {
  const errors = drainSettingsErrors(settingsManager);
  const packages = packageManager.listConfiguredPackages().map((entry) => ({
    source: entry.source,
    scope: publicScope(entry.scope),
    filtered: entry.filtered,
    missing: !entry.installedPath,
    ...(entry.installedPath ? { installedPath: entry.installedPath } : {}),
  }));
  const resolved = await packageManager.resolve(async () => "skip");
  return {
    packages,
    resources: {
      extensions: resolved.extensions.map(publicResource),
      skills: resolved.skills.map(publicResource),
      prompts: resolved.prompts.map(publicResource),
      themes: resolved.themes.map(publicResource),
    },
    errors,
  };
}

export async function mutatePiPackage(packageManager, settingsManager, action, input) {
  if (!["install", "remove", "update"].includes(action)) {
    throw new Error("Unsupported package action");
  }
  const scope = normalizeScope(input?.scope);
  const source = normalizeSource(input?.source);
  const initialErrors = drainSettingsErrors(settingsManager);
  if (initialErrors.length > 0) {
    throw new Error(`Cannot change packages while settings are invalid: ${initialErrors.join("; ")}`);
  }
  if (scope === "project" && !settingsManager.isProjectTrusted()) {
    throw new Error("Project is not trusted; refusing to access project package storage");
  }

  const managerScope = scope === "global" ? "user" : "project";
  const options = { local: scope === "project" };
  if (action !== "install") {
    const configured = packageManager.listConfiguredPackages().some(
      (entry) => entry.scope === managerScope && entry.source === source,
    );
    if (!configured) throw new Error(`Package is not configured in ${scope} scope: ${source}`);
  }

  if (action === "install") await packageManager.installAndPersist(source, options);
  else if (action === "remove") {
    const removed = await packageManager.removeAndPersist(source, options);
    if (!removed) throw new Error(`Package is not configured in ${scope} scope: ${source}`);
  }
  else await packageManager.install(source, options);

  await settingsManager.flush();
  const errors = drainSettingsErrors(settingsManager);
  if (errors.length > 0) throw new Error(`Package ${action} failed: ${errors.join("; ")}`);
  return { source, scope, reloadRequired: true };
}

export function readMcpCapability(piVersion) {
  return {
    available: false,
    reason: `Tau has no MCP adapter for Pi ${piVersion}; MCP cannot be managed from the browser.`,
  };
}
