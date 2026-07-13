import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rendererSource = await readFile(new URL('../public/message-renderer.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const moduleSource = rendererSource.replace(
  "import { renderMarkdown, renderUserMarkdown, sanitizeImageSource } from './markdown.js';",
  `
const renderMarkdown = (value) => value;
const renderUserMarkdown = (value) => value;
const sanitizeImageSource = (value) => value;
`,
);
const {
  assistantErrorDetails,
  historyAssistantErrorIndexes,
  nextAssistantError,
} = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`,
);

const failed = {
  role: 'assistant',
  provider: 'amazon-bedrock',
  model: 'amazon.nova-2-lite-v1:0',
  stopReason: 'error',
  errorMessage: '  Model unavailable\nrequest-id: exact  ',
};

test('assistant errors retain exact provider, model, and provider message', () => {
  assert.deepEqual(assistantErrorDetails(failed), {
    model: 'amazon-bedrock/amazon.nova-2-lite-v1:0',
    message: '  Model unavailable\nrequest-id: exact  ',
  });
  assert.equal(assistantErrorDetails({ ...failed, stopReason: 'aborted' }), null);
  assert.equal(assistantErrorDetails({ ...failed, errorMessage: '' }), null);
});

test('a successful retry clears the pending failure', () => {
  const pending = nextAssistantError(null, failed);
  assert.equal(pending, failed);
  assert.equal(nextAssistantError(pending, { role: 'user', content: 'retry' }), failed);
  assert.equal(nextAssistantError(pending, {
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: 'done' }],
  }), null);
  assert.equal(nextAssistantError(pending, {
    role: 'assistant',
    stopReason: 'aborted',
    content: [],
  }), null);
});

function messageEntry(message) {
  return { type: 'message', message };
}

test('history keeps only the final assistant error in each user turn', () => {
  const entries = [
    messageEntry({ role: 'user', content: 'first' }),
    messageEntry({ ...failed, errorMessage: 'attempt 1' }),
    { type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
    messageEntry({ role: 'toolResult', toolCallId: 'tool-1', content: [] }),
    messageEntry({ ...failed, content: [{ type: 'text', text: 'partial' }], errorMessage: 'attempt 2' }),
    messageEntry({ role: 'user', content: 'second' }),
    messageEntry({ ...failed, errorMessage: 'attempt 3' }),
  ];

  assert.deepEqual([...historyAssistantErrorIndexes(entries)], [4, 6]);
});

test('history clears retry failures when the same user turn later succeeds', () => {
  const entries = [
    messageEntry({ role: 'user', content: 'retry me' }),
    messageEntry({ ...failed, content: [{ type: 'text', text: 'partial response' }] }),
    messageEntry({ ...failed, errorMessage: 'retry failed too' }),
    messageEntry({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'final answer' }],
    }),
  ];

  assert.deepEqual([...historyAssistantErrorIndexes(entries)], []);
});

test('frontend settles once and persists assistant errors in history', () => {
  assert.match(appSource, /case 'agent_settled':\s*handleAgentSettled\(\)/);
  assert.doesNotMatch(appSource, /case 'agent_error'/);
  assert.doesNotMatch(appSource, /case 'agent_end'/);
  assert.match(appSource, /pendingAssistantError = nextAssistantError\(pendingAssistantError, message\)/);
  assert.match(appSource, /const error = abortRequested \? null : pendingAssistantError/);
  assert.match(appSource, /messageRenderer\.renderAssistantError\(error, errorElement\)/);
  assert.match(appSource, /const visibleAssistantErrors = historyAssistantErrorIndexes\(entries\)/);
  assert.match(appSource, /const hasError = isAssistantError && visibleAssistantErrors\.has\(entryIndex\)/);
  assert.match(appSource, /if \(hasError\) messageRenderer\.renderAssistantError\(msg, assistantElement\)/);
  assert.match(rendererSource, /delete messageElement\.dataset\.messageId/);
  assert.match(rendererSource, /errorElement\.setAttribute\('role', 'alert'\)/);
});
