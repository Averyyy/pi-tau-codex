/**
 * Mirror Server Extension
 * 
 * Starts a WebSocket + HTTP server inside the running Pi process,
 * allowing a browser to connect and mirror the TUI session in real-time.
 * 
 * - Forwards all Pi events to connected browser clients
 * - Accepts commands from the browser and executes them via the extension API
 * - Serves static files for the Tau web UI
 * - Sends full state snapshot on client connect (messages, model, etc.)
 */

import {
  getPackageDir,
  SettingsManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  dispatchBrowserInput,
  hasBrowserInputListener,
  sameBrowserInputOwner,
} from "./browser-input-bridge.js";
import {
  createLaunchEnvironment,
  createLinuxTerminalLaunch,
  createPiLaunchArgs,
  createWindowsTerminalLaunch,
  requireLinuxExecutable,
  requireSupportedLinuxTerminal,
} from "./interactive-launch.ts";
import { exportSessionToHtml } from "./pi-export.js";
import { aggregateSessionStats } from "./session-stats.js";
import {
  createContextSettingsManager,
  readAboutInfo,
  readEnabledModelScope,
  readProviderAccounts,
  writeEnabledModelScope,
} from "./settings-parity.js";
import {
  acquireSessionLaunchReservation,
  completeSessionLaunchReservation,
} from "./session-launch-reservation.js";
import { resolveSessionFilePath } from "./session-file-paths.ts";
import { getWebParityCommand } from "./web-parity.ts";
import {
  createOneShotRelayPolicy,
  createAllowedHostnames,
  isAllowedRequestOrigin,
  isHttpMutation,
  isLoopbackAddress,
  isWebSocketCommandFrame,
  isWebSocketMutation,
  mutationAuthorizationFailure,
} from "./transport-security.js";

let startupRelayToken = process.env.TAU_RELAY_TOKEN || undefined;
delete process.env.TAU_RELAY_TOKEN;

// Load tau settings from ~/.pi/agent/settings.json (falls back to env vars)
function loadTauSettings(): { port: number; host: string; autoStart: boolean; user: string; pass: string; authEnabled?: boolean; projectsDir?: string } {
  let settings: any = {};
  try {
    const settingsPath = path.join(process.env.HOME || "~", ".pi/agent/settings.json");
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).tau || {};
  } catch {}
  return {
    port: parseInt(process.env.TAU_MIRROR_PORT || settings.port || "3001"),
    host: process.env.TAU_HOST || settings.host || "0.0.0.0",
    autoStart: !(
      process.env.TAU_DISABLED === "1" || process.env.TAU_DISABLED === "true" ||
      settings.disabled === true
    ),
    user: process.env.TAU_USER || settings.user || "",
    pass: process.env.TAU_PASS || settings.pass || "",
    authEnabled: settings.authEnabled,
    projectsDir: process.env.TAU_PROJECTS_DIR || settings.projectsDir,
  };
}

const TAU_SETTINGS = loadTauSettings();
const PORT = TAU_SETTINGS.port;
const HOST = TAU_SETTINGS.host;
const TAU_AUTO_START = TAU_SETTINGS.autoStart;
const AUTH_USER = TAU_SETTINGS.user;
const AUTH_PASS = TAU_SETTINGS.pass;
const AUTH_CONFIGURED = !!(AUTH_USER && AUTH_PASS);
const TAU_DEV = process.env.TAU_DEV === "1" || process.env.TAU_DEV === "true";
let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;
// @ts-ignore — __dirname is provided by jiti at runtime
const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();
const DEV_BOOT_SCRIPT = `<script>window.__TAU_DEV__ = true; if ("serviceWorker" in navigator) navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))).then(() => { if (navigator.serviceWorker.controller) location.reload(); });</script>`;
const DEV_RELOAD_SCRIPT = `\n<script>(() => { const s = new EventSource("/__tau_dev/events"); s.onmessage = () => location.reload(); })();</script>`;

function findPublicDir(): string {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (dir: string) => {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    };

    // 1) Common extension-relative paths
    addCandidate(path.resolve(__dirname, "public"));
    addCandidate(path.resolve(__dirname, "../public"));

    // 2) Installed package path (for npm-installed extension execution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("@averyyy/pi-tau-codex/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("tau-mirror/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}

    // 3) Development fallback from current working directory
    addCandidate(path.resolve(process.cwd(), "public"));
    addCandidate(path.resolve(process.cwd(), "node_modules/@averyyy/pi-tau-codex/public"));
    addCandidate(path.resolve(process.cwd(), "node_modules/tau-mirror/public"));

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    }

    // Keep previous fallback behavior
    return path.resolve(process.cwd(), "public");
}
const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, ".pi", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, "sessions");
const INSTANCES_DIR = path.join(USER_HOME, ".pi", "tau-instances");
const PI_SETTINGS_PATH = path.join(PI_AGENT_DIR, "settings.json");
const PI_AGENTS_PATH = path.join(PI_AGENT_DIR, "AGENTS.md");
const SIDEBAR_PREFERENCES_PATH = path.join(PI_AGENT_DIR, "tau-sidebar.json");
const SIDEBAR_PREFERENCES_LOCK_PATH = `${SIDEBAR_PREFERENCES_PATH}.lock`;
const SIDEBAR_PREFERENCES_LOCK_TIMEOUT_MS = 5_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const LAUNCH_TIMEOUT_MS = 20_000;

type TauInstance = {
  port: number;
  pid: number;
  sessionFile: string;
  cwd: string;
  startedAt: string;
  launchId?: string;
};

function readAgentSettings(): Record<string, unknown> {
  if (!fs.existsSync(PI_SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(PI_SETTINGS_PATH, "utf8"));
}

function writeAgentSettings(settings: Record<string, unknown>) {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  fs.writeFileSync(PI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

type SidebarSectionPreferences = {
  favouritesOpen: boolean;
  projectsOpen: boolean;
  tasksOpen: boolean;
  hiddenProjectsOpen: boolean;
};

type SidebarPreferences = {
  revision: number;
  favourites: string[];
  hiddenProjects: string[];
  projectNames: Record<string, string>;
  projectOrder: string[];
  pinnedProjects: string[];
  collapsedProjects: string[];
  sections: SidebarSectionPreferences;
};

function defaultSidebarPreferences(): SidebarPreferences {
  return {
    revision: 0,
    favourites: [],
    hiddenProjects: [],
    projectNames: {},
    projectOrder: [],
    pinnedProjects: [],
    collapsedProjects: [],
    sections: {
      favouritesOpen: true,
      projectsOpen: true,
      tasksOpen: true,
      hiddenProjectsOpen: false,
    },
  };
}

function sidebarStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function requireSidebarPreferenceStringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${name} must be a string array`);
  }
  const result = [...value] as string[];
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return result;
}

function normalizeSidebarPreferences(value: unknown): SidebarPreferences {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawSections = raw.sections && typeof raw.sections === "object"
    ? raw.sections as Record<string, unknown>
    : {};
  const rawNames = raw.projectNames && typeof raw.projectNames === "object"
    ? raw.projectNames as Record<string, unknown>
    : {};
  const projectNames: Record<string, string> = {};
  for (const [projectPath, name] of Object.entries(rawNames)) {
    if (typeof name === "string" && name) projectNames[projectPath] = name;
  }
  return {
    revision: typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0,
    favourites: sidebarStringList(raw.favourites),
    hiddenProjects: sidebarStringList(raw.hiddenProjects),
    projectNames,
    projectOrder: sidebarStringList(raw.projectOrder),
    pinnedProjects: sidebarStringList(raw.pinnedProjects),
    collapsedProjects: sidebarStringList(raw.collapsedProjects),
    sections: {
      favouritesOpen: rawSections.favouritesOpen !== false,
      projectsOpen: rawSections.projectsOpen !== false,
      tasksOpen: rawSections.tasksOpen !== false,
      hiddenProjectsOpen: rawSections.hiddenProjectsOpen === true,
    },
  };
}

function readSidebarPreferences(): SidebarPreferences {
  if (!fs.existsSync(SIDEBAR_PREFERENCES_PATH)) return defaultSidebarPreferences();
  return normalizeSidebarPreferences(JSON.parse(fs.readFileSync(SIDEBAR_PREFERENCES_PATH, "utf8")));
}

function writeSidebarPreferences(preferences: SidebarPreferences) {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  const pendingPath = `${SIDEBAR_PREFERENCES_PATH}.${randomUUID()}.tmp`;
  fs.writeFileSync(pendingPath, JSON.stringify(preferences, null, 2) + "\n");
  fs.renameSync(pendingPath, SIDEBAR_PREFERENCES_PATH);
}

function removeDeadSidebarPreferencesLock(): boolean {
  try {
    const owner = fs.readFileSync(SIDEBAR_PREFERENCES_LOCK_PATH, "utf8").trim();
    const ownerPid = Number(owner);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error: any) {
      if (error?.code !== "ESRCH") return false;
      fs.unlinkSync(SIDEBAR_PREFERENCES_LOCK_PATH);
      return true;
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function withSidebarPreferencesLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + SIDEBAR_PREFERENCES_LOCK_TIMEOUT_MS;
  let lockFd = -1;

  while (lockFd === -1) {
    try {
      lockFd = fs.openSync(SIDEBAR_PREFERENCES_LOCK_PATH, "wx", 0o600);
      fs.writeFileSync(lockFd, String(process.pid));
    } catch (error: any) {
      if (lockFd !== -1) {
        fs.closeSync(lockFd);
        fs.unlinkSync(SIDEBAR_PREFERENCES_LOCK_PATH);
      }
      lockFd = -1;
      if (error?.code !== "EEXIST") throw error;
      if (removeDeadSidebarPreferencesLock()) continue;
      if (Date.now() >= deadline) throw new Error("Sidebar preferences are busy");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(SIDEBAR_PREFERENCES_LOCK_PATH);
  }
}

function requireSidebarPreferenceString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} required`);
  return value;
}

function toggleSidebarPreferenceList(list: string[], value: string) {
  const index = list.indexOf(value);
  if (index === -1) list.push(value);
  else list.splice(index, 1);
}

function applySidebarPreferencesMutation(preferences: SidebarPreferences, mutation: any): SidebarPreferences {
  if (!mutation || typeof mutation !== "object") throw new Error("mutation required");
  const type = mutation.type;

  switch (type) {
    case "toggle_favourite":
      toggleSidebarPreferenceList(preferences.favourites, requireSidebarPreferenceString(mutation.filePath, "filePath"));
      break;
    case "remove_session": {
      const filePath = requireSidebarPreferenceString(mutation.filePath, "filePath");
      preferences.favourites = preferences.favourites.filter((entry) => entry !== filePath);
      break;
    }
    case "toggle_project_hidden":
      toggleSidebarPreferenceList(preferences.hiddenProjects, requireSidebarPreferenceString(mutation.projectPath, "projectPath"));
      break;
    case "toggle_project_pinned": {
      const projectPath = requireSidebarPreferenceString(mutation.projectPath, "projectPath");
      const index = preferences.pinnedProjects.indexOf(projectPath);
      if (index === -1) preferences.pinnedProjects.unshift(projectPath);
      else preferences.pinnedProjects.splice(index, 1);
      break;
    }
    case "set_project_name": {
      const projectPath = requireSidebarPreferenceString(mutation.projectPath, "projectPath");
      if (mutation.name === null || mutation.name === "") {
        delete preferences.projectNames[projectPath];
      } else if (typeof mutation.name === "string") {
        preferences.projectNames[projectPath] = mutation.name;
      } else {
        throw new Error("name must be a string or null");
      }
      break;
    }
    case "toggle_project_collapsed":
      toggleSidebarPreferenceList(preferences.collapsedProjects, requireSidebarPreferenceString(mutation.projectPath, "projectPath"));
      break;
    case "normalize_collapsed_projects": {
      if (!Array.isArray(mutation.mappings)) throw new Error("mappings required");
      const collapsed = new Set(preferences.collapsedProjects);
      for (const mapping of mutation.mappings) {
        const projectPath = requireSidebarPreferenceString(mapping?.projectPath, "projectPath");
        const legacyKey = requireSidebarPreferenceString(mapping?.legacyKey, "legacyKey");
        if (collapsed.has(legacyKey) && !collapsed.has(projectPath)) {
          collapsed.delete(legacyKey);
          collapsed.add(projectPath);
        }
      }
      preferences.collapsedProjects = [...collapsed];
      break;
    }
    case "set_section_open": {
      const section = requireSidebarPreferenceString(mutation.section, "section");
      if (typeof mutation.open !== "boolean") throw new Error("open must be a boolean");
      const sectionKey = `${section}Open` as keyof SidebarSectionPreferences;
      if (!(sectionKey in preferences.sections)) throw new Error("Unknown sidebar section");
      preferences.sections[sectionKey] = mutation.open;
      break;
    }
    case "toggle_section": {
      const section = requireSidebarPreferenceString(mutation.section, "section");
      const sectionKey = `${section}Open` as keyof SidebarSectionPreferences;
      if (!(sectionKey in preferences.sections)) throw new Error("Unknown sidebar section");
      preferences.sections[sectionKey] = !preferences.sections[sectionKey];
      break;
    }
    case "move_project": {
      const sourcePath = requireSidebarPreferenceString(mutation.sourcePath, "sourcePath");
      const targetPath = requireSidebarPreferenceString(mutation.targetPath, "targetPath");
      if (sourcePath === targetPath) throw new Error("sourcePath and targetPath must differ");
      if (!Array.isArray(mutation.projectPaths)) throw new Error("projectPaths required");
      const projectPaths = sidebarStringList(mutation.projectPaths);
      if (!projectPaths.includes(sourcePath) || !projectPaths.includes(targetPath)) {
        throw new Error("Project order must include source and target");
      }

      const sourcePinned = preferences.pinnedProjects.includes(sourcePath);
      const targetPinned = preferences.pinnedProjects.includes(targetPath);
      if (sourcePinned !== targetPinned) {
        throw new Error("Pinned projects can only be reordered with pinned projects");
      }

      if (sourcePinned) {
        const pinnedProjectPaths = requireSidebarPreferenceStringList(
          mutation.pinnedProjectPaths,
          "pinnedProjectPaths",
        );
        const currentPinned = preferences.pinnedProjects;
        if (
          pinnedProjectPaths.length !== currentPinned.length ||
          pinnedProjectPaths.some((projectPath) => !currentPinned.includes(projectPath))
        ) {
          throw new Error("pinnedProjectPaths must preserve pinned project membership");
        }

        const reordered = [...currentPinned];
        reordered.splice(reordered.indexOf(sourcePath), 1);
        const targetIndex = reordered.indexOf(targetPath);
        reordered.splice(targetIndex + (mutation.insertAfter === true ? 1 : 0), 0, sourcePath);
        preferences.pinnedProjects = reordered;
        break;
      }

      if (mutation.pinnedProjectPaths !== undefined) {
        throw new Error("pinnedProjectPaths is only valid for pinned project reordering");
      }
      const visibleProjectPaths = new Set(projectPaths);
      const existing = preferences.projectOrder.filter((entry) => visibleProjectPaths.has(entry));
      const missing = projectPaths.filter((entry) => !existing.includes(entry));
      const other = preferences.projectOrder.filter((entry) => !visibleProjectPaths.has(entry));
      const ordered = [...existing, ...missing, ...other];
      const from = ordered.indexOf(sourcePath);
      ordered.splice(from, 1);
      const targetIndex = ordered.indexOf(targetPath);
      ordered.splice(targetIndex + (mutation.insertAfter === true ? 1 : 0), 0, sourcePath);
      preferences.projectOrder = ordered;
      break;
    }
    default:
      throw new Error("Unknown sidebar preference mutation");
  }

  preferences.revision += 1;
  return preferences;
}

async function mutateSidebarPreferences(mutation: any): Promise<SidebarPreferences> {
  return withSidebarPreferencesLock(() => {
    const exists = fs.existsSync(SIDEBAR_PREFERENCES_PATH);
    if (mutation?.type === "bootstrap") {
      const preferences = exists
        ? readSidebarPreferences()
        : normalizeSidebarPreferences(mutation.preferences);
      if (!exists) {
        preferences.revision = 1;
        writeSidebarPreferences(preferences);
      }
      return preferences;
    }
    const preferences = applySidebarPreferencesMutation(readSidebarPreferences(), mutation);
    writeSidebarPreferences(preferences);
    return preferences;
  });
}

// Instance registry — tracks all running Tau servers
function writeInstanceFile(info: TauInstance) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const file = path.join(INSTANCES_DIR, `${info.pid}.json`);
  const pendingFile = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(pendingFile, JSON.stringify(info));
  fs.renameSync(pendingFile, file);
}

