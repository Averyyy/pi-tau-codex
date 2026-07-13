import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverSource = await readFile(new URL('../extensions/mirror-server.ts', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const webSettingsServer = serverSource.slice(
  serverSource.indexOf('function serveWebSettings'),
  serverSource.indexOf('function handleApiRoute'),
);
const webSettingsClient = appSource.slice(
  appSource.indexOf('async function loadWebSettings'),
  appSource.indexOf('async function openSettings'),
);

test('web settings never return or accept secret and package-shaped settings', () => {
  assert.match(webSettingsServer, /settings: \{\s*defaultProvider:[\s\S]*defaultModel:/);
  assert.doesNotMatch(webSettingsServer, /settingsPath|agentsPath|mcpServers|externalEditor|"packages"/);
  assert.match(webSettingsServer, /Unsupported setting/);
  assert.match(webSettingsServer, /defaultProvider and defaultModel must be updated together/);
  assert.match(webSettingsServer, /validateDefaultModelSelection\(/);
  assert.match(webSettingsServer, /createContextSettingsManager\(/);
  assert.match(webSettingsServer, /resolveModelScopeWithDiagnostics/);
  assert.match(webSettingsServer, /Settings payload must not exceed 1 MiB/);
});

test('default model is one native availability-backed selection', () => {
  assert.match(htmlSource, /<select class="settings-input wide" id="settings-default-model"/);
  assert.doesNotMatch(htmlSource, /settings-default-provider|settings-external-editor|settings-mcp-json|settings-packages-json/);
  assert.match(webSettingsClient, /modelsForDefaultScope\(defaultModelScope \|\| undefined\)[\s\S]*\.find\(\(model\) => model\.ref === selectedRef\)/);
  assert.match(webSettingsClient, /\(unavailable\)/);
  assert.match(webSettingsClient, /authenticated \? 'out of scope' : 'unavailable'/);
  assert.match(webSettingsClient, /defaultModelDraftRef = settingsDefaultModel\.value/);
  assert.match(webSettingsClient, /settingsDefaultModel\.disabled = !settingsReady \|\| !webSettings \|\| !defaultModelScope/);
  assert.match(webSettingsClient, /const loadId = \+\+webSettingsLoadId/);
  assert.match(webSettingsClient, /if \(loadId !== webSettingsLoadId\) return/);
  assert.ok(
    webSettingsClient.indexOf('await settingsParity.save()')
      < webSettingsClient.indexOf('await saveWebSettings()'),
    'model scope must save before the validated default model',
  );
  assert.doesNotMatch(webSettingsClient, /JSON\.parse/);
});

test('settings stay read-only until both web settings and model scope load', () => {
  assert.match(htmlSource, /id="settings-panel-models"[^>]*\binert\b/);
  assert.match(htmlSource, /id="settings-panel-instructions"[^>]*\binert\b/);
  assert.match(htmlSource, /id="settings-agents-md"[^>]*\bdisabled\b/);
  assert.match(htmlSource, /id="settings-save" disabled/);
  assert.match(webSettingsClient, /if \(loadId !== webSettingsLoadId\) return false/);
  assert.match(webSettingsClient, /Promise\.all\(\[loadWebSettings\(loadId\), modelScopeLoaded\]\)/);
  assert.match(webSettingsClient, /void packageSettings\.load\(\)/);
  assert.match(appSource, /settingsModelsPanel\.inert = !settingsReady/);
  assert.match(appSource, /settingsAgentsMd\.disabled = !settingsReady/);
  assert.match(webSettingsClient, /Settings must finish loading before they can be saved/);
});

test('MCP and packages use explicit capability and package RPCs', () => {
  assert.match(htmlSource, /id="settings-mcp-status"/);
  assert.match(htmlSource, /id="settings-packages-list"/);
  assert.match(htmlSource, /Packages &amp; resources/);
});
