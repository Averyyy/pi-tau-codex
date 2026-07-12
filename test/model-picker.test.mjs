import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('model picker defaults to available scoped models and expands to logged-in models', () => {
  assert.match(appSource, /const loggedInModels = availableModels\.filter\(isModelAvailable\)/);
  assert.match(appSource, /const availableScopedModels = scopedModels\.filter\(isModelAvailable\)/);
  assert.match(appSource, /let showAllModels = availableScopedModels\.length === 0/);
  assert.match(appSource, /showAllModels \? loggedInModels : scopedWithCurrent/);
  assert.match(appSource, /showAllModels \? 'Show scoped models' : `Show all models \(\$\{loggedInModels\.length\}\)`/);
  assert.doesNotMatch(appSource, /Show unavailable models/);
  assert.doesNotMatch(appSource, /includeUnavailable/);
});