function registerInstance(port: number, sessionFile: string, cwd: string) {
  const launchId = process.env.TAU_LAUNCH_ID || undefined;
  const info: TauInstance = {
    port,
    pid: process.pid,
    sessionFile,
    cwd,
    startedAt: new Date().toISOString(),
    launchId,
  };
  writeInstanceFile(info);
  if (launchId) {
    completeSessionLaunchReservation(INSTANCES_DIR, { launchId, sessionFile });
  }
}

function updateInstanceSession(sessionFile: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as TauInstance;
    info.sessionFile = sessionFile;
    writeInstanceFile(info);
  } catch {}
}

function unregisterInstance() {
  try { fs.unlinkSync(path.join(INSTANCES_DIR, `${process.pid}.json`)); } catch {}
}

function getRunningInstances(): TauInstance[] {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: TauInstance[] = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Check if process is still alive
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
  return instances;
}

/**
 * Kill zombie Tau instances — processes that are alive but orphaned
 * (e.g. tmux pane was killed without session_shutdown firing).
 * A zombie is detected by checking if the process has a controlling terminal.
 * If it doesn't, the HTTP server is the only thing keeping it alive.
 */
function cleanupZombieInstances() {
  if (process.platform === "win32") return;
  if (!fs.existsSync(INSTANCES_DIR)) return;
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Skip our own process
      if (info.pid === process.pid) continue;
      // Check if process is alive
      try {
        process.kill(info.pid, 0);
      } catch {
        // Already dead — clean up
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
        continue;
      }
      // Use shared zombie detection
      if (isZombieProcess(info.pid)) {
        console.log(`[Mirror] Killing zombie Tau instance (PID ${info.pid}, port ${info.port})`);
        process.kill(info.pid, "SIGTERM");
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
}

function isZombieProcess(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const { execSync } = require("node:child_process");
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim();
    return !tty || tty === "??" || tty === "-";
  } catch {
    return true;
  }
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function saveTauSetting(key: string, value: any) {
  const settingsPath = path.join(process.env.HOME || "~", ".pi/agent/settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function launchInteractiveTerminal(
  command: string,
  args: string[],
  projectPath: string,
  launchId: string,
  relayToken?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectPath,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: createLaunchEnvironment(launchId, process.env, relayToken),
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function launchPi(
  projectPath: string,
  launchId: string,
  options: { piArgs: string[]; relayToken?: string },
): Promise<void> {
  const args = options.piArgs;
  if (process.platform === "darwin") {
    const piPath = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    const relayEnvironment = options.relayToken
      ? `TAU_RELAY_TOKEN=${shellQuote(options.relayToken)} `
      : "";
    const command = `cd ${shellQuote(projectPath)} && unset TAU_RELAY_TOKEN && TAU_LAUNCH_ID=${shellQuote(launchId)} ${relayEnvironment}${shellQuote(piPath)} ${args.map(shellQuote).join(" ")}`;
    execFileSync("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(`${command}; exit`)}`]);
    return;
  }
  if (process.platform === "win32") {
    const launch = createWindowsTerminalLaunch(projectPath, launchId, args, process.env);
    await launchInteractiveTerminal(launch.command, launch.args, projectPath, launchId, options.relayToken);
    return;
  }
  if (process.platform === "linux") {
    const terminal = requireSupportedLinuxTerminal(process.env.TAU_LINUX_TERMINAL);
    const terminalExecutable = requireLinuxExecutable(terminal, process.env);
    const piExecutable = requireLinuxExecutable("pi", process.env);
    const launch = createLinuxTerminalLaunch(terminal, projectPath, piExecutable, args);
    await launchInteractiveTerminal(terminalExecutable, launch.args, projectPath, launchId, options.relayToken);
    return;
  }
  throw new Error(`Tau cannot open an interactive Pi terminal on ${process.platform}`);
}

class LaunchPiRejectedError extends Error {
  readonly rejection: Error;

  constructor(rejection: unknown) {
    const error = rejection instanceof Error ? rejection : new Error(String(rejection));
    super(error.message);
    this.rejection = error;
  }
}

class SessionLaunchBusyError extends Error {}

function waitForLaunchedInstance(
  projectPath: string,
  launchId: string,
  options: { piArgs: string[]; relayToken?: string; expectedSessionFile?: string },
): Promise<TauInstance> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error, instance?: TauInstance) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      watcher?.close();
      if (error) reject(error);
      else if (instance) resolve(instance);
      else reject(new Error("Tau instance registration was empty"));
    };

    const inspectRegistration = (filename?: string | Buffer | null) => {
      const names = filename && filename.toString().endsWith(".json")
        ? [filename.toString()]
        : fs.readdirSync(INSTANCES_DIR).filter((name) => name.endsWith(".json"));
      for (const name of names) {
        const file = path.join(INSTANCES_DIR, name);
        if (!fs.existsSync(file)) continue;
        let instance: any;
        try {
          instance = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          continue;
        }
        if (!instance || typeof instance !== "object" || instance.launchId !== launchId) continue;
        if (typeof instance.sessionFile !== "string") {
          throw new Error(`Invalid Tau instance registration: ${file}`);
        }
        if (
          options.expectedSessionFile !== undefined &&
          instance.sessionFile !== options.expectedSessionFile
        ) {
          continue;
        }
        if (
          !Number.isSafeInteger(instance.port) ||
          instance.port <= 0 ||
          !Number.isSafeInteger(instance.pid) ||
          instance.pid <= 0 ||
          typeof instance.cwd !== "string" ||
          typeof instance.startedAt !== "string"
        ) {
          throw new Error(`Invalid Tau instance registration: ${file}`);
        }
        finish(undefined, instance as TauInstance);
        return;
      }
    };

    try {
      fs.mkdirSync(INSTANCES_DIR, { recursive: true });
      watcher = fs.watch(INSTANCES_DIR, (_eventType, filename) => {
        try {
          inspectRegistration(filename);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      watcher.on("error", (error) => finish(error));
      inspectRegistration();
    } catch (error) {
      finish(new LaunchPiRejectedError(error));
      return;
    }
    if (settled) return;

    void launchPi(projectPath, launchId, options).then(
      () => {
        if (settled) return;
        timeout = setTimeout(() => {
          try {
            inspectRegistration();
            if (!settled) {
              finish(new SessionLaunchBusyError(
                `Tau instance did not register within ${LAUNCH_TIMEOUT_MS / 1000} seconds`,
              ));
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }, LAUNCH_TIMEOUT_MS);
      },
      (error) => finish(new LaunchPiRejectedError(error)),
    );
  });
}

function findRunningSessionInstance(sessionFile: string): TauInstance | undefined {
  return getRunningInstances().find((instance) => instance.sessionFile === sessionFile);
}

function waitForSessionLaunch(
  sessionFile: string,
  reservationPath: string,
  timeoutMs: number,
): Promise<TauInstance | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (instance: TauInstance | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      watcher?.close();
      if (error) reject(error);
      else resolve(instance);
    };
    const inspect = () => {
      const instance = findRunningSessionInstance(sessionFile);
      if (instance) finish(instance);
      else if (!fs.existsSync(reservationPath)) finish(null);
    };

    watcher = fs.watch(INSTANCES_DIR, () => {
      try {
        inspect();
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)));
      }
    });
    watcher.on("error", (error) => finish(null, error));
    timeout = setTimeout(() => {
      try {
        inspect();
        if (!settled) {
          finish(null, new SessionLaunchBusyError("Session launch is already in progress"));
        }
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)));
      }
    }, timeoutMs);

    try {
      inspect();
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function launchOrReuseSession(
  sessionFile: string,
  launch: (launchId: string) => Promise<TauInstance>,
): Promise<{ instance: TauInstance; reused: boolean }> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;

  while (true) {
    const running = findRunningSessionInstance(sessionFile);
    if (running) return { instance: running, reused: true };

    const launchId = randomUUID();
    const reservation = acquireSessionLaunchReservation(INSTANCES_DIR, {
      launchId,
      ownerPid: process.pid,
      sessionFile,
    });
    if (reservation.acquired) {
      const raced = findRunningSessionInstance(sessionFile);
      if (raced) {
        reservation.release();
        return { instance: raced, reused: true };
      }
      try {
        const instance = await launch(launchId);
        return { instance, reused: false };
      } catch (error) {
        if (error instanceof LaunchPiRejectedError) {
          reservation.release();
          throw error.rejection;
        }
        throw error;
      }
    }

    const instance = await waitForSessionLaunch(
      sessionFile,
      reservation.path,
      Math.max(0, deadline - Date.now()),
    );
    if (instance) return { instance, reused: true };
  }
}

function relayCommandToInstance(
  instance: TauInstance,
  command: Record<string, unknown>,
  relayToken: string,
): Promise<void> {
  const relayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST === "::" ? "::1" : HOST;
  const urlHost = relayHost.includes(":") ? `[${relayHost}]` : relayHost;
  const headers: Record<string, string> = { "X-Tau-Relay-Token": relayToken };
  if (AUTH_CONFIGURED && authEnabled) {
    headers.Authorization = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64")}`;
  }
  const socket = new WebSocket(`ws://${urlHost}:${instance.port}/ws`, { headers });
  const id = randomUUID();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close();
      if (error) reject(error);
      else resolve();
    };

    socket.once("open", () => {
      socket.send(JSON.stringify({ ...command, id }));
    });
    socket.on("message", (data) => {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        finish(new Error("New session returned an invalid relay response"));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish(new Error("New session returned an invalid relay response"));
        return;
      }
      if (message.type !== "response" || message.id !== id) return;
      finish(message.success === false
        ? new Error(message.error || "New session rejected the message")
        : undefined);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("New session closed before accepting the message")));
    timeout = setTimeout(() => {
      finish(new Error(`New session did not accept the message within ${LAUNCH_TIMEOUT_MS / 1000} seconds`));
    }, LAUNCH_TIMEOUT_MS);
  });
}

function hasValidBasicAuth(req: http.IncomingMessage): boolean {
  if (!AUTH_CONFIGURED) return false;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  return decoded.slice(0, colon) === AUTH_USER && decoded.slice(colon + 1) === AUTH_PASS;
}

