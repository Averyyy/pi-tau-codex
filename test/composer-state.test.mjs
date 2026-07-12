import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/composer-state.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const { disableSessionControls, getComposerState } = await import(
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

test('an acknowledged quit keeps the composer permanently closed', () => {
  assert.deepEqual(
    getComposerState({
      isMirrorMode: true,
      viewingActiveSession: true,
      isLaunchingNewSession: false,
      sessionClosed: true,
    }),
    { disabled: true, placeholder: 'Session closed', readOnly: true },
  );
});

test('the final session state disables every existing interactive control', () => {
  const controls = [{ disabled: false }, { disabled: false }, { disabled: false }];
  disableSessionControls({ querySelectorAll: () => controls });
  assert.equal(controls.every((control) => control.disabled), true);
});

test('pending async UI results cannot replace the final session state', () => {
  assert.match(appSource, /if \(!sessionClosed\) messageRenderer\.renderError\(message\)/);
  assert.match(appSource, /const res = await fetch\(`\/api\/sessions\/\$\{sessionPath\}`\);\s+if \(sessionClosed\) return;\s+console\.log\('\[App\] History fetch status:', res\.status\);\s+const data = await res\.json\(\);\s+if \(sessionClosed\) return;/);
  assert.match(appSource, /await sidebar\.loadSessions\(false\);\s+if \(sessionClosed\) return;\s+const exactMatches/);
  assert.match(appSource, /await newSessionProjectLoad;\s+if \(sessionClosed\) return \{ ok: false, error: 'Session closed' \}/);
  assert.match(appSource, /function navigateToInstance\(instance, reused = false\) \{\s+if \(sessionClosed\) return;/);
});

test('every quit alias uses the acknowledged shutdown result', () => {
  assert.match(appSource, /async function executeRegisteredSlashCommand[\s\S]*response\?\.success === true && response\.data\?\.command === 'quit' && response\.data\.status === 'shutdown'[\s\S]*enterSessionClosedState\(\)/);
  assert.doesNotMatch(appSource, /name === 'quit'/);
});
