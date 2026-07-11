const CONTROL_KEY_INPUT = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  Escape: '\x1b',
  Enter: '\r',
  Tab: '\t',
  Backspace: '\x7f',
};

const ANSI_COLORS = [
  '#1f2328', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#f6f8fa',
  '#6e7781', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#a371f7', '#39c5cf', '#ffffff',
];

function xtermColor(index) {
  if (index < 16) return ANSI_COLORS[index] || ANSI_COLORS[7];
  if (index >= 232) {
    const value = 8 + (index - 232) * 10;
    return `rgb(${value}, ${value}, ${value})`;
  }
  const value = index - 16;
  const values = [0, 95, 135, 175, 215, 255];
  const red = values[Math.floor(value / 36)];
  const green = values[Math.floor((value % 36) / 6)];
  const blue = values[value % 6];
  return `rgb(${red}, ${green}, ${blue})`;
}

function resetAnsiStyle(style) {
  style.foreground = undefined;
  style.background = undefined;
  style.bold = false;
  style.dim = false;
  style.italic = false;
  style.underline = false;
  style.inverse = false;
}

function applyAnsiCodes(style, rawCodes) {
  const codes = rawCodes === '' ? [0] : rawCodes.split(';').map(Number);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) resetAnsiStyle(style);
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 39) style.foreground = undefined;
    else if (code === 49) style.background = undefined;
    else if (code >= 30 && code <= 37) style.foreground = ANSI_COLORS[code - 30];
    else if (code >= 40 && code <= 47) style.background = ANSI_COLORS[code - 40];
    else if (code >= 90 && code <= 97) style.foreground = ANSI_COLORS[code - 90 + 8];
    else if (code >= 100 && code <= 107) style.background = ANSI_COLORS[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const mode = codes[++index];
      const target = code === 38 ? 'foreground' : 'background';
      if (mode === 5) {
        style[target] = xtermColor(codes[++index]);
      } else if (mode === 2) {
        const red = codes[++index];
        const green = codes[++index];
        const blue = codes[++index];
        style[target] = `rgb(${red}, ${green}, ${blue})`;
      }
    }
  }
}

function appendStyledText(element, text, style) {
  if (!text) return;
  const span = document.createElement('span');
  const foreground = style.inverse ? style.background : style.foreground;
  const background = style.inverse ? style.foreground : style.background;
  if (foreground) span.style.color = foreground;
  if (background) span.style.backgroundColor = background;
  if (style.bold) span.style.fontWeight = '700';
  if (style.dim) span.style.opacity = '0.68';
  if (style.italic) span.style.fontStyle = 'italic';
  if (style.underline) span.style.textDecoration = 'underline';
  span.textContent = text;
  element.appendChild(span);
}