function sendAuthRequired(res: http.ServerResponse) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Tau"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function sendForbidden(res: http.ServerResponse, message: string) {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function isTempProjectPath(projectPath: string | null | undefined): boolean {
  if (!projectPath) return true;
  const resolved = path.resolve(projectPath);
  const tmp = path.resolve(os.tmpdir());
  return resolved === tmp ||
    resolved.startsWith(tmp + path.sep) ||
    resolved === "/tmp" ||
    resolved.startsWith("/tmp/") ||
    resolved === "/private/tmp" ||
    resolved.startsWith("/private/tmp/");
}

function getSupportedThinkingLevels(model: any): string[] {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (level !== "xhigh" || mapped !== undefined);
  });
}

function modelRef(model: any): string {
  return `${model.provider}/${model.id}`;
}

function stripThinkingLevel(pattern: string): string {
  const idx = pattern.lastIndexOf(":");
  if (idx === -1) return pattern;
  const suffix = pattern.slice(idx + 1);
  return THINKING_LEVELS.includes(suffix) ? pattern.slice(0, idx) : pattern;
}

function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesModelPattern(model: any, rawPattern: string): boolean {
  const pattern = stripThinkingLevel(rawPattern);
  if (!pattern) return false;
  if (pattern.includes("*") || pattern.includes("?")) {
    const regex = wildcardPattern(pattern);
    return regex.test(modelRef(model)) || regex.test(model.id);
  }
  return modelRef(model) === pattern || model.id === pattern;
}

