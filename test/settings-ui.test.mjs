import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  modelRefsForSave,
  modelsForDefaultScope,
  providerActionAccessibleName,
  reconcileDefaultModelDraft,
} from '../public/settings-parity.js';

const settingsParitySource = await readFile(
  new URL('../public/settings-parity.js', import.meta.url),
  'utf8',
);
const settingsHtmlSource = await readFile(
  new URL('../public/index.html', import.meta.url),
  'utf8',
);
const settingsCssSource = await readFile(
  new URL('../public/style.css', import.meta.url),
  'utf8',
);
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('provider actions have provider-specific accessible names', () => {
  const openai = providerActionAccessibleName('Sign in with API key', { name: 'OpenAI', id: 'openai' });
  const anthropic = providerActionAccessibleName('Sign in with API key', { name: 'Anthropic', id: 'anthropic' });
  assert.equal(openai, 'Sign in with API key OpenAI (openai)');
  assert.notEqual(openai, anthropic);
});

test('provider auth actions refresh both accounts and available models', () => {
  assert.match(
    settingsParitySource,
    /run_command[\s\S]*Promise\.all\(\[loadProviders\(\), loadModels\(\)\]\)/,
  );
});

test('empty exact selections require a preserved Pi pattern', () => {
  assert.deepEqual(modelRefsForSave('all', new Set(), 0), []);
  assert.throws(() => modelRefsForSave('selected', new Set(), 0), /Select at least one model/);
  assert.deepEqual(modelRefsForSave('selected', new Set(), 1), []);
  assert.deepEqual(modelRefsForSave('selected', new Set(['openai/gpt-5']), 0), ['openai/gpt-5']);
});

test('default model candidates follow saved and unsaved scope state', () => {
  const models = [
    { ref: 'openai/gpt-5' },
    { ref: 'anthropic/claude' },
  ];
  assert.deepEqual(modelsForDefaultScope({ models, mode: 'all' }), models);
  assert.deepEqual(modelsForDefaultScope({
    models,
    mode: 'selected',
    selectedRefs: ['anthropic/claude'],
    dirty: true,
  }), [models[1]]);
});

test('narrowing model scope clears an invalid default only after an explicit scope change', () => {
  const loadedScope = {
    models: [{ ref: 'openai/gpt-5' }],
    mode: 'selected',
    selectedRefs: [],
    dirty: false,
  };
  assert.deepEqual(reconcileDefaultModelDraft({
    configuredRef: 'openai/gpt-5',
    draftRef: 'openai/gpt-5',
    dirty: false,
    scope: loadedScope,
  }), { draftRef: 'openai/gpt-5', dirty: false });

  assert.deepEqual(reconcileDefaultModelDraft({
    configuredRef: 'openai/gpt-5',
    draftRef: 'openai/gpt-5',
    dirty: false,
    scope: { ...loadedScope, dirty: true },
  }), { draftRef: '', dirty: true });
});

test('model scope callback runs after loaded and unsaved selection state changes', () => {
  assert.match(settingsParitySource, /onModelScopeChanged\(\{[\s\S]*selectedRefs: \[\.\.\.selectedModels\][\s\S]*dirty: modelsDirty/);
  assert.match(settingsParitySource, /checkbox\.addEventListener\('change',[\s\S]*notifyModelScope\(\)/);
  assert.match(settingsParitySource, /modelModeSelect\.addEventListener\('change',[\s\S]*notifyModelScope\(\)/);
});

test('hidden settings controls cannot be redisplayed by component layout rules', () => {
  assert.match(settingsCssSource, /\[hidden\],[^{]*\{\s*display:\s*none\s*!important;/);
});

test('model scope copy describes exact materialization and unmatched preservation', () => {
  assert.match(settingsHtmlSource, /stores current matches as exact model entries/);
  assert.match(settingsHtmlSource, /preserves only entries with no available match/);
  assert.doesNotMatch(settingsHtmlSource, /preserved patterns remain unchanged/);
});

test('settings tabs expose standard keyboard tab semantics', () => {
  assert.match(settingsHtmlSource, /id="settings-tabs" role="tablist"/);
  assert.match(settingsHtmlSource, /role="tab" aria-controls="settings-panel-general" aria-selected="true" tabindex="0"/);
  assert.match(settingsHtmlSource, /role="tabpanel" aria-labelledby="settings-tab-models"/);
  assert.match(appSource, /item\.setAttribute\('aria-selected', String\(active\)\)/);
  assert.match(appSource, /event\.key === 'ArrowRight'/);
  assert.match(appSource, /event\.key === 'ArrowLeft'/);
  assert.match(appSource, /event\.key === 'Home'/);
  assert.match(appSource, /event\.key === 'End'/);
  assert.match(appSource, /activateSettingsTab\(next, true\)/);
});

test('settings dialog moves, traps, and restores keyboard focus', () => {
  assert.match(appSource, /\(activeTab \|\| settingsClose\)\.focus\(\)/);
  assert.match(appSource, /if \(!sessionClosed\) settingsBtn\.focus\(\)/);
  assert.match(appSource, /settingsPanel\.addEventListener\('keydown', \(event\) => \{/);
  assert.match(appSource, /if \(event\.key !== 'Tab'\) return/);
  assert.match(appSource, /document\.activeElement === last/);
  assert.match(appSource, /last\.focus\(\)/);
  assert.match(appSource, /first\.focus\(\)/);
});
