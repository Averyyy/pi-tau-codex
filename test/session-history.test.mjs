import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/session-history.js', import.meta.url), 'utf8');
const { getSessionHistoryFallback } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
);

test('metadata-only sessions show an empty-state welcome', () => {
  assert.equal(getSessionHistoryFallback(0, null), 'welcome');
});

test('a pending first user message survives an empty mirror snapshot', () => {
  assert.equal(getSessionHistoryFallback(0, 'hello'), 'pending-user');
});

test('visible history never receives an empty-state fallback', () => {
  assert.equal(getSessionHistoryFallback(1, 'hello'), null);
});
