import fs from "node:fs";
import path from "node:path";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function settingsErrors(settingsManager) {
  return settingsManager.drainErrors().map(({ scope, error }) => `${scope}: ${errorMessage(error)}`);
}

function modelKey(model) {
  return `${model.provider}/${model.id}`;
}

function listModels(modelRegistry) {
  const seen = new Set();
  return modelRegistry.getAll().filter((model) => {
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveStoredPatterns(modelRegistry, patterns, resolveModelScopeWithDiagnostics) {
  const selected = new Set();
  const preservedPatterns = [];
  const diagnostics = [];

  for (const pattern of patterns) {
    const result = await resolveModelScopeWithDiagnostics([pattern], modelRegistry);
    if (result.scopedModels.length === 0) preservedPatterns.push(pattern);
    for (const { model } of result.scopedModels) selected.add(modelKey(model));
    diagnostics.push(...result.diagnostics);
  }

  return { selected, preservedPatterns, diagnostics };
}

export function createContextSettingsManager(SettingsManager, ctx, agentDir) {
  return SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
}

export function readProviderAccounts(modelRegistry) {
  const authStorage = modelRegistry.authStorage;
  authStorage.reload();
  const errors = [...new Set(authStorage.drainErrors().map(errorMessage))];
  const models = listModels(modelRegistry);
  const modelProviders = new Set(models.map((model) => model.provider));
  const availableProviders = new Set(models
    .filter((model) => modelRegistry.hasConfiguredAuth(model))
    .map((model) => model.provider));
  const oauthProviders = new Set(authStorage.getOAuthProviders().map((provider) => provider.id));
  const providerIds = new Set([...modelProviders, ...oauthProviders, ...authStorage.list()]);

  const providers = [...providerIds].map((id) => {
    const auth = modelRegistry.getProviderAuthStatus(id);
    const stored = authStorage.has(id);
    const available = availableProviders.has(id);
    return {
      id,
      name: modelRegistry.getProviderDisplayName(id),
      supportsOAuth: oauthProviders.has(id),
      supportsApiKey: modelProviders.has(id),
      canSignOut: stored,
      status: errors.length > 0
        ? "error"
        : stored
          ? "signed_in"
          : available
            ? "available"
            : "not_configured",
      ...(auth.source ? { source: auth.source } : {}),
      ...(auth.label ? { label: auth.label } : {}),
      ...(errors.length > 0 ? { error: errors[0] } : {}),
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return { providers, errors };
}

export async function readEnabledModelScope(
  modelRegistry,
  settingsManager,
  resolveModelScopeWithDiagnostics,
) {
  const models = listModels(modelRegistry).filter((model) => modelRegistry.hasConfiguredAuth(model));
  const globalSettings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();
  const patterns = Array.isArray(globalSettings.enabledModels) ? globalSettings.enabledModels : undefined;
  const projectOverride = Object.hasOwn(projectSettings, "enabledModels");
  const projectPatterns = Array.isArray(projectSettings.enabledModels) ? projectSettings.enabledModels : [];
  const effectivePatterns = projectOverride ? projectPatterns : patterns;
  const mode = effectivePatterns === undefined || effectivePatterns.length === 0 ? "all" : "selected";
  const globalResolved = await resolveStoredPatterns(
    modelRegistry,
    patterns || [],
    resolveModelScopeWithDiagnostics,
  );
  const effectiveResolved = projectOverride
    ? await resolveStoredPatterns(modelRegistry, projectPatterns, resolveModelScopeWithDiagnostics)
    : globalResolved;

  return {
    mode,
    models: models.map((model) => ({
      provider: model.provider,
      providerName: modelRegistry.getProviderDisplayName(model.provider),
      id: model.id,
      name: model.name,
      ref: modelKey(model),
      selected: mode === "selected" && effectiveResolved.selected.has(modelKey(model)),
    })).sort((left, right) =>
      left.providerName.localeCompare(right.providerName) || left.id.localeCompare(right.id)),
    patterns: patterns || [],
    preservedPatterns: globalResolved.preservedPatterns,
    diagnostics: globalResolved.diagnostics,
    effectivePatterns: effectivePatterns || [],
    effectivePreservedPatterns: effectiveResolved.preservedPatterns,
    projectOverride,
    projectPatterns,
    errors: settingsErrors(settingsManager),
  };
}

export async function isModelInEffectiveScope(
  modelRegistry,
  settingsManager,
  model,
  resolveModelScopeWithDiagnostics,
) {
  const patterns = settingsManager.getEnabledModels();
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, modelRegistry);
  const ref = modelKey(model);
  return scopedModels.some(({ model: candidate }) => modelKey(candidate) === ref);
}

export async function validateDefaultModelSelection(
  modelRegistry,
  settingsManager,
  provider,
  modelId,
  resolveModelScopeWithDiagnostics,
) {
  const model = modelRegistry.getAll()
    .find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw new Error(`Model does not exist: ${provider}/${modelId}`);
  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Model is not available: ${provider}/${modelId}`);
  }
  if (!await isModelInEffectiveScope(
    modelRegistry,
    settingsManager,
    model,
    resolveModelScopeWithDiagnostics,
  )) {
    throw new Error(`Model is outside the effective enabledModels scope: ${provider}/${modelId}`);
  }
  return model;
}

export async function writeEnabledModelScope(
  modelRegistry,
  settingsManager,
  mode,
  modelRefs,
  resolveModelScopeWithDiagnostics,
) {
  if (mode !== "all" && mode !== "selected") {
    throw new Error('mode must be "all" or "selected"');
  }
  if (!Array.isArray(modelRefs) || modelRefs.some((value) => typeof value !== "string")) {
    throw new Error("modelRefs must be an array of provider/id strings");
  }
  if (Object.hasOwn(settingsManager.getProjectSettings(), "enabledModels")) {
    throw new Error(
      "Project .pi/settings.json overrides enabledModels. Remove that project override before saving the global model scope in Tau.",
    );
  }
  if (mode === "all") {
    settingsManager.setEnabledModels(undefined);
    await settingsManager.flush();
    const errors = settingsErrors(settingsManager);
    if (errors.length > 0) throw new Error(`Failed to save enabled models: ${errors.join("; ")}`);
    return readEnabledModelScope(modelRegistry, settingsManager, resolveModelScopeWithDiagnostics);
  }

  const known = new Set(listModels(modelRegistry)
    .filter((model) => modelRegistry.hasConfiguredAuth(model))
    .map(modelKey));
  const selected = [...new Set(modelRefs)];
  const unknown = selected.find((ref) => !known.has(ref));
  if (unknown) throw new Error(`Model is not available: ${unknown}`);

  const globalPatterns = settingsManager.getGlobalSettings().enabledModels;
  const { preservedPatterns: preserved } = await resolveStoredPatterns(
    modelRegistry,
    Array.isArray(globalPatterns) ? globalPatterns : [],
    resolveModelScopeWithDiagnostics,
  );
  if (selected.length === 0 && preserved.length === 0) {
    throw new Error("Select at least one model when no preserved Pi model patterns remain");
  }
  const patterns = [...preserved, ...selected];
  settingsManager.setEnabledModels(patterns);
  await settingsManager.flush();
  const errors = settingsErrors(settingsManager);
  if (errors.length > 0) throw new Error(`Failed to save enabled models: ${errors.join("; ")}`);

  return readEnabledModelScope(modelRegistry, settingsManager, resolveModelScopeWithDiagnostics);
}

export function parseChangelog(markdown) {
  const headings = [...markdown.matchAll(/^## \[([^\]]+)](?: - (.+))?$/gm)];
  return headings.map((heading, index) => ({
    version: heading[1],
    date: heading[2] || "",
    body: markdown.slice(
      heading.index + heading[0].length,
      headings[index + 1]?.index ?? markdown.length,
    ).trim(),
  }));
}

export function readAboutInfo({ piVersion, piPackageDir, tauPackageJsonPath }) {
  const tauPackage = JSON.parse(fs.readFileSync(tauPackageJsonPath, "utf8"));
  const changelog = fs.readFileSync(path.join(piPackageDir, "CHANGELOG.md"), "utf8");
  return {
    piVersion,
    tauVersion: tauPackage.version,
    changelog: parseChangelog(changelog),
  };
}
