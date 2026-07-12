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
  let menu;
  let closeCount = 0;
  const actions = [];
  const sidebar = {
    contextMenu: null,
    hideSessionHoverCard: () => { hidden = true; },
    closeContextMenu: () => { closeCount += 1; },
    isFavourite: () => false,
    toggleFavourite: () => {},
    deleteSession: () => {},
    onSessionAction: (action) => actions.push(action),
    positionContextMenu: (element) => { menu = element; },
    openSessionMenu: SessionSidebar.prototype.openSessionMenu,
  };
  const originalDocument = globalThis.document;
  const elements = [];
  globalThis.document = {
    createElement: (tagName) => {
      const element = {
        tagName,
        children: [],
        attributes: {},
        listeners: {},
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector(selector) {
          return selector === '[role="menuitem"]'
            ? this.children.find((child) => child.attributes?.role === 'menuitem')
            : null;
        },
        querySelectorAll(selector) {
          return selector === '[role="menuitem"]'
            ? this.children.filter((child) => child.attributes?.role === 'menuitem')
            : [];
        },
        focus() { this.focused = true; },
      };
      elements.push(element);
      return element;
    },
  };

  try {
    const session = { filePath: 'session.jsonl', name: 'Named session' };
    SessionSidebar.prototype.showContextMenu.call(
      sidebar,
      { preventDefault: () => {}, clientX: 0, clientY: 0 },
      session,
      { path: '/project' },
    );
    assert.equal(hidden, true);
    assert.equal(menu.attributes.role, 'menu');
    const menuItems = menu.children.filter((child) => child.attributes?.role === 'menuitem');
    assert.deepEqual(menuItems.slice(0, 5).map((item) => item.attributes['aria-label']), [
      'Open Named session',
      'Rename Named session',
      'Duplicate Named session',
      'Export Named session',
      'Info Named session',
    ]);
    menuItems[1].listeners.click({ stopPropagation: () => {} });
    menuItems[2].listeners.click({ stopPropagation: () => {} });
    assert.deepEqual(actions, ['rename', 'duplicate']);

    for (const item of menuItems) item.focused = false;
    let prevented = false;
    menu.listeners.keydown({
      key: 'ArrowDown',
      target: menuItems[0],
      preventDefault: () => { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.equal(menuItems[1].focused, true);

    menu.listeners.keydown({ key: 'ArrowUp', target: menuItems[0], preventDefault: () => {} });
    assert.equal(menuItems.at(-1).focused, true);
    menu.listeners.keydown({ key: 'Home', target: menuItems[3], preventDefault: () => {} });
    assert.equal(menuItems[0].focused, true);
    menu.listeners.keydown({ key: 'End', target: menuItems[0], preventDefault: () => {} });
    assert.equal(menuItems.at(-1).focused, true);
    const closesBeforeEscape = closeCount;
    menu.listeners.keydown({ key: 'Escape', target: menuItems[0], preventDefault: () => {} });
    assert.equal(closeCount, closesBeforeEscape + 1);

    sidebar.contextMenu = {};
    SessionSidebar.prototype.showSessionHoverCard.call(sidebar, null, '', '', null, false);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('a per-row actions button opens the shared menu for mouse, touch, and keyboard clicks', () => {
  const calls = [];
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      attributes: {},
      listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute(name, value) { this.attributes[name] = value; },
      getBoundingClientRect: () => ({ right: 80, bottom: 120 }),
    }),
  };

  try {
    const session = { name: 'Named session', filePath: '/tmp/session.jsonl' };
    const project = { path: '/tmp' };
    const button = SessionSidebar.prototype.createSessionActionsButton.call({
      openSessionMenu: (...args) => calls.push(args),
    }, session, project);
    assert.equal(button.type, 'button');
    assert.equal(button.attributes['aria-label'], 'Actions for Named session');
    assert.equal(button.attributes['aria-haspopup'], 'menu');
    let stopped = false;
    button.listeners.click({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
    assert.deepEqual(calls, [[session, project, 80, 124]]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('preference bootstrap can retry after an initial connection failure', async () => {
  let calls = 0;
  const sidebar = {
    preferencesReady: null,
    bootstrapPreferences: async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection unavailable');
    },
  };

  await assert.rejects(
    SessionSidebar.prototype.ensurePreferencesReady.call(sidebar),
    /connection unavailable/,
  );
  assert.equal(sidebar.preferencesReady, null);
  await SessionSidebar.prototype.ensurePreferencesReady.call(sidebar);
  assert.equal(calls, 2);
});
