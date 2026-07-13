import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../extensions/mirror-server.ts", import.meta.url), "utf8");
const promptCase = source.slice(
  source.indexOf('case "prompt": {'),
  source.indexOf('case "steer": {'),
);
const leaseIndex = promptCase.indexOf("acquireBrowserUILease");
const preflight = promptCase.slice(0, leaseIndex);

test("idle prompt rejects missing context before acquiring the browser lease", () => {
  assert.match(preflight, /const isStreaming = !!ctx && !ctx\.isIdle\(\)/);
  assert.match(preflight, /if \(!ctx\) \{\s*sendTo\(ws, error\("prompt", "No context available"\)\);\s*break;/);
  assert.equal(leaseIndex > 0, true);
});

test("idle prompt rejects a missing model before acquiring the browser lease", () => {
  assert.match(preflight, /if \(!ctx\.model\) \{\s*sendTo\(ws, error\("prompt", "No model selected"\)\);\s*break;/);
});

test("idle prompt preserves the exact model availability reason and diagnostics", () => {
  assert.match(preflight, /const availability = getModelAvailability\(ctx, ctx\.model\)/);
  assert.match(preflight, /if \(!availability\.available\)/);
  assert.match(preflight, /availability\.reason \|\| "Model authentication is not configured"/);
  assert.match(preflight, /model: \{ provider: ctx\.model\.provider, id: ctx\.model\.id \},\s*availability,/);
  assert.match(preflight, /sendTo\(ws, response\);\s*break;/);
});

test("available idle prompts fall through to the existing send path", () => {
  assert.match(preflight, /if \(!isStreaming\) \{/);
  assert.equal(preflight.indexOf("pi.sendUserMessage"), -1);
  assert.equal(promptCase.indexOf("pi.sendUserMessage") > leaseIndex, true);
});

test("streaming prompts bypass idle model preflight and retain steer and follow-up delivery", () => {
  assert.match(promptCase, /if \(!isStreaming\) \{[\s\S]*const relayOnly/);
  assert.match(promptCase, /if \(isStreaming\) \{[\s\S]*deliverAs: "steer"/);
  assert.match(promptCase, /deliverAs: "followUp"/);
});
