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

export function createContextSettingsManager(SettingsManager, ctx, agentDir) {
  return SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
}

export function readProviderAccounts(modelRegistry) {
  const authStorage = modelRegistry.authStorage;
  authStorage.reload();
  const errors = [...new Set(authStorage.drainErrors().map(errorMessage))];
  const modelProviders = new Set(listModels(modelRegistry).map((model) => model.provider));
  const oauthProviders = new Set(authStorage.getOAuthProviders().map((provider) => provider.id));
  const providerIds = new Set([...modelProviders, ...oauthProviders, ...authStorage.list()]);

  const providers = [...providerIds].map((id) => {
    const auth = modelRegistry.getProviderAuthStatus(id);
    return {
      id,
      name: modelRegistry.getProviderDisplayName(id),
      supportsOAuth: oauthProviders.has(id),
      supportsApiKey: modelProviders.has(id),
      canSignOut: authStorage.has(id),
      status: errors.length > 0 ? "error" : auth.configured ? "signed_in" : "not_configured",
      ...(auth.source ? { source: auth.source } : {}),
      ...(auth.label ? { label: auth.label } : {}),
      ...(errors.length > 0 ? { error: errors[0] } : {}),
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return { providers, errors };
}

export function readEnabledModelScope(modelRegistry, settingsManager) {
  const models = listModels(modelRegistry);
  const globalSettings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();
  const patterns = Array.isArray(globalSettings.enabledModels) ? globalSettings.enabledModels : undefined;
  const projectOverride = Object.hasOwn(projectSettings, "enabledModels");
  const projectPatterns = Array.isArray(projectSettings.enabledModels) ? projectSettings.enabledModels : [];
  const explicit = new Set(patterns || []);
  const unscoped = patterns === undefined || patterns.length === 0;
  const known = new Set(models.map(modelKey));

  return {
    models: models.map((model) => ({
      provider: model.provider,
      providerName: modelRegistry.getProviderDisplayName(model.provider),
      id: model.id,
      name: model.name,
      ref: modelKey(model),
      selected: unscoped || explicit.has(modelKey(model)),
    })).sort((left, right) =>
      left.providerName.localeCompare(right.providerName) || left.id.localeCompare(right.id)),
    patterns: patterns || [],
    preservedPatterns: (patterns || []).filter((pattern) => !known.has(pattern)),
    projectOverride,
    projectPatterns,
    errors: settingsErrors(settingsManager),
  };
}

export async function writeEnabledModelScope(modelRegistry, settingsManager, modelRefs) {
  if (!Array.isArray(modelRefs) || modelRefs.some((value) => typeof value !== "string")) {
    throw new Error("modelRefs must be an array of provider/id strings");
  }
  if (Object.hasOwn(settingsManager.getProjectSettings(), "enabledModels")) {
    throw new Error(
      "Project .pi/settings.json overrides enabledModels. Remove that project override before saving the global model scope in Tau.",
    );
  }
  const known = new Set(listModels(modelRegistry).map(modelKey));
  const selected = [...new Set(modelRefs)];
  const unknown = selected.find((ref) => !known.has(ref));
  if (unknown) throw new Error(`Unknown model: ${unknown}`);

  const globalPatterns = settingsManager.getGlobalSettings().enabledModels;
  const preserved = (Array.isArray(globalPatterns) ? globalPatterns : [])
    .filter((pattern) => !known.has(pattern));
  if (selected.length === 0 && preserved.length === 0) {
    throw new Error("Select at least one model when no preserved Pi model patterns remain");
  }
  const patterns = selected.length === known.size && preserved.length === 0
    ? undefined
    : [...preserved, ...selected];
  settingsManager.setEnabledModels(patterns?.length ? patterns : undefined);
  await settingsManager.flush();
  const errors = settingsErrors(settingsManager);
  if (errors.length > 0) throw new Error(`Failed to save enabled models: ${errors.join("; ")}`);

  return readEnabledModelScope(modelRegistry, settingsManager);
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