function appendAnsiFragment(element, line, style) {
  const sgr = /\x1b\[([0-9;]*)m/g;
  let cursor = 0;
  for (const match of line.matchAll(sgr)) {
    appendStyledText(element, line.slice(cursor, match.index), style);
    applyAnsiCodes(style, match[1]);
    cursor = match.index + match[0].length;
  }
  appendStyledText(element, line.slice(cursor), style);
}

export function renderAnsiText(element, text) {
  element.replaceChildren();
  const style = {};
  resetAnsiStyle(style);
  const lines = String(text).replaceAll('\x1b_pi:c\x07', '').split('\n');

  lines.forEach((line, lineIndex) => {
    appendAnsiFragment(element, line, style);
    if (lineIndex < lines.length - 1) element.appendChild(document.createTextNode('\n'));
  });
}

function renderAnsiLines(pre, lines) {
  renderAnsiText(pre, lines.map(String).join('\n'));
}

function terminalInput(event) {
  if (CONTROL_KEY_INPUT[event.key]) return CONTROL_KEY_INPUT[event.key];
  if (event.ctrlKey && event.key.length === 1) {
    return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
  }
  if (event.key.length !== 1 || event.metaKey) return undefined;
  return `${event.altKey ? '\x1b' : ''}${event.key}`;
}

export class ExtensionTuiBridge {
  constructor(wsClient, aboveContainer, belowContainer) {
    this.wsClient = wsClient;
    this.components = new Map();
    this.aboveRoot = document.createElement('div');
    this.aboveRoot.className = 'extension-tui-widgets';
    this.belowRoot = document.createElement('div');
    this.belowRoot.className = 'extension-tui-widgets';
    aboveContainer.after(this.aboveRoot);
    belowContainer.before(this.belowRoot);

    this.overlayRoot = document.createElement('div');
    this.overlayRoot.className = 'extension-tui-overlay hidden';
    document.body.appendChild(this.overlayRoot);

    this.wsClient.addEventListener('connected', () => this.reportWidth());
    this.resizeObserver = new ResizeObserver(() => this.reportWidth());
    this.resizeObserver.observe(document.documentElement);
  }

  mount(event) {
    this.upsert(event);
    this.reportWidth();
  }

  update(event) {
    this.upsert(event);
  }

  unmount(id) {
    const entry = this.components.get(id);
    if (!entry) return;
    entry.element.remove();
    this.components.delete(id);
    this.overlayRoot.classList.toggle('hidden', !this.hasCustomComponent());
  }

  clear() {
    for (const entry of this.components.values()) entry.element.remove();
    this.components.clear();
    this.overlayRoot.classList.add('hidden');
  }

  upsert(event) {
    if (!Array.isArray(event.lines)) throw new TypeError('Extension TUI event must include rendered lines');
    let entry = this.components.get(event.id);
    if (!entry) {
      const element = document.createElement('section');
      element.className = event.kind === 'custom' ? 'extension-tui-custom' : 'extension-tui-widget';
      element.setAttribute('role', 'region');
      element.setAttribute('aria-label', event.kind === 'custom' ? 'Extension view' : 'Extension widget');
      const pre = document.createElement('pre');
      pre.className = 'extension-tui-output';
      element.appendChild(pre);
      element.addEventListener('keydown', (keyboardEvent) => this.handleInput(event.id, keyboardEvent));
      entry = { element, pre, kind: event.kind, placement: event.placement, overlay: event.overlay, interactive: false };
      this.components.set(event.id, entry);
      this.mountElement(entry);
    }
    entry.kind = event.kind;
    entry.placement = event.placement;
    entry.overlay = event.overlay;
    entry.interactive = event.interactive === true;
    entry.element.tabIndex = entry.interactive ? 0 : -1;
    entry.element.setAttribute('aria-disabled', String(!entry.interactive));
    renderAnsiLines(entry.pre, event.lines);
    this.mountElement(entry);
    if (entry.kind === 'custom') {
      this.overlayRoot.classList.remove('hidden');
      if (entry.interactive) requestAnimationFrame(() => entry.element.focus());
    }
  }

  mountElement(entry) {
    const target = entry.kind === 'custom'
      ? this.overlayRoot
      : entry.placement === 'belowEditor' ? this.belowRoot : this.aboveRoot;
    if (entry.element.parentElement !== target) target.appendChild(entry.element);
  }

  handleInput(componentId, event) {
    if (!this.components.get(componentId)?.interactive) return;
    const data = terminalInput(event);
    if (data === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const editor = document.getElementById('message-input');
    if (!(editor instanceof HTMLTextAreaElement)) {
      throw new Error('Tau message editor is unavailable');
    }
    this.wsClient.send({ type: 'extension_tui_input', componentId, data, editorText: editor.value });
  }

  hasCustomComponent() {
    for (const component of this.components.values()) {
      if (component.kind === 'custom') return true;
    }
    return false;
  }

  reportWidth() {
    if (this.wsClient.connectionState !== 'open') return;
    const width = this.measureColumns();
    this.wsClient.send({ type: 'extension_tui_resize', width });
  }

  measureColumns() {
    const probe = document.createElement('span');
    probe.className = 'extension-tui-measure';
    probe.textContent = '0000000000';
    document.body.appendChild(probe);
    const characterWidth = probe.getBoundingClientRect().width / probe.textContent.length;
    probe.remove();
    const widgetWidth = Math.max(
      this.aboveRoot.getBoundingClientRect().width,
      this.belowRoot.getBoundingClientRect().width,
    );
    const hostWidth = this.hasCustomComponent()
      ? Math.min(900, Math.max(1, document.documentElement.clientWidth - 48))
      : Math.min(900, Math.max(1, widgetWidth));
    // The rendered terminal component sits inside the section's horizontal padding.
    return Math.max(1, Math.floor(Math.max(1, hostWidth - 26) / characterWidth));
  }
}
