import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/message-renderer.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const moduleSource = source.replace("import { renderMarkdown, renderUserMarkdown, sanitizeImageSource } from './markdown.js';", `
const renderMarkdown = (value) => value;
const renderUserMarkdown = (value) => value;
const sanitizeImageSource = (value) => value;
`);
const { hasDurableEntryActions, rawMessageText } = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`,
);

test('only persisted history entries receive durable actions', () => {
  const entry = { entryId: 'user-1', parentId: 'assistant-0', message: { content: 'prompt' } };
  assert.equal(hasDurableEntryActions(true, entry), true);
  assert.equal(hasDurableEntryActions(false, entry), false);
  assert.equal(hasDurableEntryActions(true, { ...entry, entryId: null }), false);
});

test('message actions preserve and copy exact raw text blocks', () => {
  assert.equal(rawMessageText({ content: 'exact\ntext' }), 'exact\ntext');
  assert.equal(rawMessageText({ content: [
    { type: 'text', text: 'first' },
    { type: 'image', data: 'ignored' },
    { type: 'text', text: 'second' },
  ] }), 'firstsecond');
  assert.match(appSource, /\{ entryId: entry\.id, parentId: entry\.parentId, message: entry\.message \}/);
  assert.match(source, /setAttribute\('role', 'menu'\)/);
  assert.match(source, /setAttribute\('role', 'menuitem'\)/);
  assert.match(source, /'Continue from here'/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /event\.key === 'ArrowDown'/);
  assert.match(source, /event\.key === 'ArrowUp'/);
  assert.match(source, /event\.key === 'Home'/);
  assert.match(source, /event\.key === 'End'/);
  assert.match(source, /\(index \+ 1\) % items\.length/);
  assert.match(source, /\(index - 1 \+ items\.length\) % items\.length/);
});
