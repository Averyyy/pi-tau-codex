import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLaunchEnvironment,
  createLinuxTerminalLaunch,
  createWindowsTerminalLaunch,
  requireLinuxExecutable,
  requireSupportedLinuxTerminal,
} from "../extensions/interactive-launch.ts";

test("Windows launch uses a visible PowerShell terminal and preserves literal paths", () => {
  const launch = createWindowsTerminalLaunch(
    "C:\\Users\\Avery's Project",
    "launch'id",
    ["--approve", "--session", "C:\\Users\\Avery's Project\\session.jsonl"],
    { SystemRoot: "C:\\Windows" },
  );

  assert.equal(launch.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(launch.args[3], /^start "Pi Tau" "C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoExit -EncodedCommand /);

  const encoded = launch.args[3].split(" ").at(-1);
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /Set-Location -LiteralPath 'C:\\Users\\Avery''s Project'/);
  assert.match(script, /\$env:TAU_LAUNCH_ID = 'launch''id'/);
  assert.match(script, /& \$pi '--approve' '--session' 'C:\\Users\\Avery''s Project\\session\.jsonl'/);
});

test("Windows launch explains missing SystemRoot", () => {
  assert.throws(
    () => createWindowsTerminalLaunch("C:\\work", "launch", ["--approve"], {}),
    /SystemRoot is not set/,
  );
});

test("Linux terminal configuration is explicit and every supported terminal keeps Pi interactive", () => {
  assert.throws(() => requireSupportedLinuxTerminal(undefined), /TAU_LINUX_TERMINAL/);
  assert.throws(() => requireSupportedLinuxTerminal("foot"), /Unsupported TAU_LINUX_TERMINAL/);

  const projectPath = "/work/project";
  const piPath = "/opt/bin/pi";
  const piArgs = ["--approve", "--session", "/tmp/session.jsonl"];
  const expected = {
    "gnome-terminal": ["--working-directory=/work/project", "--", piPath, ...piArgs],
    konsole: ["--workdir", projectPath, "-e", piPath, ...piArgs],
    kitty: ["--directory", projectPath, piPath, ...piArgs],
    alacritty: ["--working-directory", projectPath, "-e", piPath, ...piArgs],
    wezterm: ["start", "--cwd", projectPath, "--", piPath, ...piArgs],
    xterm: ["-e", piPath, ...piArgs],
  };

  for (const [terminal, args] of Object.entries(expected)) {
    const supported = requireSupportedLinuxTerminal(terminal);
    assert.deepEqual(createLinuxTerminalLaunch(supported, projectPath, piPath, piArgs), {
      command: terminal,
      args,
    });
  }
});

test("Linux executable checks fail before the terminal is opened", async (t) => {
  const bin = await mkdtemp(path.join(tmpdir(), "tau-interactive-launch-"));
  t.after(() => rm(bin, { recursive: true, force: true }));

  const piPath = path.join(bin, "pi");
  await writeFile(piPath, "#!/bin/sh\n");
  await chmod(piPath, 0o755);

  assert.equal(requireLinuxExecutable("pi", { PATH: bin }), piPath);
  await chmod(piPath, 0o644);
  assert.throws(() => requireLinuxExecutable("pi", { PATH: bin }), /"pi" is not an executable on PATH/);
  assert.throws(() => requireLinuxExecutable("pi", {}), /PATH is not set/);
});

test("launch environment always carries the exact launch correlation id", () => {
  assert.deepEqual(
    createLaunchEnvironment("new-id", { PATH: "/usr/bin", TAU_LAUNCH_ID: "old-id" }),
    { PATH: "/usr/bin", TAU_LAUNCH_ID: "new-id" },
  );
});
