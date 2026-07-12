# Pi Tau Codex

A Codex-like web UI for [Pi](https://github.com/badlogic/pi-mono). It mirrors the running terminal session in the browser as a standalone Pi extension, so `pi-client web` can stay a thin launcher instead of bundling web UI code.

![Tau dark mode](docs/images/dark.png)

![Tau terracotta theme](docs/images/terracotta.png)

![Settings](docs/images/settings.png)

![Commands](docs/images/commands.png)

## What it does

Tau connects to your running Pi TUI and gives you a second view in the browser. Same session, same messages, same tools — just a different screen. Type in the terminal or the browser, both stay in sync.

- **Live mirroring** — streams messages, tool calls, and thinking blocks in real-time
- **Codex-style controls** — tabbed settings, slash command menu, branch switcher, project switcher
- **Pi extension UI** — renders RPC-style extension dialogs, status, widgets, titles, editor text, and custom messages
- **Works on any device** — open it on your phone, tablet, or another monitor
- **Session browser** — view history from any past session
- **No extra process** — the Pi extension *is* the server

## Install

```bash
pi install npm:@averyyy/pi-tau-codex
```

Or from git:

```bash
pi install git:github.com/Averyyy/pi-tau-codex
```

`pi-client web` checks the shared `~/.pi/agent/settings.json` extension list and prints the install command above when this package is not installed.

## Usage

1. Start Pi normally in your terminal
2. Open the URL shown in the status bar (default: `http://localhost:3001`)
3. That's it

Type `/qr` in the terminal to show a QR code and scan it to access via your phone.

## Features

### Chat
- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls (red/green lines)
- Scroll-to-bottom button with new message indicator
- Message queuing — type while the agent is working, messages queue and auto-send
- Slash command autocomplete when `/` is typed in any empty position inside the composer

### Session Management
- Browse all past sessions grouped by project
- Scoped Projects plus a collapsed Archived Projects section
- Bottom-left project switcher with a No Project option
- Full-text search across all session history with highlighted snippets
- Sorted by last modified (most recent first)
- Live session marked with a green dot
- Historical sessions are read-only
- Inline session rename
- Favourite sessions, tags, and filtering

### Model & Thinking
- Model picker with search/filter and keyboard support
- Thinking level toggle (off/low/medium/high)
- Local git branch picker when the active project is a git repository
- Token usage percentage with context window visualiser
- Cost tracking per session

### Voice Input
- Mic button in the input area using Web Speech API (on-device dictation)
- Live transcription into the textarea
- Pulses red while recording

### File Browser
- Right sidebar with lazy-loaded file tree
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### Compaction
- Manual context compaction with status display
- Auto-compaction support

### PWA
- Installable as a standalone app on iOS, Android, and macOS
- Custom app icons
- Service worker with network-first caching

## Configuration

Environment variables (set before starting Pi):

| Variable          | Default     | Description                                                                  |
|-------------------|-------------|------------------------------------------------------------------------------|
| `TAU_MIRROR_PORT` | `3001`      | Server port                                                                  |
| `TAU_HOST`        | `0.0.0.0`   | Bind address. Set to `127.0.0.1` to restrict to localhost only               |
| `TAU_STATIC_DIR`  | *(bundled)* | Override static files path                                                   |
| `TAU_DISABLED`    | `0`         | Set to `1` to disable Tau (it stays installed but won't start the server)    |
| `TAU_USER`        | *(none)*    | HTTP Basic Auth username (both `TAU_USER` and `TAU_PASS` required to enable) |
| `TAU_PASS`        | *(none)*    | HTTP Basic Auth password                                                     |
| `TAU_LINUX_TERMINAL` | *(required for web-launched Pi on Linux)* | Terminal to open: `gnome-terminal`, `konsole`, `kitty`, `alacritty`, `wezterm`, or `xterm` |

### Interactive session launch

Starting or resuming a session from Tau opens Pi in a real terminal, so the Pi TUI stays usable alongside the browser. macOS opens Terminal and Windows opens a visible PowerShell window. On Linux, set an explicit supported terminal before starting Pi, for example:

```bash
TAU_LINUX_TERMINAL=gnome-terminal pi
```

Tau checks both that terminal and `pi` are executable before it opens the new session. An absent or unsupported Linux terminal setting is returned as an actionable launch error instead of starting Pi without a TTY.

### Authentication

Tau supports optional HTTP Basic Auth (browser-native login popup).

**1. Set credentials** — add to `~/.pi/agent/settings.json`:

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

Or via environment variables: `TAU_USER=pi TAU_PASS=secret pi`

**2. Toggle on/off** — once credentials are configured, a "Require login" toggle appears in Settings within the Tau web UI. Enabling it reloads the page so the browser can request your credentials. Disabling it takes effect without a reload. The setting persists across restarts.

With authentication disabled, LAN clients can read Tau state, but mutations are rejected; only a loopback client with a live connection token can write. With authentication enabled, HTTP and WebSocket access requires Basic Auth. The `/api/health` endpoint remains open for monitoring.

### Start / Stop

Control Tau at runtime without uninstalling:

```
/tau-stop     Stop the mirror server
/tau-start    Start it again
```

To prevent Tau from auto-starting (e.g. in multi-session or dev container workflows):

```bash
TAU_DISABLED=1 pi
```

You can still start it manually with `/tau-start` in that session.

## How it works

Tau is a [Pi extension](https://github.com/badlogic/pi-mono#extensions) that starts an HTTP + WebSocket server inside the Pi process. The extension subscribes to all Pi events and forwards them to connected browser clients. Commands from the browser are executed via the extension API against the same agent session.

```
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
│  Pi TUI     │     │  Pi Process                  │     │  Browser    │
│  (terminal) │◄───►│                              │◄───►│  (Tau)      │
│             │     │  tau extension               │     │             │
└─────────────┘     │    ↳ HTTP + WS on :3001      │     └─────────────┘
                    └──────────────────────────────┘
```

There's no separate server to run. The extension auto-loads when Pi starts and shuts down when Pi exits.

## Development

Clone and point the extension at the local static files:

```bash
git clone https://github.com/Averyyy/pi-tau-codex.git
cd pi-tau-codex
TAU_STATIC_DIR=$(pwd)/public pi
```

Edit the files in `public/` — refresh the browser to see changes.

## License

MIT
