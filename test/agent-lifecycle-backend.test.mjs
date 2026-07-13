import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../extensions/mirror-server.ts", import.meta.url), "utf8");
const forwarding = source.slice(
  source.indexOf("// Event forwarding"),
  source.indexOf("// Also capture context from session events"),
);

test("Pi's public lifecycle events remain the browser source of truth", () => {
  assert.match(forwarding, /"message_start", "message_update", "message_end"/);
  assert.match(
    forwarding,
    /pi\.on\("agent_settled", async \(event, ctx\) => \{[\s\S]*broadcast\(\{ type: "event", event \}\);\s*releaseBrowserUILease\(\);/,
  );
  assert.doesNotMatch(forwarding, /agent_error|auto_retry_start|auto_retry_end/);
  assert.doesNotMatch(source, /pi\.on\("agent_end", async \(\) => \{\s*releaseBrowserUILease\(\)/);
});
