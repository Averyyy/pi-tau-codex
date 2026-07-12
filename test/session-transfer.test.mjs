import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/session-transfer.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const moduleSource = source.replace(
  "import { copyText } from './session-actions.js';",
  'const copyText = async () => {};',
);
const {
  createSessionShare,
  createSessionTransfer,
  importProjectOptions,
  inspectSessionImport,
  installSessionImport,
  requestImportProjects,
  requestShareCapability,
  shareUnavailableMessage,
} = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);

function jsonResponse(data, ok = true) {
  return { ok, json: async () => data };
}

test('import uses two raw JSONL request contracts without guessing a project', async () => {
  const file = { name: 'session.jsonl' };
  const calls = [];
  const mutationFetch = async (...args) => {
    calls.push(args);
    return jsonResponse({ id: 'session-1', entryCount: 3, cwd: '/repo', requiresProject: false });
  };

  await inspectSessionImport(file, mutationFetch);
  await installSessionImport(file, '/repo with spaces', mutationFetch);
  await installSessionImport(file, undefined, mutationFetch);

  assert.equal(calls[0][0], '/api/sessions/import/inspect');
  assert.equal(calls[1][0], '/api/sessions/import/install?projectPath=%2Frepo%20with%20spaces');
  assert.equal(calls[2][0], '/api/sessions/import/install');
  for (const [, init] of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-ndjson');
    assert.equal(init.body, file);
  }
});

test('missing cwd options come only from exact project and task paths', async () => {
  let request;
  const projects = await requestImportProjects(async (...args) => {
    request = args;
    return jsonResponse({
      projects: [{ name: 'Tau', path: '/repo/tau' }, { path: '/repo/plain' }, { name: 'bad' }],
      taskPath: '/tasks',
    });
  });
  assert.deepEqual(request, ['/api/projects']);
  assert.deepEqual(importProjectOptions(projects), [
    { path: '/repo/tau', label: 'Tau - /repo/tau' },
    { path: '/repo/plain', label: 'Project - /repo/plain' },
    { path: '/tasks', label: 'No project - /tasks' },
  ]);
});

