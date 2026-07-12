import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOneShotRelayPolicy,
  createAllowedHostnames,
  isAllowedOrigin,
  isAllowedRequestHost,
  isAllowedRequestOrigin,
  isHttpMutation,
  isLoopbackAddress,
  isWebSocketCommandFrame,
  isWebSocketMutation,
  mutationAuthorizationFailure,
} from '../extensions/transport-security.js';

test('Origin must match Host exactly when present', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:3001', '127.0.0.1:3001'), true);
  assert.equal(isAllowedOrigin('https://tau.example', 'tau.example'), true);
  assert.equal(isAllowedOrigin(undefined, '127.0.0.1:3001'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3002', '127.0.0.1:3001'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3001.attacker.test', '127.0.0.1:3001'), false);
  assert.equal(isAllowedOrigin('null', '127.0.0.1:3001'), false);
  assert.equal(isAllowedOrigin('not an origin', '127.0.0.1:3001'), false);
});

test('request Host is limited to local interfaces and explicit TAU_HOST', () => {
  const allowed = createAllowedHostnames({
    en0: [{ address: '192.168.1.20' }, { address: 'fe80::1234' }],
    tailscale0: [{ address: '100.90.80.70' }, { address: 'fd7a:115c:a1e0::1' }],
  }, 'tau.internal');

  assert.equal(isAllowedRequestHost('localhost:3001', allowed), true);
  assert.equal(isAllowedRequestHost('127.42.0.1:3001', allowed), true);
  assert.equal(isAllowedRequestHost('[::1]:3001', allowed), true);
  assert.equal(isAllowedRequestHost('192.168.1.20:3001', allowed), true);
  assert.equal(isAllowedRequestHost('100.90.80.70:3001', allowed), true);
  assert.equal(isAllowedRequestHost('[fd7a:115c:a1e0::1]:3001', allowed), true);
  assert.equal(isAllowedRequestHost('tau.internal:3001', allowed), true);
  assert.equal(isAllowedRequestHost('attacker.example:3001', allowed), false);
  assert.equal(isAllowedRequestHost('0.0.0.0:3001', allowed), false);
  assert.equal(isAllowedRequestOrigin(
    'http://attacker.example:3001',
    'attacker.example:3001',
    allowed,
  ), false);
});

test('HTTP mutation policy is determined only by method', () => {
  assert.equal(isHttpMutation('GET'), false);
  assert.equal(isHttpMutation('HEAD'), false);
  assert.equal(isHttpMutation('OPTIONS'), false);
  assert.equal(isHttpMutation('POST'), true);
  assert.equal(isHttpMutation('DELETE'), true);
  assert.equal(isHttpMutation(undefined), true);
});

test('WebSocket policy uses an explicit read allowlist', () => {
  assert.equal(isWebSocketMutation('get_state'), false);
  assert.equal(isWebSocketMutation('mirror_sync_request'), false);
  assert.equal(isWebSocketMutation('extension_ui_response'), true);
  assert.equal(isWebSocketMutation('extension_tui_resize'), true);
  assert.equal(isWebSocketMutation('prompt'), true);
  assert.equal(isWebSocketMutation('unknown_future_command'), true);
});

test('WebSocket command frames require a non-array object and non-empty type', () => {
  assert.equal(isWebSocketCommandFrame({ type: 'prompt' }), true);
  assert.equal(isWebSocketCommandFrame({ type: 'unknown_future_command' }), true);
  assert.equal(isWebSocketCommandFrame(null), false);
  assert.equal(isWebSocketCommandFrame([]), false);
  assert.equal(isWebSocketCommandFrame({}), false);
  assert.equal(isWebSocketCommandFrame({ type: '' }), false);
  assert.equal(isWebSocketCommandFrame({ type: '   ' }), false);
});

test('relay token and prompt command are independently one-shot', () => {
  const cleared = createOneShotRelayPolicy(undefined);
  assert.equal(cleared.consumeToken('relay-token'), false);

  const relay = createOneShotRelayPolicy('relay-token');
  assert.equal(relay.consumeToken('wrong-token'), false);
  assert.equal(relay.consumeToken('relay-token'), true);
  assert.equal(relay.consumeToken('relay-token'), false);
  assert.equal(relay.acceptCommand('prompt'), true);
  assert.equal(relay.acceptCommand('prompt'), false);

  const wrongCommand = createOneShotRelayPolicy('other-token');
  assert.equal(wrongCommand.consumeToken('other-token'), true);
  assert.equal(wrongCommand.acceptCommand('get_state'), false);
  assert.equal(wrongCommand.acceptCommand('prompt'), false);
});

test('loopback policy accepts IPv4, IPv4-mapped IPv6, and IPv6 loopback only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.10.20.30'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.2'), false);
});

test('mutation authorization requires a live token and remote Basic auth', () => {
  const local = {
    isLoopback: true,
    authConfigured: false,
    authEnabled: false,
    basicAuthenticated: false,
  };
  assert.equal(mutationAuthorizationFailure({ ...local, tokenMatches: true }), null);
  assert.deepEqual(mutationAuthorizationFailure({ ...local, tokenMatches: false }), {
    status: 403,
    message: 'A live connection mutation token is required',
  });
  assert.equal(mutationAuthorizationFailure({
    ...local,
    authConfigured: true,
    authEnabled: true,
    tokenMatches: true,
  }).status, 401);
  assert.equal(mutationAuthorizationFailure({
    ...local,
    authConfigured: true,
    authEnabled: true,
    basicAuthenticated: true,
    tokenMatches: true,
  }), null);

  const remote = { ...local, isLoopback: false, tokenMatches: true };
  assert.equal(mutationAuthorizationFailure(remote).status, 403);
  assert.equal(mutationAuthorizationFailure({
    ...remote,
    authConfigured: true,
    authEnabled: true,
  }).status, 401);
  assert.equal(mutationAuthorizationFailure({
    ...remote,
    authConfigured: true,
    authEnabled: true,
    basicAuthenticated: true,
  }), null);
});
