import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/composer-state.js', import.meta.url), 'utf8');
const { getComposerState } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
);

test('live sessions keep the composer enabled', () => {
  assert.deepEqual(
    getComposerState({ isMirrorMode: true, viewingActiveSession: true, isLaunchingNewSession: false }),
    { disabled: false, placeholder: 'Message...', readOnly: false },
  );
});

test('historical mirror sessions keep every composer entry point disabled', () => {
  assert.deepEqual(
    getComposerState({ isMirrorMode: true, viewingActiveSession: false, isLaunchingNewSession: false }),
    { disabled: true, placeholder: 'Viewing historical session (read-only)', readOnly: true },
  );
});

test('new-session launch remains disabled across unrelated UI updates', () => {
  assert.deepEqual(
    getComposerState({ isMirrorMode: false, viewingActiveSession: true, isLaunchingNewSession: true }),
    { disabled: true, placeholder: 'Opening new session...', readOnly: false },
  );
});
