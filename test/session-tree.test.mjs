import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/session-tree.js', import.meta.url), 'utf8');
const {
  flattenSessionTree,
  requestSessionOperation,
  requestSessionTree,
  sessionEntryPath,
  sessionTreePath,
  setSessionEntryLabel,
  treeEntryTitle,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function node(entry, children = [], label) {
  return { entry, children, ...(label === undefined ? {} : { label }) };
}

test('tree loading and operations use the exact HTTP contracts', async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => ({ roots: [] }) };
  };
  await requestSessionTree('/tmp/a b.jsonl', fetchImpl);
  await requestSessionOperation('fork', {
    sessionFile: '/tmp/a.jsonl',
    entryId: 'user-1',
  }, fetchImpl);
  await requestSessionOperation('duplicate', {
    sessionFile: '/tmp/a.jsonl',
  }, fetchImpl);

  assert.equal(calls[0][0], '/api/session-tree?sessionFile=%2Ftmp%2Fa%20b.jsonl');
  assert.equal(calls[1][0], '/api/session-ops/fork');
  assert.deepEqual(JSON.parse(calls[1][1].body), { sessionFile: '/tmp/a.jsonl', entryId: 'user-1' });
  assert.equal(calls[2][0], '/api/session-ops/duplicate');
  assert.deepEqual(JSON.parse(calls[2][1].body), { sessionFile: '/tmp/a.jsonl' });
});

test('active labels use WS with the exact session while historical labels use HTTP', async () => {
  const requests = [];
  const fetches = [];
  const request = async (command) => {
    requests.push(command);
    return { data: { entryId: command.entryId, label: command.label } };
  };
  const mutationFetch = async (...args) => {
    fetches.push(args);
    return { ok: true, json: async () => ({ entryId: 'entry-1', label: null }) };
  };

  await setSessionEntryLabel({
    active: true,
    sessionFile: '/tmp/live.jsonl',
    entryId: 'entry-1',
    label: 'focus',
    request,
    mutationFetch,
  });
  await setSessionEntryLabel({
    active: false,
    sessionFile: '/tmp/old.jsonl',
    entryId: 'entry-1',
    label: null,
    request,
    mutationFetch,
  });

  assert.deepEqual(requests, [{
    type: 'set_entry_label',
    sessionFile: '/tmp/live.jsonl',
    entryId: 'entry-1',
    label: 'focus',
  }]);
  assert.equal(fetches[0][0], '/api/session-ops/label');
  assert.deepEqual(JSON.parse(fetches[0][1].body), {
    sessionFile: '/tmp/old.jsonl',
    entryId: 'entry-1',
    label: null,
  });
});

test('iterative flatten preserves Pi order, full bookkeeping topology, roots, and orphans', () => {
  const first = node({ id: 'root', parentId: null, type: 'message', message: { role: 'user', content: 'one' } }, [
    node({ id: 'label', parentId: 'root', type: 'label', targetId: 'root', label: 'named' }, [
      node({ id: 'compact', parentId: 'label', type: 'compaction', summary: 'summary' }),
    ]),
  ], 'named');
  const orphan = node({ id: 'orphan', parentId: 'missing', type: 'branch_summary', summary: 'other root' });
  const selfRoot = node({ id: 'self', parentId: 'self', type: 'custom', customType: 'legacy-root' });
  const flat = flattenSessionTree([first, orphan, selfRoot]);

  assert.deepEqual(flat.map(({ entry, depth, orphan: isOrphan }) => [entry.id, depth, isOrphan]), [
    ['root', 1, false],
    ['label', 2, false],
    ['compact', 3, false],
    ['orphan', 1, true],
    ['self', 1, false],
  ]);
  assert.equal(flat[0].label, 'named');

  let deep = node({ id: 'deep-0', parentId: null, type: 'session_info' });
  let cursor = deep;
  for (let index = 1; index < 5000; index += 1) {
    const child = node({ id: `deep-${index}`, parentId: `deep-${index - 1}`, type: 'custom', customType: 'state' });
    cursor.children.push(child);
    cursor = child;
  }
  assert.equal(flattenSessionTree([deep]).length, 5000);
});

test('branch paths follow exact parent structure and flat entry IDs', () => {
  const roots = [node({ id: 'a', parentId: null, type: 'session_info' }, [
    node({ id: 'b', parentId: 'a', type: 'label', label: 'x' }, [
      node({ id: 'c', parentId: 'b', type: 'message', message: { role: 'user', content: 'go' } }),
    ]),
  ])];
  assert.deepEqual(sessionTreePath(roots, 'c').map((entry) => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(sessionEntryPath([
    roots[0].entry,
    roots[0].children[0].entry,
    roots[0].children[0].children[0].entry,
  ], 'c').map((entry) => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(sessionEntryPath([
    { id: 'self', parentId: 'self', type: 'model_change' },
    { id: 'user', parentId: 'self', type: 'message', message: { role: 'user', content: 'go' } },
  ], 'user').map((entry) => entry.id), ['self', 'user']);
  assert.deepEqual(sessionEntryPath([
    { id: 'orphan-root', parentId: 'missing', type: 'compaction', summary: 'older history' },
    { id: 'assistant', parentId: 'orphan-root', type: 'message', message: { role: 'assistant', content: [] } },
    { id: 'orphan-user', parentId: 'assistant', type: 'message', message: { role: 'user', content: 'continue' } },
  ], 'orphan-user').map((entry) => entry.id), ['orphan-root', 'assistant', 'orphan-user']);
});

test('tree titles expose compaction, branch summaries, and bookkeeping rows', () => {
  assert.equal(treeEntryTitle({ type: 'compaction', summary: 'trimmed context' }), 'compaction: trimmed context');
  assert.equal(treeEntryTitle({ type: 'branch_summary', summary: 'older work' }), 'branch summary: older work');
  assert.equal(treeEntryTitle({ type: 'label', label: 'review' }), 'label: review');
  assert.equal(treeEntryTitle({ type: 'custom', customType: 'extension-state' }), 'custom: extension-state');
  assert.match(source, /setAttribute\('role', 'tree'\)/);
  assert.match(source, /setAttribute\('role', 'treeitem'\)/);
  assert.match(source, /'Preview branch'/);
  assert.match(source, /'Open as new task'/);
  assert.match(source, /'Edit & fork'/);
  assert.doesNotMatch(source, /maxLength\s*=\s*200/);
  assert.match(source, /await open\(selectedId, true\)/);
});
