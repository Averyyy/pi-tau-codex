import * as fs from "node:fs";
import * as path from "node:path";

export const SUPPORTED_LINUX_TERMINALS = [
  "gnome-terminal",
  "konsole",
  "kitty",
  "alacritty",
  "wezterm",
  "xterm",
] as const;

export type SupportedLinuxTerminal = (typeof SUPPORTED_LINUX_TERMINALS)[number];

export type TerminalLaunch = {
  command: string;
  args: string[];
};

export type RelayCommand = "prompt" | "set_browser_draft";

export function createPiLaunchArgs(trustMode: unknown, sessionFile?: string): string[] {
  let args: string[];
  if (trustMode === "saved") args = [];
  else if (trustMode === "approve-once") args = ["--approve"];
  else if (trustMode === "deny-once") args = ["--no-approve"];
  else throw new Error("trustMode must be saved, approve-once, or deny-once");
  if (sessionFile) args.push("--session", sessionFile);
  return args;
}

const LINUX_TERMINAL_HELP = `Set TAU_LINUX_TERMINAL to one of: ${SUPPORTED_LINUX_TERMINALS.join(", ")}. For example: TAU_LINUX_TERMINAL=gnome-terminal pi`;

export function createLaunchEnvironment(
  launchId: string,
  env: Record<string, string | undefined>,
  relayToken?: string,
  relayCommand?: RelayCommand,
): Record<string, string | undefined> {
  if (!!relayToken !== !!relayCommand) {
    throw new Error("relayToken and relayCommand must be provided together");
  }
  const launchEnvironment = { ...env, TAU_LAUNCH_ID: launchId };
  if (relayToken) {
    launchEnvironment.TAU_RELAY_TOKEN = relayToken;
    launchEnvironment.TAU_RELAY_COMMAND = relayCommand;
  } else {
    delete launchEnvironment.TAU_RELAY_TOKEN;
    delete launchEnvironment.TAU_RELAY_COMMAND;
  }
  return launchEnvironment;
}

export function requireSupportedLinuxTerminal(terminal: string | undefined): SupportedLinuxTerminal {
  if (!terminal) {
    throw new Error(`Tau cannot open an interactive Linux terminal. ${LINUX_TERMINAL_HELP}`);
  }
  if (!SUPPORTED_LINUX_TERMINALS.includes(terminal as SupportedLinuxTerminal)) {
    throw new Error(`Unsupported TAU_LINUX_TERMINAL=${JSON.stringify(terminal)}. ${LINUX_TERMINAL_HELP}`);
  }
  return terminal as SupportedLinuxTerminal;
}

export function requireLinuxExecutable(
  executable: string,
  env: Record<string, string | undefined>,
): string {
  const searchPath = env.PATH;
  if (!searchPath) {
    throw new Error(`Tau cannot open an interactive Linux terminal because PATH is not set while resolving ${JSON.stringify(executable)}`);
  }

  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching PATH entries; the final error names the unavailable executable.
    }
  }

  throw new Error(`Tau cannot open an interactive Linux terminal because ${JSON.stringify(executable)} is not an executable on PATH. ${LINUX_TERMINAL_HELP}`);
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function createWindowsTerminalLaunch(
  projectPath: string,
  launchId: string,
  piArgs: string[],
  env: Record<string, string | undefined>,
): TerminalLaunch {
  const systemRoot = env.SystemRoot || env.windir;
  if (!systemRoot) {
    throw new Error("Tau cannot open an interactive Windows terminal because SystemRoot is not set");
  }

  const commandPrompt = env.ComSpec || path.win32.join(systemRoot, "System32", "cmd.exe");
  const powerShell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Set-Location -LiteralPath ${powerShellLiteral(projectPath)}`,
    `$env:TAU_LAUNCH_ID = ${powerShellLiteral(launchId)}`,
    "$pi = (Get-Command -Name pi -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path",
    "if (-not $pi) { throw 'Pi executable was not found on PATH.' }",
    `& $pi ${piArgs.map(powerShellLiteral).join(" ")}`,
  ].join("; ");

  return {
    command: commandPrompt,
    // `start` creates the visible console; PowerShell receives a Base64 script so
    // project and session paths never pass through cmd.exe's quoting rules.
    args: [
      "/d",
      "/s",
      "/c",
      `start "Pi Tau" "${powerShell}" -NoLogo -NoExit -EncodedCommand ${encodePowerShell(script)}`,
    ],
  };
}

export function createLinuxTerminalLaunch(
  terminal: SupportedLinuxTerminal,
  projectPath: string,
  piExecutable: string,
  piArgs: string[],
): TerminalLaunch {
  switch (terminal) {
    case "gnome-terminal":
      return { command: terminal, args: [`--working-directory=${projectPath}`, "--", piExecutable, ...piArgs] };
    case "konsole":
      return { command: terminal, args: ["--workdir", projectPath, "-e", piExecutable, ...piArgs] };
    case "kitty":
      return { command: terminal, args: ["--directory", projectPath, piExecutable, ...piArgs] };
    case "alacritty":
      return { command: terminal, args: ["--working-directory", projectPath, "-e", piExecutable, ...piArgs] };
    case "wezterm":
      return { command: terminal, args: ["start", "--cwd", projectPath, "--", piExecutable, ...piArgs] };
    case "xterm":
      return { command: terminal, args: ["-e", piExecutable, ...piArgs] };
  }
}
