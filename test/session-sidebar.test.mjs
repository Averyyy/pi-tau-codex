import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/session-sidebar.js', import.meta.url), 'utf8');
const { SessionSidebar } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
);

test('an empty full-text result removes the previous result group', () => {
  let removed = false;
  SessionSidebar.prototype.renderSearchResults.call({
    _searchResults: [],
    container: {
      querySelector: () => ({ remove: () => { removed = true; } }),
    },
  });
  assert.equal(removed, true);
});
