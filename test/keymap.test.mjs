import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/keymap.js', import.meta.url), 'utf8');
const { WEB_KEYMAP, matchShortcut, visibleShortcuts } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
);

test('the frozen web keymap matches exact shortcut scopes and modifiers', () => {
  assert.equal(Object.isFrozen(WEB_KEYMAP), true);
  assert.equal(WEB_KEYMAP.every(Object.isFrozen), true);
  assert.equal(matchShortcut({ key: '/', shiftKey: false }, 'global')?.id, 'commands.focus');
  assert.equal(matchShortcut({ key: 'Enter', shiftKey: false }, 'composer')?.id, 'composer.send');
  assert.equal(matchShortcut({ key: 'Enter', shiftKey: true }, 'composer')?.id, 'composer.newline');
  assert.equal(matchShortcut({ key: '/', shiftKey: false, metaKey: true }, 'global'), null);
});

test('hotkey rows come from the same registry used for dispatch', () => {
  const rows = visibleShortcuts();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((entry) => WEB_KEYMAP.includes(entry)));
  assert.ok(rows.some((entry) => entry.id === 'slash.next'));
});
