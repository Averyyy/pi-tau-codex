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

test('a session context menu dismisses and suppresses the hover card', () => {
  let hidden = false;
  const sidebar = {
    contextMenu: null,
    hideSessionHoverCard: () => { hidden = true; },
    closeContextMenu: () => {},
    isFavourite: () => false,
    toggleFavourite: () => {},
    deleteSession: () => {},
    positionContextMenu: () => {},
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      appendChild: () => {},
      addEventListener: () => {},
      set className(value) {},
      set innerHTML(value) {},
    }),
  };

  try {
    SessionSidebar.prototype.showContextMenu.call(sidebar, { preventDefault: () => {} }, { filePath: 'session.jsonl' });
    assert.equal(hidden, true);

    sidebar.contextMenu = {};
    SessionSidebar.prototype.showSessionHoverCard.call(sidebar, null, '', '', null, false);
  } finally {
    globalThis.document = originalDocument;
  }
});
