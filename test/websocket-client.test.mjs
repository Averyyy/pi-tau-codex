import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketClient, withMutationToken } from '../public/websocket-client.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSING;
    this.closeEvent = { code, reason };
    if (!this.deferClose) this.finishClose();
  }

  finishClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(this.closeEvent || { code: 1000, reason: '' });
  }
}

globalThis.WebSocket = FakeWebSocket;

function connectedClient() {
  const client = new WebSocketClient('ws://tau.test/ws');
  client.connect();
  client.ws.open();
  client.ws.receive({ type: 'connection_hello', mutationToken: 'token-1' });
  return client;
}

test('request waits for the server connection token before sending', async () => {
  const client = new WebSocketClient('ws://tau.test/ws');
  client.connect();
  client.ws.open();
  assert.throws(() => client.send({ type: 'prompt' }), /token has not arrived/);
  const responsePromise = client.request({ type: 'get_state' });
  assert.equal(client.ws.sent.length, 0);

  client.ws.receive({ type: 'connection_hello', mutationToken: 'token-1' });
  assert.equal(client.ws.sent.length, 1);
  assert.equal(client.ws.sent[0].mutationToken, 'token-1');
  client.disconnect();
  await assert.rejects(responsePromise, /disconnected/);
});

test('HTTP mutations wait for the same live connection token', async () => {
  const client = new WebSocketClient('ws://tau.test/ws');
  const tokenPromise = client.waitForMutationToken();
  client.connect();
  client.ws.open();
  client.ws.receive({ type: 'connection_hello', mutationToken: 'token-1' });
  assert.equal(await tokenPromise, 'token-1');
  client.disconnect();
});

test('request correlates a successful response and attaches the connection token', async () => {
  const client = connectedClient();
  const responsePromise = client.request({ type: 'get_state' });
  const request = client.ws.sent.at(-1);

  assert.equal(request.type, 'get_state');
  assert.equal(request.mutationToken, 'token-1');
  assert.equal(typeof request.id, 'string');

  client.ws.receive({ type: 'response', id: request.id, command: 'get_state', success: true, data: { ok: true } });
  assert.deepEqual(await responsePromise, {
    type: 'response',
    id: request.id,
    command: 'get_state',
    success: true,
    data: { ok: true },
  });
  assert.equal(client.pending.size, 0);
  client.disconnect();
});

test('concurrent requests resolve correctly when responses arrive in reverse order', async () => {
  const client = connectedClient();
  const firstPromise = client.request({ type: 'get_state' });
  const secondPromise = client.request({ type: 'get_messages' });
  const [firstRequest, secondRequest] = client.ws.sent.slice(-2);

  client.ws.receive({
    type: 'response',
    id: secondRequest.id,
    command: 'get_messages',
    success: true,
    data: { order: 2 },
  });
  assert.deepEqual((await secondPromise).data, { order: 2 });
  assert.equal(client.pending.size, 1);

  client.ws.receive({
    type: 'response',
    id: firstRequest.id,
    command: 'get_state',
    success: true,
    data: { order: 1 },
  });
  assert.deepEqual((await firstPromise).data, { order: 1 });
  assert.equal(client.pending.size, 0);
  client.disconnect();
});

test('request rejects server failures without discarding response data', async () => {
  const client = connectedClient();
  const responsePromise = client.request({ type: 'set_model' });
  const request = client.ws.sent.at(-1);
  const response = {
    type: 'response',
    id: request.id,
    command: 'set_model',
    success: false,
    error: 'Sign in required',
    data: { provider: 'example' },
  };

  client.ws.receive(response);
  await assert.rejects(responsePromise, (error) => {
    assert.equal(error.name, 'WebSocketRequestError');
    assert.equal(error.message, 'Sign in required');
    assert.deepEqual(error.response, response);
    return true;
  });
  client.disconnect();
});

test('disconnect rejects every pending request', async () => {
  const client = connectedClient();
  const first = client.request({ type: 'get_state' });
  const second = client.request({ type: 'get_messages' });

  client.disconnect();
  await assert.rejects(first, /disconnected/);
  await assert.rejects(second, /disconnected/);
  assert.equal(client.pending.size, 0);
});

test('disconnect clears security state before an asynchronous socket close', async () => {
  const client = connectedClient();
  client.ws.deferClose = true;
  const pending = client.request({ type: 'get_state' });

  client.disconnect();
  assert.equal(client.mutationToken, null);
  assert.equal(client.pending.size, 0);
  await assert.rejects(pending, /disconnected/);

  client.ws.finishClose();
});

test('request accepts AbortSignal without a default timeout', async () => {
  const client = connectedClient();
  const controller = new AbortController();
  const responsePromise = client.request({ type: 'get_state' }, { signal: controller.signal });

  controller.abort();
  await assert.rejects(responsePromise, { name: 'AbortError' });
  assert.equal(client.pending.size, 0);
  client.disconnect();
});

test('an aborted request drops its late correlated response', async () => {
  const client = connectedClient();
  const controller = new AbortController();
  let legacyResponses = 0;
  client.addEventListener('response', () => { legacyResponses += 1; });
  const responsePromise = client.request({ type: 'get_state' }, { signal: controller.signal });
  const request = client.ws.sent.at(-1);

  controller.abort();
  await assert.rejects(responsePromise, { name: 'AbortError' });
  client.ws.receive({
    type: 'response',
    id: request.id,
    command: 'get_state',
    success: false,
    error: 'late failure',
  });
  assert.equal(legacyResponses, 0);
  client.ws.receive({ type: 'response', id: '', success: false, error: 'late legacy-shaped failure' });
  assert.equal(legacyResponses, 0);
  client.ws.receive({ type: 'response', success: true });
  assert.equal(legacyResponses, 1);
  client.disconnect();
});

test('closed connections reject requests and token waits instead of replaying them', async () => {
  const client = connectedClient();
  client.disconnect();

  await assert.rejects(client.request({ type: 'prompt' }), /not connected/);
  await assert.rejects(client.waitForMutationToken(), /not connected/);
  await assert.rejects(client.mutationFetch('/api/settings', { method: 'POST' }), /not connected/);
  assert.equal(client.pending.size, 0);
  assert.equal(client.tokenWaiters.size, 0);
});

test('only initial connection states may wait for the first token', async () => {
  const client = connectedClient();
  client.mutationToken = null;

  await assert.rejects(client.request({ type: 'prompt' }), /not connected/);
  await assert.rejects(client.waitForMutationToken(), /not connected/);
  client.disconnect();
});

test('mutation headers preserve caller headers', () => {
  const init = withMutationToken({ headers: { 'Content-Type': 'application/json' } }, 'token-2');
  assert.equal(init.headers.get('Content-Type'), 'application/json');
  assert.equal(init.headers.get('X-Tau-Mutation-Token'), 'token-2');
});

test('mutationFetch calls fetch with caller headers and the live token', async () => {
  const originalFetch = globalThis.fetch;
  const expectedResponse = { ok: true };
  const client = connectedClient();
  let call;

  try {
    globalThis.fetch = async (input, init) => {
      call = { input, init };
      return expectedResponse;
    };
    const response = await client.mutationFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Caller': 'kept' },
      body: '{}',
    });

    assert.equal(response, expectedResponse);
    assert.equal(call.input, '/api/settings');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.get('Content-Type'), 'application/json');
    assert.equal(call.init.headers.get('X-Caller'), 'kept');
    assert.equal(call.init.headers.get('X-Tau-Mutation-Token'), 'token-1');
  } finally {
    globalThis.fetch = originalFetch;
    client.disconnect();
  }
});