test('share capability and creation use exact GET and mutation contracts', async () => {
  const fetches = [];
  const mutations = [];
  assert.deepEqual(await requestShareCapability(async (...args) => {
    fetches.push(args);
    return jsonResponse({ available: true });
  }), { available: true });
  assert.deepEqual(await createSessionShare('/tmp/a b.jsonl', async (...args) => {
    mutations.push(args);
    return jsonResponse({ url: 'https://gist.github.com/example/123' });
  }), { url: 'https://gist.github.com/example/123' });

  assert.deepEqual(fetches, [['/api/share/capability']]);
  assert.equal(mutations[0][0], '/api/share');
  assert.equal(mutations[0][1].method, 'POST');
  assert.equal(mutations[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(mutations[0][1].body), { sessionFile: '/tmp/a b.jsonl' });
});

test('typed share failures preserve fallback metadata and readable capability states', async () => {
  await assert.rejects(
    createSessionShare('/tmp/session.jsonl', async () => jsonResponse({
      error: 'GitHub authentication expired',
      code: 'GH_UNAUTHENTICATED',
      fallback: 'html_download',
    }, false)),
    (error) => {
      assert.equal(error.code, 'GH_UNAUTHENTICATED');
      assert.equal(error.fallback, 'html_download');
      return true;
    },
  );
  assert.equal(shareUnavailableMessage({ code: 'GH_MISSING' }), 'GitHub CLI is not installed');
  assert.equal(shareUnavailableMessage({ code: 'GH_UNAUTHENTICATED' }), 'GitHub CLI is not signed in');
  assert.equal(shareUnavailableMessage({ code: 'NEW_CODE' }), 'NEW_CODE');
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
}

function shareHarness({ capability, shareResponse = null }) {
  const body = new FakeElement('body');
  const statuses = [];
  const mutations = [];
  const downloads = [];
  const transfer = createSessionTransfer({
    openPanel: () => ({
      body,
      close() {},
      isCurrent: () => true,
      setStatus: (...args) => statuses.push(args),
    }),
    mutationFetch: async (...args) => {
      mutations.push(args);
      return shareResponse || jsonResponse({ url: 'https://gist.github.com/example/123' });
    },
    onImport: async () => {},
    onDownloadHtml: async (context) => { downloads.push(context); },
    fetchImpl: async () => jsonResponse(capability),
    clipboard: null,
    documentRef: { createElement: (tagName) => new FakeElement(tagName) },
    openUrl() {},
  });
  return { body, downloads, mutations, statuses, transfer };
}

test('share creates a gist only after the explicit button click', async () => {
  const harness = shareHarness({ capability: { available: true } });
  await harness.transfer.openShare({ sessionFile: '/tmp/session.jsonl' });
  const actions = harness.body.children[0].children[1];
  const create = actions.children[0];
  assert.equal(create.textContent, 'Create secret gist');
  assert.equal(harness.mutations.length, 0);

  await create.listeners.click();
  assert.equal(harness.mutations.length, 1);
  assert.equal(actions.children[0].children[0].textContent, 'https://gist.github.com/example/123');
});

test('capability and typed race failures expose an explicit HTML download action', async () => {
  const context = { sessionFile: '/tmp/session.jsonl' };
  const missing = shareHarness({
    capability: { available: false, code: 'GH_MISSING', fallback: 'html_download' },
  });
  await missing.transfer.openShare(context);
  const missingActions = missing.body.children[0].children[1];
  assert.equal(missing.statuses.at(-1)[0], 'GitHub CLI is not installed');
  assert.equal(missingActions.children[0].textContent, 'Download HTML');
  await missingActions.children[0].listeners.click();
  assert.deepEqual(missing.downloads, [context]);
  assert.equal(missing.mutations.length, 0);

  const raced = shareHarness({
    capability: { available: true },
    shareResponse: jsonResponse({
      error: 'GitHub is no longer authenticated',
      code: 'GH_UNAUTHENTICATED',
      fallback: 'html_download',
    }, false),
  });
  await raced.transfer.openShare(context);
  const racedActions = raced.body.children[0].children[1];
  await racedActions.children[0].listeners.click();
  assert.equal(racedActions.children[0].textContent, 'Download HTML');
});

test('app wiring keeps trust before the single install and exposes both slash commands', () => {
  const flow = appSource.slice(
    appSource.indexOf('async function importAndOpenSession'),
    appSource.indexOf('async function downloadSessionHtml'),
  );
  const trust = flow.indexOf('await chooseSessionLaunchTrustMode()');
  const cancelled = flow.indexOf('if (sessionClosed || !trustMode) return false');
  const installed = flow.indexOf('await installSessionImport(');
  const launched = flow.indexOf('await launchSessionInstance(');
  assert.ok(trust >= 0 && trust < cancelled && cancelled < installed && installed < launched);
  assert.equal(flow.match(/installSessionImport\(/g)?.length, 1);
  assert.match(flow, /sessionActions\.close\(\)/);

  assert.match(appSource, /\{ name: 'import',[^\n]+execution: 'web'/);
  assert.match(appSource, /\{ name: 'share',[^\n]+execution: 'web'/);
  assert.match(appSource, /import: \{ mode: 'web', enabled: true, label: 'web' \}/);
  assert.match(appSource, /share: \{ mode: 'web', enabled: true, label: 'web' \}/);
  assert.match(appSource, /if \(name === 'import'\)[\s\S]*sessionTransfer\.openImport\(\)/);
  assert.match(appSource, /if \(name === 'share'\)[\s\S]*sessionTransfer\.openShare\(context\)/);
  assert.match(indexSource, /id="import-session-btn"[^>]+aria-label="Import session"/);
  assert.match(source, /input\.accept = '\.jsonl'/);
  assert.match(source, /input\.setAttribute\('aria-label', 'JSONL session file'\)/);
  assert.match(styleSource, /\.session-transfer-view \.dialog-actions button,\s+\.session-transfer-action,\s+\.session-transfer-result button \{ min-height: 44px; \}/);

  const submitFlow = source.slice(
    source.indexOf("form.addEventListener('submit'"),
    source.indexOf('input.focus()'),
  );
  assert.doesNotMatch(submitFlow, /submit\.disabled = false/);
});
