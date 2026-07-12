import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelRefsForSave,
  providerActionAccessibleName,
} from '../public/settings-parity.js';

test('provider actions have provider-specific accessible names', () => {
  const openai = providerActionAccessibleName('Sign in with API key', { name: 'OpenAI', id: 'openai' });
  const anthropic = providerActionAccessibleName('Sign in with API key', { name: 'Anthropic', id: 'anthropic' });
  assert.equal(openai, 'Sign in with API key OpenAI (openai)');
  assert.notEqual(openai, anthropic);
});

test('empty exact selections require a preserved Pi pattern', () => {
  assert.throws(() => modelRefsForSave(new Set(), 0), /Select at least one model/);
  assert.deepEqual(modelRefsForSave(new Set(), 1), []);
  assert.deepEqual(modelRefsForSave(new Set(['openai/gpt-5']), 0), ['openai/gpt-5']);
});
