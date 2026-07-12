import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/composer-state.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const mirrorSource = await readFile(new URL('../extensions/mirror-server.ts', import.meta.url), 'utf8');
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

test('branch previews are independently read-only without changing the active-session flag', () => {
  assert.deepEqual(
    getComposerState({
      isMirrorMode: true,
      viewingActiveSession: true,
      isLaunchingNewSession: false,
      previewingBranch: true,
    }),
    { disabled: true, placeholder: 'Previewing branch (read-only)', readOnly: true },
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

test('a relayed branch draft is filled from the exact one-shot mirror field without sending', () => {
  assert.match(appSource, /Object\.hasOwn\(data, 'initialDraft'\)\) applyComposerDraft\(data\.initialDraft\)/);
  assert.match(appSource, /function applyComposerDraft\(draft\)[\s\S]*messageInput\.value = draft;[\s\S]*dispatchEvent\(new Event\('input'\)\)/);
  assert.doesNotMatch(appSource, /initialDraft[\s\S]{0,120}(sendMessage|requestRpc)/);
  assert.match(appSource, /if \(typeof draft === 'string'\) body\.draft = draft/);
});

test('the initial draft snapshot is synchronous and consumed only after send', () => {
  const connection = mirrorSource.slice(mirrorSource.indexOf('wss.on("connection"'), mirrorSource.indexOf('const closeProtocolError'));
  assert.doesNotMatch(mirrorSource, /async function buildStateSnapshot/);
  assert.doesNotMatch(connection, /buildStateSnapshot\(latestCtx\)\.then/);
  assert.ok(connection.indexOf('const snapshot = buildStateSnapshot(latestCtx)') < connection.indexOf('const initialDraft = pendingInitialDraft'));
  assert.ok(connection.indexOf('if (sendTo(ws') < connection.indexOf('pendingInitialDraft = undefined'));
});

test('branch preview hides durable actions and Back restores the full current history', () => {
  assert.match(appSource, /renderSessionHistory\(entries, \{ trackUsage: false, entryActions: false \}\)/);
  assert.match(appSource, /function leaveBranchPreview\(\)[\s\S]*renderSessionHistoryOrWelcome\(currentSessionEntries\)/);
  assert.match(appSource, /previewingBranch: Boolean\(branchPreview\)/);
});

test('persisted branch operations choose trust before creating a branch file', () => {
  const operation = appSource.slice(
    appSource.indexOf('async function performSessionOperation'),
    appSource.indexOf('async function handleMessageEntryAction'),
  );
  assert.ok(operation.indexOf('chooseSessionLaunchTrustMode()') < operation.indexOf('requestSessionOperation(operation'));
  assert.match(operation, /path\.slice\(0, -1\)\.some[\s\S]*role === 'assistant'/);
  assert.match(operation, /operation !== 'fork' \|\| hasAssistantAncestor/);
  assert.doesNotMatch(operation, /unavailable parent branch/);
});