function uniqueModels(models: any[]): any[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = modelRef(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getScopedModels(ctx: ExtensionContext, availableModels: any[]): any[] {
  const settings = readAgentSettings();
  const patterns = Array.isArray(settings.enabledModels)
    ? settings.enabledModels.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
  if (patterns.length === 0) return [];

  const registry: any = ctx.modelRegistry;
  const allModels = typeof registry.getAll === "function" ? registry.getAll() : availableModels;
  const currentModel = ctx.model ? [ctx.model] : [];
  const candidates = uniqueModels([...allModels, ...availableModels, ...currentModel]);
  const scoped: any[] = [];

  for (const pattern of patterns) {
    for (const model of candidates) {
      if (matchesModelPattern(model, pattern)) scoped.push(model);
    }
  }
  return uniqueModels(scoped);
}

// Pi's public getCommands() contains extension, prompt, and skill commands,
// but intentionally omits built-ins. Keep the current runtime's built-in
// catalog here until Pi exposes a public built-in catalog.
const BUILTIN_SLASH_COMMANDS = [
  ["settings", "Open settings menu"],
  ["model", "Select model (opens selector UI)"],
  ["scoped-models", "Enable/disable models for Ctrl+P cycling"],
  ["export", "Export session (HTML default, or specify path: .html/.jsonl)"],
  ["import", "Import and resume a session from a JSONL file"],
  ["share", "Share session as a secret GitHub gist"],
  ["copy", "Copy last agent message to clipboard"],
  ["name", "Set session display name"],
  ["session", "Show session info and stats"],
  ["changelog", "Show changelog entries"],
  ["hotkeys", "Show all keyboard shortcuts"],
  ["fork", "Create a new fork from a previous user message"],
  ["clone", "Duplicate the current session at the current position"],
  ["tree", "Navigate session tree (switch branches)"],
  ["trust", "Save project trust decision for future sessions"],
  ["login", "Configure provider authentication"],
  ["logout", "Remove provider authentication"],
  ["new", "Start a new session"],
  ["compact", "Manually compact the session context"],
  ["resume", "Resume a different session"],
  ["reload", "Reload keybindings, extensions, prompts, and themes"],
  ["quit", "Quit Pi"],
] as const;

const TAU_COMMAND_NAMES = new Set(["taustop", "tau-stop", "taustart", "tau-start", "tau", "qr"]);

type CommandExecution = "rpc" | "native" | "metadata-only" | "unsupported";

type CommandCapability = {
  execution: CommandExecution;
  available: boolean;
  reason?: string;
  requires?: string[];
};

const SESSION_COMMAND_CONTEXT_REASON =
  "Pi 0.80.3 exposes session replacement and tree actions only on ExtensionCommandContext; this mirror callback currently has no live command context";

const BUILTIN_COMMAND_CAPABILITIES: Record<string, Omit<CommandCapability, "available">> = {
  settings: {
    execution: "unsupported",
    reason: "Pi's built-in settings selector is owned by the interactive host and is not exposed through ExtensionAPI",
  },
  model: {
    execution: "unsupported",
    reason: "Pi's built-in model selector is owned by the interactive host; use the mirror model RPC instead",
  },
  "scoped-models": {
    execution: "unsupported",
    reason: "Pi's built-in scoped-model selector is owned by the interactive host and is not exposed through ExtensionAPI",
  },
  export: {
    execution: "rpc",
    reason: "The mirror uses the installed Pi CLI export path because ExtensionContext has no export action",
  },
  import: {
    execution: "unsupported",
    reason: "Pi 0.80.3 exposes importFromJsonl only on AgentSessionRuntime, not on ExtensionAPI or ExtensionCommandContext",
    requires: ["inputPath"],
  },
  share: {
    execution: "unsupported",
    reason: "Pi's share flow is interactive-host-only and requires its private export/runtime host plus gh UI flow",
  },
  copy: {
    execution: "unsupported",
    reason: "Pi's clipboard command is interactive-host-only and is not exposed through ExtensionAPI",
  },
  name: {
    execution: "rpc",
    reason: "Use set_session_name through the mirror RPC",
  },
  session: {
    execution: "rpc",
    reason: "Use get_session_stats through the mirror RPC",
  },
  changelog: {
    execution: "unsupported",
    reason: "Pi's changelog view is interactive-host-only",
  },
  hotkeys: {
    execution: "unsupported",
    reason: "Pi's hotkeys view is interactive-host-only",
  },
  fork: {
    execution: "native",
    reason: SESSION_COMMAND_CONTEXT_REASON,
    requires: ["entryId"],
  },
  clone: {
    execution: "native",
    reason: SESSION_COMMAND_CONTEXT_REASON,
  },
  tree: {
    execution: "native",
    reason: SESSION_COMMAND_CONTEXT_REASON,
    requires: ["targetId"],
  },
  trust: {
    execution: "unsupported",
    reason: "Pi's trust selector writes through its private interactive host; ExtensionContext exposes only isProjectTrusted()",
  },
  login: {
    execution: "rpc",
    reason: "Provided by the Tau web-parity extension through Pi's public auth storage API",
  },
  logout: {
    execution: "rpc",
    reason: "Provided by the Tau web-parity extension through Pi's public auth storage API",
  },
  new: {
    execution: "native",
    reason: SESSION_COMMAND_CONTEXT_REASON,
  },
  compact: {
    execution: "rpc",
    reason: "Uses public ExtensionContext.compact()",
  },
  resume: {
    execution: "native",
    reason: SESSION_COMMAND_CONTEXT_REASON,
    requires: ["sessionPath"],
  },
  reload: {
    execution: "native",
    reason: "Uses public ExtensionCommandContext.reload(); Pi reload tears down and recreates the extension runtime",
  },
  quit: {
    execution: "rpc",
    reason: "Provided by the Tau web-parity extension through Pi's public ctx.shutdown() API",
  },
};

type ModelRegistryDiagnostics = {
  registryError?: string;
  authErrors?: string[];
};

const modelRegistryDiagnosticsCache = new WeakMap<object, ModelRegistryDiagnostics>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getModelRegistryDiagnostics(registry: any): ModelRegistryDiagnostics {
  const cached = registry && typeof registry === "object"
    ? modelRegistryDiagnosticsCache.get(registry)
    : undefined;
  const diagnostics: ModelRegistryDiagnostics = cached ? { ...cached } : {};
  if (typeof registry.getError === "function") {
    const registryError = registry.getError();
    diagnostics.registryError = registryError ? String(registryError) : undefined;
  }

  const drainErrors = registry.authStorage?.drainErrors;
  if (typeof drainErrors === "function") {
    const errors = drainErrors.call(registry.authStorage);
    const messages = Array.isArray(errors)
      ? errors.map(errorText).filter(Boolean)
      : [];
    if (messages.length > 0) {
      diagnostics.authErrors = [...new Set([...(diagnostics.authErrors || []), ...messages])];
    }
  }
  if (registry && typeof registry === "object") {
    modelRegistryDiagnosticsCache.set(registry, diagnostics);
  }
  return diagnostics;
}

function getModelAvailability(
  ctx: ExtensionContext,
  model: any,
  diagnostics: ModelRegistryDiagnostics = getModelRegistryDiagnostics(ctx.modelRegistry),
) {
  const registry: any = ctx.modelRegistry;
  const available = typeof registry.hasConfiguredAuth === "function"
    ? registry.hasConfiguredAuth(model)
    : true;
  const authStatus = typeof registry.getProviderAuthStatus === "function"
    ? registry.getProviderAuthStatus(model.provider)
    : undefined;
  const reason = available
    ? null
    : diagnostics.authErrors?.[0]
      ? `Provider authentication could not be loaded for ${model.provider}: ${diagnostics.authErrors[0]}`
      : diagnostics.registryError
        ? `Model registry configuration could not be loaded: ${diagnostics.registryError}`
        : authStatus?.configured
          ? `Provider authentication for ${model.provider} is configured but unavailable`
          : authStatus?.source
            ? `Provider authentication for ${model.provider} is not usable (source: ${authStatus.source})`
            : `No provider authentication configured for ${model.provider}`;

  return {
    available,
    reason,
    auth: authStatus
      ? {
          configured: authStatus.configured === true,
          source: authStatus.source,
          label: authStatus.label,
        }
      : undefined,
    registryError: diagnostics.registryError,
    authErrors: diagnostics.authErrors,
  };
}

function annotateModelAvailability(
  ctx: ExtensionContext,
  model: any,
  diagnostics?: ModelRegistryDiagnostics,
) {
  return { ...model, availability: getModelAvailability(ctx, model, diagnostics) };
}

function stripModelAvailability(model: any) {
  const { availability: _availability, ...plainModel } = model;
  return plainModel;
}

function getModelChoices(ctx: ExtensionContext): {
  models: any[];
  scopedModels: any[];
  registryError?: string;
  authErrors?: string[];
} {
  const registry: any = ctx.modelRegistry;
  const diagnostics = getModelRegistryDiagnostics(registry);
  const allModels = typeof registry.getAll === "function"
    ? registry.getAll()
    : registry.getAvailable();
  const scopedModels = getScopedModels(ctx, allModels);
  const currentModel = ctx.model ? [ctx.model] : [];
  const models = uniqueModels([...scopedModels, ...allModels, ...currentModel]).map((model) =>
    annotateModelAvailability(ctx, model, diagnostics),
  );
  const scopedRefs = new Set(scopedModels.map(modelRef));
  return {
    models,
    scopedModels: models.filter((model) => scopedRefs.has(modelRef(model))),
    ...diagnostics,
  };
}

function getSlashCommands(pi: ExtensionAPI, hasLiveCommandContext = false) {
  const commands = BUILTIN_SLASH_COMMANDS.map(([name, description]) => ({
    name,
    description,
    source: "builtin",
    ...(TAU_COMMAND_NAMES.has(name)
      ? { execution: "rpc" as const, available: true }
      : (() => {
          const capability = BUILTIN_COMMAND_CAPABILITIES[name];
          const available = !!getWebParityCommand(name)
            || capability?.execution === "rpc"
            || (capability?.execution === "native" && hasLiveCommandContext);
          return {
            execution: capability?.execution || "unsupported",
            available,
            ...(capability?.reason ? { reason: capability.reason } : {}),
            ...(capability?.requires ? { requires: capability.requires } : {}),
          };
        })()),
  }));
  const seen = new Set(commands.map((command) => command.name));
  const dynamicCommands = pi.getCommands();

  for (const command of dynamicCommands) {
    const name = String(command.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    commands.push({
      name,
      description: command.description || "Extension command",
      source: command.source || "extension",
      sourceInfo: command.sourceInfo,
      ...(TAU_COMMAND_NAMES.has(name)
        ? { execution: "rpc" as const, available: true }
        : getWebParityCommand(name)
          ? { execution: "rpc" as const, available: true }
        : {
            execution: "metadata-only" as const,
            available: false,
            reason: "Pi 0.80.3 exposes third-party command metadata through getCommands(), but no public executeCommand API",
          }),
    });
  }

  return commands;
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let devWatcher: fs.FSWatcher | null = null;
  let devReloadTimer: ReturnType<typeof setTimeout> | null = null;
  const clients = new Set<WebSocket>();
  const relayOnlyClients = new WeakSet<WebSocket>();
  const relayPolicy = createOneShotRelayPolicy(startupRelayToken);
  startupRelayToken = undefined;
  const clientSecurity = new WeakMap<WebSocket, {
    mutationToken: string;
    isLoopback: boolean;
    basicAuthenticated: boolean;
  }>();
  const liveMutationTokens = new Map<string, WebSocket>();
  const devClients = new Set<http.ServerResponse>();
  const sessionFileCache = new Map<string, { mtimeMs: number; size: number; value: any }>();
  let sessionTailWatcher: fs.FSWatcher | null = null;
  let sessionTailDirectoryWatcher: fs.FSWatcher | null = null;
  let sessionTailFile: string | null = null;
  let sessionTailOffset = 0;
  let sessionTailRemainder = Buffer.alloc(0);

  // Store latest context reference for use in command handlers
  let latestCtx: ExtensionContext | null = null;
  type TauCommand = {
    description?: string;
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  };
  const tauCommandHandlers = new Map<string, TauCommand["handler"]>();
  const registerTauCommand = (name: string, command: TauCommand) => {
    tauCommandHandlers.set(name, command.handler);
    pi.registerCommand(name, command);
  };

  // Pending browser dialogs follow Pi's RPC UI semantics: callers can cancel
  // with an AbortSignal, time out, or lose the browser that owns the dialog.
  type BrowserUIResponse = { cancelled?: boolean; value?: string; confirmed?: boolean };
  type PendingBrowserUIRequest = {
    client: WebSocket;
    resolve: (response: BrowserUIResponse) => void;
    cleanup: () => void;
  };
  type BrowserUIOwner = {
    client: WebSocket;
    leaseId: number;
  };
  type BrowserUIExecution = {
    owner: BrowserUIOwner;
    editorText?: string;
  };
  type BrowserUILease = BrowserUIOwner & {
    inputText: string;
    inputObserved: boolean;
    active: boolean;
  };
  type BrowserTerminalInputListener = {
    handler: (data: string) => { consume?: boolean; data?: string } | undefined;
  };
  const pendingRequests = new Map<string, PendingBrowserUIRequest>();
  const extensionStatuses = new Map<string, string>();
  const extensionWidgets = new Map<string, { lines: string[]; placement?: "aboveEditor" | "belowEditor" }>();
  type BrowserTuiComponent = {
    id: string;
    component: { render(width: number): string[]; handleInput?: (data: string) => void };
    tui: { requestRender?: (...args: any[]) => unknown };
    kind: "custom" | "widget";
    owner?: BrowserUIOwner;
    placement?: "aboveEditor" | "belowEditor";
    overlay?: boolean;
  };
  type BrowserTuiObserver = {
    ids: Set<string>;
    requestRender: (...args: any[]) => unknown;
  };
  const browserTuiComponents = new Map<string, BrowserTuiComponent>();
  const browserTuiObservers = new WeakMap<object, BrowserTuiObserver>();
  const browserTuiWidths = new WeakMap<WebSocket, number>();
  let browserTuiSequence = 0;
  let browserTuiRenderQueued = false;
  let uiRequestSequence = 0;
  let proxiedUI: any = null;
  let browserUILeaseSequence = 0;
  let browserTerminalInputSequence = 0;
  let browserUILease: BrowserUILease | null = null;
  const browserUIExecution = new AsyncLocalStorage<BrowserUIExecution>();
  const browserTerminalInputListeners = new Map<number, BrowserTerminalInputListener>();

  function isSubagentChild() {
    return process.env.PI_SUBAGENT_CHILD === "1";
  }

  function browserUIOwnerIsActive(owner: BrowserUIOwner | undefined) {
    return !!owner
      && browserUILease?.active === true
      && sameBrowserInputOwner(owner, browserUILease)
      && clients.has(owner.client)
      && owner.client.readyState === WebSocket.OPEN;
  }

  function getBrowserUIOwner() {
    const owner = browserUIExecution.getStore()?.owner;
    return browserUIOwnerIsActive(owner) ? owner : undefined;
  }

  function getBrowserUIClient() {
    return getBrowserUIOwner()?.client;
  }

  function runWithBrowserUIOwner<T>(owner: BrowserUIOwner, operation: () => T): T {
    return browserUIExecution.run({ owner }, operation);
  }

  function runWithBrowserTerminalInput<T>(owner: BrowserUIOwner, editorText: string, operation: () => T): T {
    return browserUIExecution.run({ owner, editorText }, operation);
  }

  function hasBrowserTerminalInputListeners() {
    return hasBrowserInputListener(browserTerminalInputListeners);
  }

  function acquireBrowserUILease(client: WebSocket, inputText: string): BrowserUIOwner | undefined {
    if (!clients.has(client)) return undefined;
    if (browserUILease) releaseBrowserUILease();
    browserUILease = {
      client,
      leaseId: ++browserUILeaseSequence,
      inputText,
      inputObserved: false,
      active: true,
    };
    emitBrowserTuiComponents();
    return { client, leaseId: browserUILease.leaseId };
  }

  function releaseBrowserUILease(client?: WebSocket) {
    if (!browserUILease || (client && browserUILease.client !== client)) return;
    const owner: BrowserUIOwner = {
      client: browserUILease.client,
      leaseId: browserUILease.leaseId,
    };
    settleBrowserUIRequests((request) => request.client === owner.client, true);
    browserUILease = null;
    emitBrowserTuiComponents();
  }

  function settleBrowserUIRequest(id: string, response: BrowserUIResponse, notifyClient = false) {
    const request = pendingRequests.get(id);
    if (!request) return false;
    pendingRequests.delete(id);
    request.cleanup();
    if (notifyClient) {
      sendTo(request.client, { type: "event", event: { type: "extension_ui_cancel", id } });
    }
    request.resolve(response);
    return true;
  }

  function settleBrowserUIRequests(predicate: (request: PendingBrowserUIRequest) => boolean, notifyClient = false) {
    for (const [id, request] of [...pendingRequests]) {
      if (predicate(request)) settleBrowserUIRequest(id, { cancelled: true }, notifyClient);
    }
  }

  function requestBrowserUI(
    client: WebSocket,
    method: string,
    payload: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) {
    if (opts?.signal?.aborted) return Promise.resolve<BrowserUIResponse>({ cancelled: true });

    // Tau presents one modal at a time. A new request explicitly cancels the
    // previous one for that browser instead of leaving its extension awaiting.
    settleBrowserUIRequests((request) => request.client === client, true);
    const id = `tau-ui-${++uiRequestSequence}`;
    return new Promise<BrowserUIResponse>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settleBrowserUIRequest(id, { cancelled: true }, true);
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
      };

      pendingRequests.set(id, { client, resolve, cleanup });
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => settleBrowserUIRequest(id, { cancelled: true }, true), opts.timeout);
      }
      sendTo(client, { type: "event", event: { type: "extension_ui_request", id, method, ...payload } });
    });
  }

  function broadcastBrowserUI(method: string, payload: Record<string, unknown>) {
    broadcast({
      type: "event",
      event: { type: "extension_ui_request", id: `tau-ui-${++uiRequestSequence}`, method, ...payload },
    });
  }

  function sendBrowserUI(client: WebSocket, method: string, payload: Record<string, unknown>) {
    sendTo(client, {
      type: "event",
      event: { type: "extension_ui_request", id: `tau-ui-${++uiRequestSequence}`, method, ...payload },
    });
  }

  function browserTuiWidth(client: WebSocket) {
    return browserTuiWidths.get(client) ?? 100;
  }

  function renderBrowserTuiComponent(component: BrowserTuiComponent, client: WebSocket) {
    return component.component.render(browserTuiWidth(client));
  }

  function isBrowserTuiComponentInteractive(component: BrowserTuiComponent, client: WebSocket) {
    const lease = browserUILease;
    if (!lease || !browserUIOwnerIsActive(lease) || lease.client !== client) return false;
    if (component.kind === "widget") return hasBrowserTerminalInputListeners();
    return !!component.owner
      && sameBrowserInputOwner(component.owner, lease)
      && (!!component.component.handleInput || hasBrowserTerminalInputListeners());
  }

  function sendBrowserTuiComponent(client: WebSocket, type: "extension_tui_mount" | "extension_tui_update", component: BrowserTuiComponent) {
    sendTo(client, {
      type: "event",
      event: {
        type,
        id: component.id,
        kind: component.kind,
        placement: component.placement,
        overlay: component.overlay,
        interactive: isBrowserTuiComponentInteractive(component, client),
        lines: renderBrowserTuiComponent(component, client),
      },
    });
  }

  function emitBrowserTuiComponents(ids?: Iterable<string>) {
    const targetIds = ids ? [...ids] : [...browserTuiComponents.keys()];
    for (const id of targetIds) {
      const component = browserTuiComponents.get(id);
      if (!component) continue;
      for (const client of clients) {
        sendBrowserTuiComponent(client, "extension_tui_update", component);
      }
    }
  }

  function scheduleBrowserTuiRender() {
    if (browserTuiRenderQueued) return;
    browserTuiRenderQueued = true;
    queueMicrotask(() => {
      browserTuiRenderQueued = false;
      try {
        emitBrowserTuiComponents();
      } catch (error) {
        console.error("[Mirror] Failed to render extension TUI component for browser:", error);
        broadcast({
          type: "event",
          event: { type: "extension_tui_error", error: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  }

  function observeBrowserTui(tui: BrowserTuiComponent["tui"]) {
    const known = browserTuiObservers.get(tui as object);
    if (known) return known;

    const requestRender = tui.requestRender;
    if (typeof requestRender !== "function") {
      throw new Error("Pi TUI component factory did not receive a TUI with requestRender()");
    }
    const observer: BrowserTuiObserver = {
      ids: new Set(),
      requestRender,
    };
    tui.requestRender = function (...args: any[]) {
      const result = observer.requestRender.apply(this, args);
      scheduleBrowserTuiRender();
      return result;
    };
    browserTuiObservers.set(tui as object, observer);
    return observer;
  }

  function mountBrowserTuiComponent(component: BrowserTuiComponent) {
    unmountBrowserTuiComponent(component.id);
    browserTuiComponents.set(component.id, component);
    observeBrowserTui(component.tui).ids.add(component.id);
    for (const client of clients) {
      sendBrowserTuiComponent(client, "extension_tui_mount", component);
    }
  }

  function unmountBrowserTuiComponent(id: string) {
    const component = browserTuiComponents.get(id);
    if (!component) return;
    browserTuiComponents.delete(id);
    browserTuiObservers.get(component.tui as object)?.ids.delete(id);
    broadcast({ type: "event", event: { type: "extension_tui_unmount", id } });
  }

  function releaseBrowserTuiOwnership(client: WebSocket) {
    const released: string[] = [];
    for (const component of browserTuiComponents.values()) {
      if (component.owner?.client === client) {
        component.owner = undefined;
        released.push(component.id);
      }
    }
    if (released.length > 0) emitBrowserTuiComponents(released);
  }

  function replayBrowserTuiComponents(client: WebSocket) {
    for (const component of browserTuiComponents.values()) {
      sendBrowserTuiComponent(client, "extension_tui_mount", component);
    }
  }

  function clearBrowserTuiComponents() {
    for (const id of [...browserTuiComponents.keys()]) {
      unmountBrowserTuiComponent(id);
    }
  }

  function replayBrowserUIState(client: WebSocket) {
    for (const [key, text] of extensionStatuses) {
      sendBrowserUI(client, "setStatus", { statusKey: key, statusText: text });
    }
    for (const [key, widget] of extensionWidgets) {
      sendBrowserUI(client, "setWidget", {
        widgetKey: key,
        widgetLines: widget.lines,
        widgetPlacement: widget.placement,
      });
    }
    replayBrowserTuiComponents(client);
  }

  function clearBrowserUIState() {
    for (const key of extensionStatuses.keys()) {
      broadcastBrowserUI("setStatus", { statusKey: key, statusText: undefined });
    }
    for (const key of extensionWidgets.keys()) {
      broadcastBrowserUI("setWidget", { widgetKey: key, widgetLines: undefined });
    }
    extensionStatuses.clear();
    extensionWidgets.clear();
    browserTerminalInputListeners.clear();
    clearBrowserTuiComponents();
  }

  function installBrowserUIProxy(ui: any) {
    settleBrowserUIRequests(() => true, true);
    if (proxiedUI === ui) return;
    proxiedUI = ui;
    browserTerminalInputListeners.clear();
    const original = {
      select: ui.select.bind(ui),
      confirm: ui.confirm.bind(ui),
      input: ui.input.bind(ui),
      editor: ui.editor.bind(ui),
      notify: ui.notify.bind(ui),
      setStatus: ui.setStatus.bind(ui),
      setWidget: ui.setWidget.bind(ui),
      setTitle: ui.setTitle.bind(ui),
      setEditorText: ui.setEditorText.bind(ui),
      pasteToEditor: ui.pasteToEditor.bind(ui),
      onTerminalInput: ui.onTerminalInput.bind(ui),
      getEditorText: ui.getEditorText.bind(ui),
      custom: ui.custom.bind(ui),
    };

    ui.select = async (title: string, options: string[], opts?: any) => {
      const client = getBrowserUIClient();
      if (!client) return original.select(title, options, opts);
      const response = await requestBrowserUI(client, "select", { title, options, timeout: opts?.timeout }, opts);
      return response?.cancelled ? undefined : response?.value;
    };
    ui.confirm = async (title: string, message: string, opts?: any) => {
      const client = getBrowserUIClient();
      if (!client) return original.confirm(title, message, opts);
      const response = await requestBrowserUI(client, "confirm", { title, message, timeout: opts?.timeout }, opts);
      return response?.cancelled ? false : !!response?.confirmed;
    };
    ui.input = async (title: string, placeholder?: string, opts?: any) => {
      const client = getBrowserUIClient();
      if (!client) return original.input(title, placeholder, opts);
      const response = await requestBrowserUI(client, "input", {
        title,
        placeholder,
        timeout: opts?.timeout,
        secret: opts?.secret === true,
      }, opts);
      return response?.cancelled ? undefined : response?.value;
    };
    ui.editor = async (title: string, prefill?: string) => {
      const client = getBrowserUIClient();
      if (!client) return original.editor(title, prefill);
      const response = await requestBrowserUI(client, "editor", { title, prefill });
      return response?.cancelled ? undefined : response?.value;
    };
    ui.notify = (message: string, type?: string) => {
      original.notify(message, type);
      if (clients.size > 0) broadcastBrowserUI("notify", { message, notifyType: type });
    };
    ui.setStatus = (key: string, text?: string) => {
      original.setStatus(key, text);
      if (text === undefined) extensionStatuses.delete(key);
      else extensionStatuses.set(key, text);
      if (clients.size > 0) broadcastBrowserUI("setStatus", { statusKey: key, statusText: text });
    };
    ui.setWidget = (key: string, content: any, options?: any) => {
      const owner = getBrowserUIOwner();
      const componentId = `widget:${key}`;
      unmountBrowserTuiComponent(componentId);

      if (typeof content === "function") {
        original.setWidget(
          key,
          (tui: any, theme: any) => {
            const component = content(tui, theme);
            mountBrowserTuiComponent({
              id: componentId,
              component,
              tui,
              kind: "widget",
              owner: owner && browserUIOwnerIsActive(owner) ? owner : undefined,
              placement: options?.placement,
            });
            return component;
          },
          options,
        );
        return;
      }

      original.setWidget(key, content, options);
      if (clients.size > 0 && (content === undefined || Array.isArray(content))) {
        broadcastBrowserUI("setWidget", { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      }
      if (content === undefined) extensionWidgets.delete(key);
      else if (Array.isArray(content)) {
        extensionWidgets.set(key, { lines: [...content], placement: options?.placement });
      }
    };
    ui.setTitle = (title: string) => {
      original.setTitle(title);
      if (clients.size > 0) broadcastBrowserUI("setTitle", { title });
    };
    ui.setEditorText = (text: string) => {
      original.setEditorText(text);
      if (clients.size > 0) broadcastBrowserUI("set_editor_text", { text });
    };
    ui.pasteToEditor = (text: string) => {
      // Preserve native paste handling in the TUI; Pi RPC hosts receive the
      // same set_editor_text fallback used by the built-in RPC mode.
      original.pasteToEditor(text);
      if (clients.size > 0) broadcastBrowserUI("set_editor_text", { text });
    };
    ui.onTerminalInput = (handler: BrowserTerminalInputListener["handler"]) => {
      // Browser dispatch runs the original handlers directly while its exact
      // lease is active. Native terminal input revokes that lease first.
      const unsubscribe = original.onTerminalInput((data: string) => {
        if (!browserUIExecution.getStore() && browserUILease) releaseBrowserUILease();
        return handler(data);
      });
      const id = ++browserTerminalInputSequence;
      browserTerminalInputListeners.set(id, { handler });
      emitBrowserTuiComponents();
      return () => {
        unsubscribe();
        if (browserTerminalInputListeners.delete(id)) emitBrowserTuiComponents();
      };
    };
    ui.getEditorText = () => {
      const editorText = browserUIExecution.getStore()?.editorText;
      return editorText === undefined ? original.getEditorText() : editorText;
    };
    ui.custom = (factory: any, options?: any) => {
      const componentId = `custom:${++browserTuiSequence}`;
      const owner = getBrowserUIOwner();
      let closed = false;

      const closeBrowserComponent = () => {
        if (closed) return;
        closed = true;
        unmountBrowserTuiComponent(componentId);
      };

      return original.custom(
        async (tui: any, theme: any, keybindings: any, done: (result: unknown) => void) => {
          const component = await factory(tui, theme, keybindings, (result: unknown) => {
            closeBrowserComponent();
            done(result);
          });
          if (!closed) {
            mountBrowserTuiComponent({
              id: componentId,
              component,
              tui,
              kind: "custom",
              owner: owner && browserUIOwnerIsActive(owner) ? owner : undefined,
              overlay: options?.overlay === true,
            });
          }
          return component;
        },
        options,
      ).finally(closeBrowserComponent);
    };
  }

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function sendTo(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function revokeClientSecurity(ws: WebSocket) {
    const security = clientSecurity.get(ws);
    if (security) liveMutationTokens.delete(security.mutationToken);
    clientSecurity.delete(ws);
  }

  function hasLiveMutationToken(req: http.IncomingMessage): boolean {
    const token = req.headers["x-tau-mutation-token"];
    if (typeof token !== "string") return false;
    const client = liveMutationTokens.get(token);
    return !!client && client.readyState === WebSocket.OPEN;
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: any) {
    const json = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  function closeSessionTail() {
    sessionTailWatcher?.close();
    sessionTailWatcher = null;
    sessionTailDirectoryWatcher?.close();
    sessionTailDirectoryWatcher = null;
    sessionTailFile = null;
    sessionTailOffset = 0;
    sessionTailRemainder = Buffer.alloc(0);
  }

  function readSessionTail(filePath: string) {
    if (sessionTailFile !== filePath) return;
    if (!fs.existsSync(filePath)) {
      closeSessionTail();
      return;
    }

    const size = fs.statSync(filePath).size;
    if (size < sessionTailOffset) {
      // A rewritten session belongs to the next mirror snapshot, not this tail.
      sessionTailOffset = size;
      sessionTailRemainder = Buffer.alloc(0);
      return;
    }
    if (size === sessionTailOffset) return;

    const length = size - sessionTailOffset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, sessionTailOffset);
    } finally {
      fs.closeSync(fd);
    }
    sessionTailOffset = size;

    const chunk = sessionTailRemainder.length > 0
      ? Buffer.concat([sessionTailRemainder, buffer])
      : buffer;
    let lineStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue;
      const line = chunk.subarray(lineStart, index);
      lineStart = index + 1;
      if (line.length === 0) continue;
      const entry = JSON.parse(line.toString("utf8"));
      if (entry.type !== "custom_message") continue;
      broadcast({
        type: "event",
        event: {
          type: "message_start",
          message: {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Date.parse(entry.timestamp),
          },
        },
      });
    }
    sessionTailRemainder = Buffer.from(chunk.subarray(lineStart));
  }

  function armSessionTail(sessionFile: string | undefined) {
    if (sessionFile && sessionTailFile === sessionFile && (sessionTailWatcher || sessionTailDirectoryWatcher)) return;
    closeSessionTail();
    if (!sessionFile) return;

    sessionTailFile = sessionFile;
    if (fs.existsSync(sessionFile)) {
      watchSessionFile(sessionFile, fs.statSync(sessionFile).size);
      return;
    }

    const directory = path.dirname(sessionFile);
    const basename = path.basename(sessionFile);
    sessionTailDirectoryWatcher = fs.watch(directory, (_eventType, filename) => {
      if (filename && filename.toString() !== basename) return;
      if (!fs.existsSync(sessionFile)) return;
      sessionTailDirectoryWatcher?.close();
      sessionTailDirectoryWatcher = null;
      watchSessionFile(sessionFile, 0);
      readSessionTail(sessionFile);
    });
    sessionTailDirectoryWatcher.on("error", (error) => {
      console.error(`[Mirror] Session directory watcher failed: ${error.message}`);
    });

    // Close the creation race between existsSync() and fs.watch().
    if (fs.existsSync(sessionFile)) {
      sessionTailDirectoryWatcher.close();
      sessionTailDirectoryWatcher = null;
      watchSessionFile(sessionFile, 0);
      readSessionTail(sessionFile);
    }
  }

  function watchSessionFile(sessionFile: string, offset: number) {
    sessionTailOffset = offset;
    sessionTailWatcher = fs.watch(sessionFile, () => {
      try {
        readSessionTail(sessionFile);
      } catch (error) {
        console.error("[Mirror] Failed to read session tail:", error);
      }
    });
    sessionTailWatcher.on("error", (error) => {
      console.error(`[Mirror] Session tail watcher failed: ${error.message}`);
    });
  }

  let mirrorUrl = "";
  let tailscaleUrl = "";

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  function stopServer() {
    releaseBrowserUILease();
    settleBrowserUIRequests(() => true, true);
    browserTerminalInputListeners.clear();
    clearBrowserTuiComponents();
    closeSessionTail();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (wss) {
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      wss.close();
      wss = null;
    }
    if (server) {
      server.close();
      server = null;
    }
    if (devWatcher) {
      devWatcher.close();
      devWatcher = null;
    }
    if (devReloadTimer) {
      clearTimeout(devReloadTimer);
      devReloadTimer = null;
    }
    for (const client of devClients) client.end();
    devClients.clear();
    unregisterInstance();
    mirrorUrl = "";
    tailscaleUrl = "";
  }

  // ═══════════════════════════════════════
  // /tau-stop and /tau-start commands
  // ═══════════════════════════════════════
  const stopTauCommand: TauCommand = {
    description: "Stop the Tau mirror server",
    handler: async (_args, ctx) => {
      if (!server) {
        ctx.ui.notify("Tau is not running", "warning");
        return;
      }
      stopServer();
      ctx.ui.setStatus("mirror", "");
      ctx.ui.notify("Tau mirror server stopped", "info");
      console.log("[Mirror] Server stopped via Tau command");
    },
  };
  registerTauCommand("taustop", stopTauCommand);
  registerTauCommand("tau-stop", stopTauCommand);

  const startTauCommand: TauCommand = {
    description: "Start the Tau mirror server",
    handler: async (_args, ctx) => {
      if (server) {
        ctx.ui.notify(`Tau is already running at ${mirrorUrl}`, "warning");
        return;
      }
      startServer(ctx);
      ctx.ui.notify("Tau mirror server starting...", "info");
    },
  };
  registerTauCommand("taustart", startTauCommand);
  registerTauCommand("tau-start", startTauCommand);

  // ═══════════════════════════════════════
  // /qr command — show QR code to connect
  // ═══════════════════════════════════════
  registerTauCommand("tau", {
    description: "Open Tau web UI in browser",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const { exec } = require("node:child_process");
      exec(`open "${mirrorUrl}"`);
      ctx.ui.notify(`Opened ${mirrorUrl}`, "info");
    },
  });

  registerTauCommand("qr", {
    description: "Show QR code for Tau mirror URL",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const qrPageUrl = `${mirrorUrl}/api/qr`;
      ctx.ui.notify(`Tau: ${mirrorUrl}  •  QR: ${qrPageUrl}`, "info");
      // Open in default browser
      const { exec } = require("node:child_process");
      exec(`open "${qrPageUrl}"`);
    },
  });

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "auto_compaction_start", "auto_compaction_end",
    "auto_retry_start", "auto_retry_end",
    "model_select",
  ] as const;

  for (const eventType of eventTypes) {
    pi.on(eventType as any, async (event: any, ctx: ExtensionContext) => {
      latestCtx = ctx;

      // Custom messages are streamed from the session JSONL tail below because
      // Pi does not expose every sendMessage() call through extension events.
      if (event.message?.role === "custom") return;

      // Forward event to all connected browser clients
      // Wrap in { type: "event", event: ... } to match the existing frontend protocol
      broadcast({ type: "event", event: { type: eventType, ...event } });

      // Pi reports provider failures on the finalized assistant message. Keep a
      // stable browser-facing event so the web client cannot get stuck showing
      // only the optimistic user message. agent_end is emitted once after any
      // retry sequence, so the browser gets one final error instead of one per
      // failed retry.
      if (eventType === "agent_end") {
        const failedMessage = Array.isArray(event.messages)
          ? [...event.messages].reverse().find((message: any) =>
              message?.role === "assistant"
              && message.stopReason === "error"
              && message.errorMessage
            )
          : undefined;
        if (failedMessage) {
          broadcast({
            type: "event",
            event: {
              type: "agent_error",
              error: failedMessage.errorMessage,
              stopReason: failedMessage.stopReason,
            },
          });
        }
      }

      if (eventType === "auto_retry_end" && event.success === false && event.finalError) {
        broadcast({
          type: "event",
          event: { type: "agent_error", error: event.finalError, retryExhausted: true },
        });
      }
    });
  }

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    if (!isSubagentChild() && (server || TAU_AUTO_START)) {
      installBrowserUIProxy(ctx.ui);
      armSessionTail(ctx.sessionManager.getSessionFile());
    }
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
  });

  pi.on("input", async (event) => {
    if (!browserUILease) return;
    if (event.source === "extension" && event.text === browserUILease.inputText) {
      browserUILease.inputObserved = true;
      return;
    }
    releaseBrowserUILease();
  });

  pi.on("agent_start", async () => {
    if (!browserUILease?.inputObserved) return;
    browserUILease.active = true;
  });

  pi.on("agent_end", async () => {
    releaseBrowserUILease();
  });

  pi.on("session_before_switch", async () => {
    releaseBrowserUILease();
    clearBrowserUIState();
  });

  pi.on("session_before_fork", async () => {
    releaseBrowserUILease();
    clearBrowserUIState();
  });

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: any) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    const sessionName = pi.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      pi.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({ type: "event", event: { type: "session_name", name: title } });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find(m => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, "")
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = title.substring(0, spaceIdx > 20 ? spaceIdx : 57) + "…";
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    // Get session entries for message history
    const entries = ctx.sessionManager.getEntries();

    // Get model info
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const sessionName = pi.getSessionName();
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      availableThinkingLevels: getSupportedThinkingLevels(model),
      sessionName,
      sessionFile,
      cwd: getCurrentCwd(),
      isStreaming: !ctx.isIdle(),
      contextUsage,
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket, command: any) {
    const id = command.id;
    const ctx = latestCtx;

    const success = (cmd: string, data?: any) => {
      const resp: any = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    if (isWebSocketMutation(command.type) && !relayOnlyClients.has(ws)) {
      const security = clientSecurity.get(ws);
      const failure = mutationAuthorizationFailure({
        isLoopback: security?.isLoopback === true,
        authConfigured: AUTH_CONFIGURED,
        authEnabled,
        basicAuthenticated: security?.basicAuthenticated === true,
        tokenMatches: !!security && command.mutationToken === security.mutationToken,
      });
      if (failure) {
        sendTo(ws, error(command.type || "unknown", failure.message));
        return;
      }
    }

    try {
      switch (command.type) {
        case "extension_ui_response": {
          const request = pendingRequests.get(command.id);
          if (request?.client === ws) settleBrowserUIRequest(command.id, command);
          break;
        }

        case "extension_tui_resize": {
          const width = Number(command.width);
          if (!Number.isInteger(width) || width < 1) {
            throw new Error("Extension TUI width must be a positive integer");
          }
          browserTuiWidths.set(ws, width);
          for (const component of browserTuiComponents.values()) {
            sendBrowserTuiComponent(ws, "extension_tui_update", component);
          }
          break;
        }

        case "extension_tui_input": {
          const component = browserTuiComponents.get(String(command.componentId));
          if (!component) {
            throw new Error(`Unknown extension TUI component: ${String(command.componentId)}`);
          }
          if (typeof command.data !== "string") {
            throw new Error("Extension TUI input must be a string");
          }
          if (typeof command.editorText !== "string") {
            throw new Error("Extension TUI input must include the browser editor text");
          }
          const lease = browserUILease;
          if (!lease || !browserUIOwnerIsActive(lease) || lease.client !== ws) {
            sendTo(ws, error("extension_tui_input", "This extension TUI component is owned by another input surface"));
            break;
          }
          if (component.kind === "widget" && !hasBrowserTerminalInputListeners()) {
            sendTo(ws, error("extension_tui_input", "This extension TUI component is not browser-interactive"));
            break;
          }
          if (component.kind === "custom"
            && (!component.owner || !sameBrowserInputOwner(component.owner, lease))
          ) {
            sendTo(ws, error("extension_tui_input", "This extension TUI component is owned by another input surface"));
            break;
          }
          const input = runWithBrowserTerminalInput(lease, command.editorText, () =>
            dispatchBrowserInput(browserTerminalInputListeners, command.data),
          );
          if (!input.consumed && component.kind === "custom" && component.component.handleInput) {
            component.component.handleInput(input.data);
          }
          if (!input.consumed && component.kind === "custom" && !component.component.handleInput && !hasBrowserTerminalInputListeners()) {
            sendTo(ws, error("extension_tui_input", "This extension TUI component is not browser-interactive"));
            break;
          }
          scheduleBrowserTuiRender();
          break;
        }

        case "run_command": {
          const name = String(command.name || "").trim().replace(/^\/+/, "");
          const args = typeof command.args === "string" ? command.args : "";
          const handler = tauCommandHandlers.get(name);
          const webParityCommand = getWebParityCommand(name);
          if (!name) {
            sendTo(ws, error("run_command", "Command name is required"));
            break;
          }
          if (!handler && !webParityCommand) {
            sendTo(ws, error(
              "run_command",
              `/${name} is registered by Pi but is not executable through the web mirror`,
            ));
            break;
          }
          if (!latestCtx) {
            sendTo(ws, error("run_command", "No active Pi session"));
            break;
          }

          const owner = clients.has(ws)
            ? acquireBrowserUILease(ws, `/${name}${args ? ` ${args}` : ""}`)
            : undefined;
          if (clients.has(ws) && !owner) throw new Error("Browser client is no longer connected");
          try {
            const run = () => handler
              ? handler(args, latestCtx!)
              : webParityCommand!.handler(args, latestCtx!, pi);
            const result = await (owner ? runWithBrowserUIOwner(owner, run) : run());
            const response = success("run_command", result);
            if (webParityCommand?.name === "quit" && result?.status === "shutdown") {
              const shutdownContext = latestCtx;
              ws.send(JSON.stringify(response), (sendError) => {
                if (sendError) console.error("[Mirror] Quit acknowledgement failed:", sendError);
                else shutdownContext?.shutdown();
              });
            } else {
              sendTo(ws, response);
            }
          } catch (commandError) {
            sendTo(ws, error("run_command", errorText(commandError)));
          } finally {
            if (owner && browserUILease?.client === ws && browserUILease.leaseId === owner.leaseId) {
              releaseBrowserUILease(ws);
            }
          }
          break;
        }

        // ─── Prompting ───
        case "prompt": {
          const relayOnly = relayOnlyClients.has(ws);
          const owner = relayOnly
            ? undefined
            : acquireBrowserUILease(ws, String(command.message || ""));
          if (!relayOnly && !owner) throw new Error("Browser client is no longer connected");
          const sendPrompt = () => {
            if (ctx && !ctx.isIdle()) {
              const behavior = command.streamingBehavior || "steer";
              if (behavior === "steer") {
                pi.sendUserMessage(command.message, { deliverAs: "steer" });
              } else {
                pi.sendUserMessage(command.message, { deliverAs: "followUp" });
              }
            } else {
              // Build content with optional images
              if (command.images?.length) {
                const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
                const content: any[] = [{ type: "text", text: command.message || "(see attached image)" }];
                for (const img of command.images) {
                  if (!img.data || typeof img.data !== "string") {
                    console.error("[mirror-server] Skipping image: missing or invalid data");
                    continue;
                  }
                  // Strip data URL prefix if accidentally included
                  const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                  const mimeType = (validMimes.includes(img.mimeType) ? img.mimeType : "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                  console.log(`[mirror-server] Image: mimeType=${mimeType}, dataLen=${data.length}, rawMimeType=${img.mimeType}`);
                  const imageBlock = {
                    type: "image" as const,
                    data: data,
                    mimeType: mimeType,
                  };
                  // Defensive: verify mimeType is actually set (debug crash where it was missing)
                  if (!imageBlock.mimeType) {
                    console.error(`[mirror-server] BUG: mimeType is falsy after assignment! img.mimeType=${img.mimeType}, falling back to image/png`);
                    imageBlock.mimeType = "image/png";
                  }
                  content.push(imageBlock);
                }
                // Only send content array if we actually have images, otherwise just text
                const hasImages = content.some((c: any) => c.type === "image");
                if (hasImages) {
                  pi.sendUserMessage(content);
                } else {
                  pi.sendUserMessage(command.message);
                }
              } else {
                pi.sendUserMessage(command.message);
              }
            }
          };
          if (owner) runWithBrowserUIOwner(owner, sendPrompt);
          else sendPrompt();
          sendTo(ws, success("prompt"));
          break;
        }

        case "steer": {
          const owner = acquireBrowserUILease(ws, String(command.message || ""));
          if (!owner) throw new Error("Browser client is no longer connected");
          runWithBrowserUIOwner(owner, () => pi.sendUserMessage(command.message, { deliverAs: "steer" }));
          sendTo(ws, success("steer"));
          break;
        }

        case "follow_up": {
          const owner = acquireBrowserUILease(ws, String(command.message || ""));
          if (!owner) throw new Error("Browser client is no longer connected");
          runWithBrowserUIOwner(owner, () => pi.sendUserMessage(command.message, { deliverAs: "followUp" }));
          sendTo(ws, success("follow_up"));
          break;
        }

        case "abort": {
          if (ctx) ctx.abort();
          sendTo(ws, success("abort"));
          break;
        }

        // ─── State ───
        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          const model = ctx.model;
          const state = {
            model,
            thinkingLevel: pi.getThinkingLevel(),
            availableThinkingLevels: getSupportedThinkingLevels(model),
            isStreaming: !ctx.isIdle(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionName: pi.getSessionName(),
            cwd: getCurrentCwd(),
          };
          sendTo(ws, success("get_state", state));
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          sendTo(ws, success("get_available_models", getModelChoices(ctx)));
          break;
        }

        case "get_provider_accounts": {
          if (!ctx) {
            sendTo(ws, error("get_provider_accounts", "No context available"));
            break;
          }
          sendTo(ws, success("get_provider_accounts", readProviderAccounts(ctx.modelRegistry)));
          break;
        }

        case "get_enabled_models": {
          if (!ctx) {
            sendTo(ws, error("get_enabled_models", "No context available"));
            break;
          }
          const settings = createContextSettingsManager(SettingsManager, ctx, PI_AGENT_DIR);
          sendTo(ws, success("get_enabled_models", readEnabledModelScope(ctx.modelRegistry, settings)));
          break;
        }

        case "set_enabled_models": {
          if (!ctx) {
            sendTo(ws, error("set_enabled_models", "No context available"));
            break;
          }
          const settings = createContextSettingsManager(SettingsManager, ctx, PI_AGENT_DIR);
          const scope = await writeEnabledModelScope(ctx.modelRegistry, settings, command.modelRefs);
          sendTo(ws, success("set_enabled_models", scope));
          break;
        }

        case "get_about": {
          sendTo(ws, success("get_about", readAboutInfo({
            piVersion: VERSION,
            piPackageDir: getPackageDir(),
            tauPackageJsonPath: path.resolve(__dirname, "../package.json"),
          })));
          break;
        }

        case "get_commands": {
          if (!ctx) {
            sendTo(ws, error("get_commands", "No context available"));
            break;
          }
          sendTo(ws, success("get_commands", { commands: getSlashCommands(pi) }));
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          const choices = getModelChoices(ctx);
          const model = choices.models.find(
            (m: any) => m.provider === command.provider && m.id === command.modelId
          ) || (ctx.modelRegistry as any).find?.(command.provider, command.modelId);
          if (!model) {
            sendTo(ws, error("set_model", `Model not found: ${command.provider}/${command.modelId}`));
            break;
          }
          const modelForPi = stripModelAvailability(model);
          const availability = getModelAvailability(ctx, modelForPi);
          if (!availability.available) {
            const response = error("set_model", availability.reason || "Model authentication is not configured") as any;
            response.data = { model: { provider: model.provider, id: model.id }, availability };
            sendTo(ws, response);
            break;
          }
          const ok = await pi.setModel(modelForPi);
          if (!ok) {
            const response = error("set_model", `Model authentication is not available for ${model.provider}`) as any;
            response.data = { model: { provider: model.provider, id: model.id }, availability };
            sendTo(ws, response);
            break;
          }
          sendTo(ws, success("set_model", {
            model: modelForPi,
            thinkingLevel: pi.getThinkingLevel(),
            availableThinkingLevels: getSupportedThinkingLevels(modelForPi),
          }));
          break;
        }

        case "cycle_model": {
          // Extension API doesn't have cycleModel directly
          // Workaround: get available models, find current, pick next
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const choices = getModelChoices(ctx);
          const availModels = (choices.scopedModels.length > 0 ? choices.scopedModels : choices.models)
            .filter((model: any) => model.availability?.available !== false);
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const idx = availModels.findIndex(
            (m: any) => m.provider === currentModel.provider && m.id === currentModel.id
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          const nextModelForPi = stripModelAvailability(nextModel);
          const ok = await pi.setModel(nextModelForPi);
          if (!ok) {
            sendTo(ws, error("cycle_model", `Model authentication is not available for ${nextModel.provider}`));
            break;
          }
          sendTo(ws, success("cycle_model", {
            model: nextModelForPi,
            thinkingLevel: pi.getThinkingLevel(),
            availableThinkingLevels: getSupportedThinkingLevels(nextModelForPi),
          }));
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          const levels = getSupportedThinkingLevels(ctx?.model);
          const current = pi.getThinkingLevel();
          const idx = levels.indexOf(current);
          const next = levels[(idx + 1) % levels.length];
          pi.setThinkingLevel(next as any);
          const actual = pi.getThinkingLevel();
          sendTo(ws, success("cycle_thinking_level", { level: actual }));
          break;
        }

        case "set_thinking_level": {
          pi.setThinkingLevel(command.level);
          sendTo(ws, success("set_thinking_level", { level: pi.getThinkingLevel() }));
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const sessionManager = ctx.sessionManager;
          const header = sessionManager.getHeader();
          sendTo(ws, success("get_session_stats", {
            ...aggregateSessionStats(sessionManager.getEntries(), sessionManager.getTree()),
            sessionId: sessionManager.getSessionId(),
            sessionFile: sessionManager.getSessionFile(),
            cwd: sessionManager.getCwd(),
            parentSession: header?.parentSession,
            model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
            thinkingLevel: pi.getThinkingLevel(),
            contextUsage: ctx.getContextUsage() || null,
          }));
          break;
        }

        case "set_session_name": {
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          pi.setSessionName(name);
          sendTo(ws, success("set_session_name"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Broadcast compaction start to all clients
            broadcast({ type: "auto_compaction_start" });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: any) => {
                broadcast({ type: "auto_compaction_end", summary: result?.summary });
              },
              onError: (err: any) => {
                broadcast({ type: "auto_compaction_end", summary: `Error: ${err.message}` });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          if (command.outputPath !== undefined) {
            sendTo(ws, error("export_html", "Browser-selected output paths are not supported"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            const outputPath = await exportSessionToHtml(sessionFile, process.cwd());
            sendTo(ws, success("export_html", { path: outputPath }));
          } catch (e: any) {
            sendTo(ws, error("export_html", e.message));
          }
          break;
        }

        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = await buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: AUTH_CONFIGURED, enabled: authEnabled }));
          break;
        }

        case "set_auth": {
          if (!AUTH_CONFIGURED) {
            sendTo(ws, error("set_auth", "No credentials configured. Set tau.user and tau.pass in settings.json"));
            break;
          }
          authEnabled = !!command.enabled;
          saveTauSetting("authEnabled", authEnabled);
          broadcast({ type: "event", event: { type: "auth_changed", enabled: authEnabled } });
          sendTo(ws, success("set_auth", { enabled: authEnabled }));
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: any) {
      sendTo(ws, error(command.type || "unknown", e.message || String(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  function startDevWatcher() {
    if (!TAU_DEV || devWatcher) return;
    devWatcher = fs.watch(STATIC_DIR, { recursive: true }, () => {
      if (devReloadTimer) clearTimeout(devReloadTimer);
      devReloadTimer = setTimeout(() => {
        for (const client of devClients) client.write("data: reload\n\n");
      }, 50);
    });
  }

  function serveDevEvents(req: http.IncomingMessage, res: http.ServerResponse) {
    startDevWatcher();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(": connected\n\n");
    devClients.add(res);
    req.on("close", () => devClients.delete(res));
  }

  function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";
    const isLoopback = isLoopbackAddress(req.socket.remoteAddress);

    if (!isAllowedRequestOrigin(
      req.headers.origin,
      req.headers.host,
      createAllowedHostnames(os.networkInterfaces(), HOST),
    )) {
      sendForbidden(res, "Host must be local and Origin must match it");
      return;
    }

    if (authEnabled && urlPath !== "/api/health" && !hasValidBasicAuth(req)) {
      sendAuthRequired(res);
      return;
    }

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      if (isHttpMutation(req.method)) {
        const failure = mutationAuthorizationFailure({
          isLoopback,
          authConfigured: AUTH_CONFIGURED,
          authEnabled,
          basicAuthenticated: hasValidBasicAuth(req),
          tokenMatches: hasLiveMutationToken(req),
        });
        if (failure?.status === 401) {
          sendAuthRequired(res);
          return;
        }
        if (failure) {
          sendForbidden(res, failure.message);
          return;
        }
      }
      handleApiRoute(req, res, urlPath);
      return;
    }
    if (TAU_DEV && urlPath === "/__tau_dev/events") {
      serveDevEvents(req, res);
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": contentType,
        ...(TAU_DEV ? { "Cache-Control": "no-store" } : {}),
      });
      if (TAU_DEV && filePath === path.join(STATIC_DIR, "index.html")) {
        res.end(fs.readFileSync(filePath, "utf8")
          .replace('<script type="module" src="app.js"></script>', `${DEV_BOOT_SCRIPT}\n  <script type="module" src="app.js"></script>`)
          .replace("</body>", `${DEV_RELOAD_SCRIPT}\n</body>`));
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function getCurrentCwd(): string {
    if (latestCtx) {
      const sessionEntry = latestCtx.sessionManager.getEntries().find((entry: any) => entry.type === "session");
      if (sessionEntry?.cwd) return sessionEntry.cwd;
    }
    return process.cwd();
  }

  function serveWebSettings(res: http.ServerResponse) {
    const settings = readAgentSettings();
    const agentsMd = fs.existsSync(PI_AGENTS_PATH) ? fs.readFileSync(PI_AGENTS_PATH, "utf8") : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      settings,
      agentsMd,
      settingsPath: PI_SETTINGS_PATH,
      agentsPath: PI_AGENTS_PATH,
    }));
  }

  function saveWebSettings(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const settings = readAgentSettings();
        const incoming = payload.settings || {};
        for (const key of ["defaultProvider", "defaultModel", "externalEditor", "mcpServers", "packages"]) {
          if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
          if (incoming[key] === null || incoming[key] === undefined || incoming[key] === "") {
            delete settings[key];
          } else {
            settings[key] = incoming[key];
          }
        }
        writeAgentSettings(settings);
        if (Object.prototype.hasOwnProperty.call(payload, "agentsMd")) {
          fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
          fs.writeFileSync(PI_AGENTS_PATH, String(payload.agentsMd || ""));
        }
        serveWebSettings(res);
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  function getGitState(cwd = getCurrentCwd()) {
    try {
      const inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (inside !== "true") return { isRepo: false, cwd, currentBranch: "", branches: [] };
      const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      const currentBranch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
      const branches = execFileSync("git", ["-C", root, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
        .split("\n")
        .map((branch) => branch.trim())
        .filter(Boolean);
      return { isRepo: true, cwd: root, currentBranch, branches };
    } catch {
      return { isRepo: false, cwd, currentBranch: "", branches: [] };
    }
  }

  function serveGitState(res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getGitState()));
  }

  function checkoutGitBranch(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { branch } = JSON.parse(body);
        if (!branch || typeof branch !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "branch required" }));
          return;
        }
        const state = getGitState();
        if (!state.isRepo) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not a git repository" }));
          return;
        }
        if (!state.branches.includes(branch)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown local branch" }));
          return;
        }
        execFileSync("git", ["-C", state.cwd, "checkout", branch], { stdio: "ignore" });
        const nextState = getGitState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...nextState }));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Tau-Mutation-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/qr") {
      if (!mirrorUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server not ready" }));
        return;
      }
      const qrPromises = [QRCode.toDataURL(mirrorUrl, { width: 256, margin: 2 })];
      if (tailscaleUrl) qrPromises.push(QRCode.toDataURL(tailscaleUrl, { width: 256, margin: 2 }));
      Promise.all(qrPromises).then((dataUrls: string[]) => {
        const tsSection = tailscaleUrl && dataUrls[1]
          ? `<p style="margin-top:24px;color:rgba(255,255,255,0.3);font-size:11px">TAILSCALE</p><img src="${dataUrls[1]}" width="256" height="256" alt="Tailscale QR"><a href="${tailscaleUrl}">${tailscaleUrl}</a>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>Tau — Connect</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}
img{border-radius:12px}a{color:#b87a5c;font-size:18px;margin-top:16px}p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:8px}</style>
</head><body><p style="color:rgba(255,255,255,0.3);font-size:11px">LAN</p><img src="${dataUrls[0]}" width="256" height="256" alt="QR Code"><a href="${mirrorUrl}">${mirrorUrl}</a>${tsSection}<p style="margin-top:16px">Scan to open Tau on your phone</p></body></html>`);
      }).catch((e: any) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "mirror", mirrorUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform }));
      return;
    }

    if (urlPath === "/api/web-settings" && req.method === "GET") {
      serveWebSettings(res);
      return;
    }

    if (urlPath === "/api/web-settings" && req.method === "POST") {
      saveWebSettings(req, res);
      return;
    }

    if (urlPath === "/api/git" && req.method === "GET") {
      serveGitState(res);
      return;
    }

    if (urlPath === "/api/git/checkout" && req.method === "POST") {
      checkoutGitBranch(req, res);
      return;
    }

    // File preview — serve image bytes for thumbnail display in the browser
    if ((urlPath === "/api/file/preview" || urlPath.startsWith("/api/file/preview?")) && req.method === "GET") {
      const previewUrl = new URL(`http://localhost${req.url}`);
      const filePath = previewUrl.searchParams.get("path");
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      const IMAGE_PREVIEW_MIMES: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
      };
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeType = IMAGE_PREVIEW_MIMES[ext];
      if (!mimeType) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a previewable image" }));
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("Not a file");
        res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "max-age=60" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ instances: getRunningInstances() }));
      return;
    }

    if (urlPath === "/api/projects" && req.method === "GET") {
      serveProjectsList(res);
      return;
    }

    if (urlPath === "/api/sidebar-preferences") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ preferences: readSidebarPreferences() }));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", async () => {
          try {
            const mutation = JSON.parse(body);
            const preferences = await mutateSidebarPreferences(mutation);
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ preferences }));
          } catch (error: any) {
            const status = error?.message === "Sidebar preferences are busy" ? 409 : 400;
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error?.message || String(error) }));
          }
        });
        return;
      }
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if ((urlPath === "/api/projects/launch" || urlPath === "/api/sessions/launch") && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const {
            path: projectPath,
            noProject,
            sessionFile: requestedSessionFile,
            command,
            trustMode,
          } = payload;
          if (!noProject && (!projectPath || typeof projectPath !== "string")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          if (command !== undefined && (
            urlPath !== "/api/projects/launch"
            || !command
            || typeof command !== "object"
            || command.type !== "prompt"
          )) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "launch command must be a prompt" }));
            return;
          }
          let sessionFile: string | undefined;
          if (urlPath === "/api/sessions/launch") {
            if (typeof requestedSessionFile !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "valid sessionFile required" }));
              return;
            }
            try {
              sessionFile = resolveSessionFilePath(SESSIONS_DIR, requestedSessionFile, { allowAbsolute: true });
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "valid sessionFile required" }));
              return;
            }
          }
          let piArgs: string[];
          try {
            piArgs = createPiLaunchArgs(trustMode, sessionFile);
          } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            return;
          }
          // Resolve ~ in path
          const launchPath = noProject
            ? USER_HOME
            : projectPath.startsWith("~")
              ? path.join(USER_HOME, projectPath.slice(1))
              : projectPath;
          const resolved = path.resolve(launchPath);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }
          const relayToken = command ? randomUUID() : undefined;
          const launch = (launchId: string) => waitForLaunchedInstance(resolved, launchId, {
            piArgs,
            ...(relayToken ? { relayToken } : {}),
            ...(sessionFile !== undefined ? { expectedSessionFile: sessionFile } : {}),
          });
          const launchResult = sessionFile
            ? await launchOrReuseSession(sessionFile, launch)
            : { instance: await launch(randomUUID()), reused: false };
          const { instance, reused } = launchResult;
          if (command) await relayCommandToInstance(instance, command, relayToken!);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            port: instance.port,
            pid: instance.pid,
            cwd: instance.cwd,
            sessionFile: instance.sessionFile,
            reused,
          }));
        } catch (e: any) {
          const status = e instanceof SessionLaunchBusyError ? 409 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const explicitPath = filesUrl.searchParams.get("path");
        let dirPath = explicitPath || process.cwd();
        if (!explicitPath && latestCtx) {
          try {
            const entries = latestCtx.sessionManager.getEntries();
            const sessionEntry = entries.find((e: any) => e.type === "session");
            if (sessionEntry?.cwd) dirPath = sessionEntry.cwd;
          } catch {}
        }
        serveFileList(res, dirPath);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // File browser: open file natively
    if (urlPath === "/api/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const { execFile } = await import("node:child_process");
          if (process.platform === "win32") {
            const { exec } = await import("node:child_process");
            const safe = fp.replace(/'/g, "''").replace(/"/g, '');
            exec(`powershell -NoProfile -WindowStyle Hidden -Command "& { $wsh = New-Object -ComObject WScript.Shell; $wsh.Run('explorer \\"${safe}\\"', 1, $false) }"`, (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else if (process.platform === "darwin") {
            execFile("open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else {
            execFile("xdg-open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session file endpoint: /api/sessions/<relative session path>
    const sessionMatch = urlPath.split("?", 1)[0].match(/^\/api\/sessions\/(.+)$/);
    if (sessionMatch && req.method === "GET") {
      try {
        serveSessionFile(res, decodeURIComponent(sessionMatch[1]));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "valid session path required" }));
      }
      return;
    }

    // Session delete
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { filePath } = JSON.parse(body);
          if (!filePath || typeof filePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const sessionFile = resolveSessionFilePath(SESSIONS_DIR, filePath, { allowAbsolute: true });
          fs.unlinkSync(sessionFile);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          const status = err?.code === "ENOENT" ? 404 : 400;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: status === 404 ? "Session not found" : "valid sessionFile required" }));
        }
      });
      return;
    }

    // Memoryd check
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ═══════════════════════════════════════
  // Sessions list endpoint
  // ═══════════════════════════════════════
  function getTmuxSessionFiles(): Set<string> {
    if (process.platform === "win32") return new Set();
    try {
      const { execSync } = require("node:child_process");
      // Get tmux pane PIDs
      const paneOutput = execSync("tmux list-panes -a -F '#{pane_pid}' 2>/dev/null", { encoding: "utf8" });
      const tmuxFiles = new Set<string>();

      for (const shellPid of paneOutput.trim().split("\n").filter(Boolean)) {
        try {
          // Find Pi (node) processes that are children of tmux shells
          const children = execSync(`pgrep -P ${shellPid} 2>/dev/null`, { encoding: "utf8" });
          for (const pid of children.trim().split("\n").filter(Boolean)) {
            // Check what .jsonl files this process has open
            const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep '\\.jsonl'`, { encoding: "utf8" });
            for (const line of lsofOut.trim().split("\n").filter(Boolean)) {
              const match = line.match(/\/.+\.jsonl$/);
              if (match) tmuxFiles.add(match[0]);
            }
          }
        } catch { /* no match */ }
      }
      return tmuxFiles;
    } catch {
      return new Set();
    }
  }

  async function serveProjectsList(res: http.ServerResponse) {
    const projectsDir = TAU_SETTINGS.projectsDir;
    try {
      const instances = getRunningInstances();
      const projectInfo = new Map<string, { name: string; path: string; sessionCount: number; lastActive: number | null; active: boolean }>();

      const sessionInfo = new Map<string, { count: number; lastActive: number }>();
      if (fs.existsSync(SESSIONS_DIR)) {
        const readline = await import("node:readline");
        for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const sessionDir = path.join(SESSIONS_DIR, dir.name);
          const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
          for (const f of files) {
            try {
              const filePath = resolveSessionFilePath(SESSIONS_DIR, path.join(sessionDir, f), { allowAbsolute: true });
              const parsed = await parseSessionFile(filePath, readline);
              if (!parsed?.cwd || isTempProjectPath(parsed.cwd) || path.resolve(parsed.cwd) === path.resolve(USER_HOME)) continue;
              const cwd = parsed.cwd;
              const stat = fs.statSync(filePath);
              const info = sessionInfo.get(cwd) || { count: 0, lastActive: 0 };
              info.count += 1;
              info.lastActive = Math.max(info.lastActive, stat.mtimeMs);
              sessionInfo.set(cwd, info);
            } catch {}
          }
        }
      }

      const addProject = (projectPath: string) => {
        if (!projectPath) return;
        const resolvedPath = projectPath.startsWith("~")
          ? path.join(process.env.HOME || "", projectPath.slice(1))
          : projectPath;
        const info = sessionInfo.get(resolvedPath) || { count: 0, lastActive: 0 };
        projectInfo.set(resolvedPath, {
          name: path.basename(resolvedPath) || resolvedPath,
          path: resolvedPath,
          sessionCount: info.count,
          lastActive: info.lastActive || null,
          active: instances.some(i => i.cwd === resolvedPath) || resolvedPath === getCurrentCwd(),
        });
      };

      if (projectsDir) {
        const resolved = projectsDir.startsWith("~")
          ? path.join(process.env.HOME || "", projectsDir.slice(1))
          : projectsDir;
        if (fs.existsSync(resolved)) {
          for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              addProject(path.join(resolved, entry.name));
            }
          }
        }
      }

      const currentCwd = getCurrentCwd();
      if (!isTempProjectPath(currentCwd) && path.resolve(currentCwd) !== path.resolve(USER_HOME)) addProject(currentCwd);
      for (const projectPath of sessionInfo.keys()) {
        addProject(projectPath);
      }

      const projects = Array.from(projectInfo.values()).sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return (b.lastActive || 0) - (a.lastActive || 0) || a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects, taskPath: USER_HOME }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      const tmuxFiles = getTmuxSessionFiles();
      const readline = await import("node:readline");
      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const projects: any[] = [];
      let tasks: any = null;

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

        const sessions: any[] = [];
        let projectPath = "";

        for (const file of files) {
          try {
            const filePath = resolveSessionFilePath(SESSIONS_DIR, path.join(projectDir, file), { allowAbsolute: true });
            const parsed = await parseSessionFile(filePath, readline);
            if (parsed?.cwd && !isTempProjectPath(parsed.cwd)) {
              projectPath ||= parsed.cwd;
              const stat = fs.statSync(filePath);
              const isTmux = tmuxFiles.has(filePath);
              sessions.push({ ...parsed, file, filePath, mtime: stat.mtimeMs, ...(isTmux && { tmux: true }) });
            }
          } catch { /* skip */ }
        }

        sessions.sort((a, b) => b.mtime - a.mtime);

        if (sessions.length > 0) {
          const project = {
            path: projectPath,
            dirName: dir.name,
            branch: getGitState(projectPath).currentBranch,
            sessions,
          };
          if (path.resolve(projectPath) === path.resolve(USER_HOME)) {
            tasks = project;
          } else {
            projects.push(project);
          }
        }
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.mtime || 0;
        const bTime = b.sessions[0]?.mtime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects, tasks }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFile(res: http.ServerResponse, requestedPath: string) {
    let filePath: string;
    try {
      filePath = resolveSessionFilePath(SESSIONS_DIR, requestedPath);
    } catch (error: any) {
      const status = error?.code === "ENOENT" ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: status === 404 ? "Session not found" : "valid session path required" }));
      return;
    }

    const entries: any[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try { entries.push(JSON.parse(buffer)); } catch { /* skip */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: any) {
    const stat = fs.statSync(filePath);
    const cached = sessionFileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: any = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && typeof entry.name === "string") sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: any) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch { /* skip */ }
    }

    rl.close();
    stream.destroy();

    const value = !header?.id || userMessageCount === 0 ? null : {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
    sessionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash",
    ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
    "venv", ".venv", "env", ".env.local",
    ".pi", "coverage", ".nyc_output", ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items: any[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (IGNORED_NAMES.has(entry.name)) continue;

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip inaccessible */ }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = resolveSessionFilePath(SESSIONS_DIR, path.join(projectDir, file), { allowAbsolute: true });
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let sessionCwd = "";
            let skipSession = false;
            let firstMessage = "";
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                  sessionCwd = entry.cwd || "";
                  if (isTempProjectPath(sessionCwd)) {
                    skipSession = true;
                    break;
                  }
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text && text.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet = (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch { /* skip line */ }
            }

            rl.close();
            stream.destroy();

            if (skipSession) continue;

            if (matches.length > 0) {
              results.push({
                filePath,
                project: sessionCwd,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch { /* skip file */ }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable)
  // ═══════════════════════════════════════
  function startServer(ctx: ExtensionContext) {
    if (server) return; // Already running

    latestCtx = ctx;
    installBrowserUIProxy(ctx.ui);
    armSessionTail(ctx.sessionManager.getSessionFile());

    // Clean up zombie instances from killed tmux panes etc.
    cleanupZombieInstances();

    server = http.createServer(serveStaticFile);
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (!isAllowedRequestOrigin(
        request.headers.origin,
        request.headers.host,
        createAllowedHostnames(os.networkInterfaces(), HOST),
      )) {
        socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nHost must be local and Origin must match it");
        socket.destroy();
        return;
      }
      if (request.url !== "/ws") {
        socket.destroy();
        return;
      }

      const relayHeader = request.headers["x-tau-relay-token"];
      const relayRequested = relayHeader !== undefined;
      const relayOnly = typeof relayHeader === "string" && relayPolicy.consumeToken(relayHeader);
      if (relayRequested && !relayOnly) {
        socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nInvalid relay token");
        socket.destroy();
        return;
      }
      if (!relayOnly && authEnabled && !hasValidBasicAuth(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Tau\"\r\n\r\n");
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(request, socket, head, (ws) => {
        if (relayOnly) relayOnlyClients.add(ws);
        wss!.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws, request) => {
      const relayOnly = relayOnlyClients.has(ws);
      if (relayOnly) {
        console.log("[Mirror] Prompt relay connected");
      } else {
        console.log("[Mirror] Browser client connected");
        const mutationToken = randomUUID();
        clientSecurity.set(ws, {
          mutationToken,
          isLoopback: isLoopbackAddress(request.socket.remoteAddress),
          basicAuthenticated: hasValidBasicAuth(request),
        });
        liveMutationTokens.set(mutationToken, ws);
        clients.add(ws);
        (ws as any).isAlive = true;

        ws.on("pong", () => {
          (ws as any).isAlive = true;
        });

        sendTo(ws, { type: "connection_hello", mutationToken });
        sendTo(ws, { type: "state", isStreaming: false, mode: "mirror" });

        // The client clears transient extension chrome when it receives the
        // snapshot, so replay it only after that reset has completed.
        if (latestCtx) {
          buildStateSnapshot(latestCtx).then((snapshot) => {
            sendTo(ws, snapshot);
            replayBrowserUIState(ws);
          });
        } else {
          replayBrowserUIState(ws);
        }
      }

      const closeProtocolError = (message: string) => {
        sendTo(ws, { type: "error", error: message });
        ws.close(1002, message);
      };

      ws.on("message", (data) => {
        let command: any;
        try {
          command = JSON.parse(data.toString());
        } catch (error) {
          console.error("[Mirror] Failed to parse client message:", error);
          closeProtocolError("Invalid WebSocket command frame");
          return;
        }
        if (!isWebSocketCommandFrame(command)) {
          closeProtocolError("Invalid WebSocket command frame");
          return;
        }
        if (relayOnly && !relayPolicy.acceptCommand(command.type)) {
          sendTo(ws, {
            type: "response",
            command: command.type,
            success: false,
            error: "Prompt relay accepts exactly one prompt",
            id: command.id,
          });
          ws.close(1008, "relay prompt required");
          return;
        }

        void handleCommand(ws, command)
          .then(() => {
            if (relayOnly) ws.close(1000, "prompt relayed");
          })
          .catch((error) => {
            console.error("[Mirror] Unhandled command failure:", error);
            sendTo(ws, { type: "error", error: "Command handling failed" });
            ws.close(1011, "command handling failed");
          });
      });

      if (relayOnly) {
        ws.on("close", () => console.log("[Mirror] Prompt relay disconnected"));
        ws.on("error", (error) => console.error("[Mirror] Prompt relay error:", error));
        return;
      }

      ws.on("close", () => {
        console.log("[Mirror] Browser client disconnected");
        releaseBrowserUILease(ws);
        releaseBrowserTuiOwnership(ws);
        settleBrowserUIRequests((request) => request.client === ws);
        browserTuiWidths.delete(ws);
        revokeClientSecurity(ws);
        clients.delete(ws);
      });

      ws.on("error", (e) => {
        console.error("[Mirror] Client error:", e);
        releaseBrowserUILease(ws);
        releaseBrowserTuiOwnership(ws);
        settleBrowserUIRequests((request) => request.client === ws);
        browserTuiWidths.delete(ws);
        revokeClientSecurity(ws);
        clients.delete(ws);
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          releaseBrowserUILease(client);
          releaseBrowserTuiOwnership(client);
          browserTuiWidths.delete(client);
          revokeClientSecurity(client);
          clients.delete(client);
          continue;
        }

        if (!(client as any).isAlive) {
          try { client.terminate(); } catch {}
          releaseBrowserUILease(client);
          releaseBrowserTuiOwnership(client);
          browserTuiWidths.delete(client);
          revokeClientSecurity(client);
          clients.delete(client);
          continue;
        }

        (client as any).isAlive = false;
        try { client.ping(); } catch {}
      }
    }, 20000);

    const tryListen = (port: number, maxAttempts = 10) => {
      const handleListening = () => {
        server!.off("error", handleError);
        onListening(port);
      };
      const handleError = (err: any) => {
        server!.off("listening", handleListening);
        if (err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          // Check if a stale Tau instance owns this port and kill it
          const instances = getRunningInstances();
          const stale = instances.find(i => i.port === port && i.pid !== process.pid);
          if (stale && isZombieProcess(stale.pid)) {
            console.log(`[Mirror] Port ${port} in use by stale Tau instance (PID ${stale.pid}), killing...`);
            try { process.kill(stale.pid, "SIGTERM"); } catch {}
            // Wait briefly then retry the same port
            setTimeout(() => {
              tryListen(port, maxAttempts);
            }, 500);
            return;
          }
          console.log(`[Mirror] Port ${port} in use, trying ${port + 1}...`);
          tryListen(port + 1, maxAttempts);
        } else {
          console.error(`[Mirror] Failed to start server:`, err.message);
        }
      };
      server!.once("listening", handleListening);
      server!.once("error", handleError);
      server!.listen(port, HOST);
    };

    const onListening = (port: number) => {
      const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

      let localIp = "localhost";
      let tailscaleIp = "";

      if (!isLoopback) {
        // Get local IP for display — prefer en0/en1 (WiFi/Ethernet) over bridges/VPNs
        const nets = require("node:os").networkInterfaces();
        let fallbackIp = "";
        const preferred = ["en0", "en1"];
        for (const name of preferred) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal) {
              localIp = net.address;
              break;
            }
          }
          if (localIp !== "localhost") break;
        }
        if (localIp === "localhost") {
          for (const name of Object.keys(nets)) {
            if (name.startsWith("bridge") || name.startsWith("utun") || name.startsWith("lo")) continue;
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal && (net.address.startsWith("192.168.") || net.address.startsWith("10."))) {
                localIp = net.address;
                break;
              }
            }
            if (localIp !== "localhost") break;
          }
        }
        if (localIp === "localhost" && fallbackIp) localIp = fallbackIp;

        // Detect Tailscale IP (100.x.x.x CGNAT range)
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal && net.address.startsWith("100.")) {
              tailscaleIp = net.address;
              break;
            }
          }
          if (tailscaleIp) break;
        }
      }

      mirrorUrl = `http://${localIp}:${port}`;
      tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : "";
      console.log(`[Mirror] Tau mirror server running on ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}`);
      ctx.ui.setStatus("mirror", `Mirror: ${localIp}:${port}${tailscaleIp ? ` • TS: ${tailscaleIp}:${port}` : ""}`);

      // Register this instance
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());

      ctx.ui.notify(`Tau mirror: ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}  •  /qr for QR code`, "info");
    };

    tryListen(PORT);
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Skip mirror startup in subagent child processes
    // (pi-subagents sets PI_SUBAGENT_CHILD=1; child processes loading Tau
    // should not attempt to start their own mirror server)
    if (isSubagentChild()) {
      console.log("[Mirror] Subagent child process detected (PI_SUBAGENT_CHILD=1), skipping auto-start.");
      return;
    }

    if (!TAU_AUTO_START) {
      console.log("[Mirror] Tau auto-start disabled (TAU_DISABLED=1). Use /tau-start to start manually.");
      return;
    }

    startServer(ctx);
  });

  // ═══════════════════════════════════════
  // Cleanup on shutdown
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async () => {
    stopServer();
    console.log("[Mirror] Server shut down");
  });
}
