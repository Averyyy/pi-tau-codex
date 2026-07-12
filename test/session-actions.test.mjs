import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/session-actions.js', import.meta.url), 'utf8');
const {
  actionTargetsDisplayedSession,
  attachmentFilename,
  copyText,
  downloadBlob,
  exportSession,
  renameSession,
  resolveSessionActionContext,
  requestSessionInfo,
  sessionInfoRows,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('Connect lists the main local URL and the separate LAN URL', () => {
  assert.match(source, /\['Local', health\.mirrorUrl\]/);
  assert.match(source, /\['LAN', health\.lanUrl\]/);
});

test('new-session drafts never fall back to the previous live session', () => {
  assert.equal(resolveSessionActionContext({
    session: null,
    currentSession: null,
    mirrorActiveSessionFile: '/tmp/old.jsonl',
    viewingActiveSession: true,
    isNewSessionMode: true,
  }), null);
});

test('the current unpersisted live session still routes through WebSocket', () => {
  assert.deepEqual(resolveSessionActionContext({
    session: null,
    currentSession: { filePath: null, name: 'Live' },
    mirrorActiveSessionFile: null,
    viewingActiveSession: true,
    isNewSessionMode: false,
  }), {
    active: true,
    sessionFile: null,
    name: 'Live',
    firstMessage: null,
  });
});

test('renaming a different live sidebar session does not replace the displayed history title', () => {
  assert.equal(actionTargetsDisplayedSession({
    sessionFile: '/tmp/live-a.jsonl',
    active: true,
    currentSessionFile: '/tmp/history-b.jsonl',
    viewingActiveSession: false,
  }), false);
  assert.equal(actionTargetsDisplayedSession({
    sessionFile: '/tmp/live-a.jsonl',
    active: true,
    currentSessionFile: '/tmp/live-a.jsonl',
    viewingActiveSession: true,
  }), true);
  assert.equal(actionTargetsDisplayedSession({
    sessionFile: null,
    active: true,
    currentSessionFile: null,
    viewingActiveSession: true,
  }), true);
});

test('active session actions use WebSocket while historical actions use HTTP', async () => {
  const requests = [];
  const fetches = [];
  const request = async (command) => {
    requests.push(command);
    return { data: { sessionId: 'live' } };
  };
  const fetchImpl = async (url) => {
    fetches.push(url);
    return { ok: true, json: async () => ({ sessionId: 'old' }) };
  };

  assert.deepEqual(await requestSessionInfo({ active: true, request }), { sessionId: 'live' });
  assert.deepEqual(
    await requestSessionInfo({ active: false, sessionFile: '/tmp/a b.jsonl', request, fetchImpl }),
    { sessionId: 'old' },
  );
  assert.deepEqual(requests, [{ type: 'get_session_stats' }]);
  assert.deepEqual(fetches, ['/api/sessions/info?sessionFile=%2Ftmp%2Fa%20b.jsonl']);
});

test('historical rename sends the exact session contract', async () => {
  let call;
  await renameSession({
    active: false,
    sessionFile: '/tmp/session.jsonl',
    name: 'Renamed',
    request: async () => assert.fail('should not use WebSocket'),
    mutationFetch: async (...args) => {
      call = args;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(call[0], '/api/sessions/name');
  assert.deepEqual(JSON.parse(call[1].body), {
    sessionFile: '/tmp/session.jsonl',
    name: 'Renamed',
  });
});

test('session info keeps the full token breakdown and unknown context usage', () => {
  const rows = Object.fromEntries(sessionInfoRows({
    tokens: { total: 10, input: 4, output: 2, cacheRead: 3, cacheWrite: 1 },
    cost: { total: 0 },
    contextUsage: { tokens: null, contextWindow: 128000 },
  }));
  assert.deepEqual({
    total: rows['Tokens total'],
    input: rows['Tokens input'],
    output: rows['Tokens output'],
    cacheRead: rows['Cache read'],
    cacheWrite: rows['Cache write'],
    context: rows['Context usage'],
  }, {
    total: 10,
    input: 4,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    context: 'Unknown / 128000',
  });
});

test('export parses attachment names and downloads with guaranteed URL cleanup', async () => {
  const result = await exportSession({
    format: 'jsonl',
    sessionFile: '/tmp/session.jsonl',
    mutationFetch: async () => ({
      ok: true,
      headers: new Headers({ 'Content-Disposition': "attachment; filename*=UTF-8''named%20session.jsonl" }),
      blob: async () => new Blob(['session']),
    }),
  });
  assert.equal(result.filename, 'named session.jsonl');
  assert.equal(attachmentFilename('attachment; filename="plain.html"', 'fallback'), 'plain.html');

  let clicked = false;
  let revoked = '';
  downloadBlob(result.blob, result.filename, {
    documentRef: {
      body: { appendChild: () => {} },
      createElement: () => ({ click: () => { clicked = true; }, remove: () => {} }),
    },
    urlApi: {
      createObjectURL: () => 'blob:session',
      revokeObjectURL: (url) => { revoked = url; },
    },
  });
  assert.equal(clicked, true);
  assert.equal(revoked, 'blob:session');
});

test('copy falls back to the document command when Clipboard API is unavailable', async () => {
  let textarea;
  let command;
  await copyText('https://example.test/gist', {
    clipboard: null,
    documentRef: {
      body: { appendChild: (node) => { textarea = node; } },
      createElement: () => ({
        setAttribute() {},
        select() { this.selected = true; },
        remove() { this.removed = true; },
      }),
      execCommand: (value) => {
        command = value;
        return true;
      },
    },
  });
  assert.equal(textarea.value, 'https://example.test/gist');
  assert.equal(textarea.selected, true);
  assert.equal(textarea.removed, true);
  assert.equal(command, 'copy');
});
