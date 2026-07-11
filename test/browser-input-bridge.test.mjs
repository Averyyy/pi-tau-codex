import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchBrowserInput,
  hasBrowserInputListener,
  sameBrowserInputOwner,
} from '../extensions/browser-input-bridge.js';

test('browser input follows Pi terminal listener chaining in registration order', () => {
  const listeners = new Map([
    [1, { handler: (data) => ({ data: `${data}-rewritten` }) }],
    [2, { handler: (data) => (data === 'ArrowDown-rewritten' ? { consume: true } : undefined) }],
    [3, { handler: () => { throw new Error('listener after consume must not run'); } }],
  ]);

  const result = dispatchBrowserInput(listeners, 'ArrowDown');

  assert.deepEqual(result, { consumed: true, data: 'ArrowDown-rewritten' });
  assert.equal(hasBrowserInputListener(listeners), true);
});

test('unsubscribing leaves later terminal listeners active', () => {
  const first = () => undefined;
  const second = () => undefined;
  const listeners = new Map([
    [1, { handler: first }],
    [2, { handler: second }],
  ]);

  listeners.delete(1);
  assert.equal(listeners.size, 1);
  assert.equal(hasBrowserInputListener(listeners), true);
  assert.equal(dispatchBrowserInput(listeners, 'x').consumed, false);
  listeners.delete(2);
  assert.equal(hasBrowserInputListener(listeners), false);
});

test('browser owners require both the same client and lease', () => {
  const client = {};
  assert.equal(sameBrowserInputOwner({ client, leaseId: 1 }, { client, leaseId: 1 }), true);
  assert.equal(sameBrowserInputOwner({ client, leaseId: 1 }, { client, leaseId: 2 }), false);
  assert.equal(sameBrowserInputOwner({ client, leaseId: 1 }, { client: {}, leaseId: 1 }), false);
});
