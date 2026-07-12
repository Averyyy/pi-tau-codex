import assert from "node:assert/strict";
import test from "node:test";

import { getPiExportArgs, parsePiExportOutput } from "../extensions/pi-export.js";

test("Pi export passes the session file as one literal argument", () => {
  assert.deepEqual(getPiExportArgs('/tmp/session"; touch /tmp/injected'), [
    "--export",
    '/tmp/session"; touch /tmp/injected',
  ]);
});

test("Pi export reads the exact final exported path line", () => {
  assert.equal(
    parsePiExportOutput("Preparing export\r\nExported to: /tmp/session output.html\r\n"),
    "/tmp/session output.html",
  );
  assert.throws(() => parsePiExportOutput("/tmp/session.html\n"), /exported HTML path/);
  assert.throws(() => parsePiExportOutput("Exported to: \n"), /exported HTML path/);
});
