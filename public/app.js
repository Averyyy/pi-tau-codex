/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { SessionSidebar } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
const dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const sessionSearchInput = document.getElementById('session-search-input');
const typingIndicator = document.getElementById('typing-indicator');

const sessionCostEl = document.getElementById('session-cost');
const tokenUsageEl = document.getElementById('token-usage');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const messagesContainer = document.getElementById('messages');
const branchDropdown = document.getElementById('branch-dropdown');
const branchDropdownBtn = document.getElementById('branch-dropdown-btn');
const branchDropdownLabel = document.getElementById('branch-dropdown-label');
const branchDropdownMenu = document.getElementById('branch-dropdown-menu');
const slashMenu = document.getElementById('slash-menu');
const extensionWidgetsAbove = document.getElementById('extension-widgets-above');
const extensionWidgetsBelow = document.getElementById('extension-widgets-below');
const settingsCurrentBranch = document.getElementById('settings-current-branch');

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Tau instances [{port, sessionFile, cwd}]
let currentProjectPath = '';

// File browser
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarToggle = document.getElementById('file-sidebar-toggle');
const fileSidebarClose = document.getElementById('file-sidebar-close');
const fileSidebarUp = document.getElementById('file-sidebar-up');
const fileList = document.getElementById('file-list');
const fileSidebarPath = document.getElementById('file-sidebar-path');
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext });
  renderAttachmentPreviews();
});

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder').title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder').addEventListener('click', () => {
  if (fileBrowser.currentPath) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);

});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  messageRenderer.renderError(e.detail.message);
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function handleAgentStart() {
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  updateUI();

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // In mirror mode, user messages from TUI appear via events
    // Only render if we didn't just send this message ourselves
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
  }
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent } = event;

  if (assistantMessageEvent.type === 'thinking_delta') {
    currentStreamingThinking += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'text_delta') {
    currentStreamingText += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  }
}

function handleMessageEnd(message) {
  if (currentStreamingElement) {
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateCostDisplay();
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(event);
      break;
    case 'confirm':
      dialogHandler.showConfirm(event);
      break;
    case 'input':
      dialogHandler.showInput(event);
      break;
    case 'editor':
      dialogHandler.showEditor(event);
      break;
    case 'notify':
      dialogHandler.showNotification(event);
      break;
    case 'setStatus':
      renderExtensionStatus(event);
      break;
    case 'setWidget':
      renderExtensionWidget(event);
      break;
    case 'setTitle':
      setExtensionTitle(event);
      break;
    case 'set_editor_text':
      setEditorTextFromExtension(event);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

const extensionStatuses = new Map();
const extensionWidgets = new Map();

function getEventArgs(event) {
  return Array.isArray(event.args) ? event.args : [];
}

function renderExtensionStatus(event) {
  const args = getEventArgs(event);
  const key = String(args[0] || event.statusKey || event.key || event.id || 'status');
  const value = args[1] ?? event.statusText ?? event.status ?? event.value ?? '';
  if (!value) {
    extensionStatuses.delete(key);
  } else {
    extensionStatuses.set(key, String(value));
  }
  renderExtensionChrome();
}

function renderExtensionWidget(event) {
  const args = getEventArgs(event);
  const key = String(args[0] || event.widgetKey || event.key || event.id || 'widget');
  const value = args[1] ?? event.widgetLines ?? event.lines ?? event.value ?? '';
  const lines = Array.isArray(value) ? value.map(String) : String(value).split('\n');
  const position = event.widgetPlacement === 'aboveEditor' || event.position === 'above' || args[2] === 'above' ? 'above' : 'below';
  if (lines.every((line) => line.trim() === '')) {
    extensionWidgets.delete(key);
  } else {
    extensionWidgets.set(key, { lines, position });
  }
  renderExtensionChrome();
}

function setExtensionTitle(event) {
  const args = getEventArgs(event);
  const title = args[0] ?? event.title;
  if (title) {
    document.title = String(title);
    originalTitle = document.title;
  }
}

function setEditorTextFromExtension(event) {
  const args = getEventArgs(event);
  const text = args[0] ?? event.text ?? '';
  messageInput.value = String(text);
  messageInput.dispatchEvent(new Event('input'));
  messageInput.focus();
}

function renderExtensionChrome() {
  extensionWidgetsAbove.innerHTML = '';
  extensionWidgetsBelow.innerHTML = '';

  if (extensionStatuses.size > 0) {
    const row = document.createElement('div');
    row.className = 'extension-status-row';
    for (const [key, value] of extensionStatuses) {
      const item = document.createElement('div');
      item.className = 'extension-status-pill';
      item.textContent = `${key}: ${value}`;
      row.appendChild(item);
    }
    extensionWidgetsAbove.appendChild(row);
  }

  for (const [key, widget] of extensionWidgets) {
    const el = document.createElement('div');
    el.className = 'extension-widget';
    el.dataset.widgetKey = key;
    for (const line of widget.lines) {
      const row = document.createElement('div');
      row.className = 'extension-widget-line';
      row.textContent = line;
      el.appendChild(row);
    }
    (widget.position === 'above' ? extensionWidgetsAbove : extensionWidgetsBelow).appendChild(el);
  }

  extensionWidgetsAbove.classList.toggle('empty', extensionWidgetsAbove.children.length === 0);
  extensionWidgetsBelow.classList.toggle('empty', extensionWidgetsBelow.children.length === 0);
}

function formatToolOutput(result) {
  if (!result) return '';

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  if (handleSlashMenuKeydown(e)) {
    e.stopPropagation();
    return;
  }

  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
  updateSlashMenu();
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviews = document.getElementById('image-previews');

let pendingImages = [];     // { data: base64, mimeType }
let pendingFilePaths = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      thumb.src = `/api/file/preview?path=${encodeURIComponent(fp.path)}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue = [];

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  if (pendingImages.length === 0 && runSlashCommand(message)) {
    messageInput.value = '';
    messageInput.style.height = 'auto';
    hideSlashMenu();
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';
  hideSlashMenu();

  const cmd = { type: 'prompt', message: message || '(see attached image)' };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (isNewSessionMode && isMirrorMode) {
    launchNewSessionWithPendingMessage(cmd);
    return;
  }
  if (isNewSessionMode) exitNewSessionMode();

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  wsClient.send(cmd);
}

const queuedMessagesEl = document.getElementById('queued-messages');

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    const cmd = messageQueue.shift();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    wsClient.send(cmd);
  }
}

abortBtn.addEventListener('click', () => {
  wsClient.send({ type: 'abort' });
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');

const commands = [
  { icon: '/', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '<>', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '#', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '+', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '-', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },

];

const fallbackSlashCommands = [
  { name: 'settings', description: 'Open settings', source: 'builtin' },
  { name: 'model', description: 'Open model picker', source: 'builtin' },
  { name: 'compact', description: 'Compact context', source: 'builtin' },
  { name: 'export', description: 'Export the current session as HTML', source: 'builtin' },
  { name: 'session', description: 'Show current session stats', source: 'builtin' },
  { name: 'name', description: 'Rename this session', source: 'builtin' },
  { name: 'new', description: 'Start a new session', source: 'builtin' },
  { name: 'copy', description: 'Copy the latest assistant message', source: 'builtin' },
  { name: 'reload', description: 'Reload the web UI', source: 'builtin' },
  { name: 'tree', description: 'Show conversation tree in the terminal', source: 'builtin' },
  { name: 'fork', description: 'Fork the session in the terminal', source: 'builtin' },
  { name: 'clone', description: 'Clone the current branch in the terminal', source: 'builtin' },
  { name: 'trust', description: 'Manage project trust in the terminal', source: 'builtin' },
  { name: 'login', description: 'Sign in from the terminal', source: 'builtin' },
  { name: 'logout', description: 'Sign out from the terminal', source: 'builtin' },
  { name: 'quit', description: 'Quit the terminal session', source: 'builtin' },
];

let slashCommands = fallbackSlashCommands;
let slashCommandsLoaded = false;
let slashSelectedIndex = 0;
let lastSlashQuery = null;

function openCommandPalette() {
  commandList.innerHTML = '';
  commands.forEach(cmd => {
    const el = document.createElement('div');
    el.className = 'command-item';
    el.innerHTML = `
      <div class="command-icon">${cmd.icon}</div>
      <div>
        <div class="command-label">${cmd.label}</div>
        <div class="command-desc">${cmd.desc}</div>
      </div>
    `;
    el.addEventListener('click', () => {
      closeCommandPalette();
      cmd.action();
    });
    commandList.appendChild(el);
  });
  commandPalette.classList.remove('hidden');
  commandPaletteOverlay.classList.remove('hidden');
}

function closeCommandPalette() {
  commandPalette.classList.add('hidden');
  commandPaletteOverlay.classList.add('hidden');
}

commandBtn.addEventListener('click', () => {
  openSlashMenu();
});
commandPaletteOverlay.addEventListener('click', closeCommandPalette);

function openSlashMenu() {
  messageInput.focus();
  ensureSlashAtCursor();
  updateSlashMenu(true);
}

async function fetchSlashCommands() {
  if (slashCommandsLoaded) return slashCommands;
  const resp = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'get_commands' }),
  });
  const data = await resp.json();
  if (data.success && Array.isArray(data.data?.commands)) {
    const byName = new Map();
    for (const command of [...fallbackSlashCommands, ...data.data.commands]) {
      if (command?.name) byName.set(command.name, command);
    }
    slashCommands = Array.from(byName.values());
  }
  slashCommandsLoaded = true;
  return slashCommands;
}

function ensureSlashAtCursor() {
  if (getSlashFragment()) return;
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  const prefix = start > 0 && !/\s$/.test(messageInput.value.slice(0, start)) ? ' /' : '/';
  messageInput.value = messageInput.value.slice(0, start) + prefix + messageInput.value.slice(end);
  const cursor = start + prefix.length;
  messageInput.setSelectionRange(cursor, cursor);
  messageInput.dispatchEvent(new Event('input'));
}

function getSlashFragment() {
  const cursor = messageInput.selectionStart ?? messageInput.value.length;
  const beforeCursor = messageInput.value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)\/([^\s/]*)$/);
  if (!match) return null;
  return {
    start: beforeCursor.length - match[2].length - 1,
    end: cursor,
    query: match[2].toLowerCase(),
  };
}

async function updateSlashMenu(force = false) {
  const fragment = getSlashFragment();
  if (!fragment) {
    if (!force) hideSlashMenu();
    return;
  }

  if (fragment.query !== lastSlashQuery) {
    slashSelectedIndex = 0;
    lastSlashQuery = fragment.query;
  }

  const commands = await fetchSlashCommands();
  const filtered = commands
    .filter((command) => {
      const name = String(command.name || '').toLowerCase();
      const desc = String(command.description || '').toLowerCase();
      return !fragment.query || name.includes(fragment.query) || desc.includes(fragment.query);
    })
    .slice(0, 18);

  if (filtered.length === 0) {
    hideSlashMenu();
    return;
  }

  slashSelectedIndex = Math.min(slashSelectedIndex, filtered.length - 1);
  renderSlashMenu(filtered, fragment);
}

function renderSlashMenu(items, fragment) {
  slashMenu.innerHTML = '';
  slashMenu.setAttribute('role', 'listbox');
  slashMenu.setAttribute('aria-label', 'Slash commands');
  items.forEach((command, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `slash-item${index === slashSelectedIndex ? ' active' : ''}`;
    item.id = `slash-command-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === slashSelectedIndex));
    item.dataset.commandName = command.name;
    item.innerHTML = `
      <span class="slash-name">/${escapeHtml(command.name)}</span>
      <span class="slash-desc">${escapeHtml(command.description || '')}</span>
      <span class="slash-source">${escapeHtml(command.source || 'command')}</span>
    `;
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectSlashCommand(command, fragment);
    });
    slashMenu.appendChild(item);
  });
  const active = slashMenu.querySelector('.slash-item.active');
  if (active) {
    messageInput.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
  slashMenu.classList.remove('hidden');
}

function hideSlashMenu() {
  slashMenu.classList.add('hidden');
  slashMenu.innerHTML = '';
  slashSelectedIndex = 0;
  lastSlashQuery = null;
  messageInput.removeAttribute('aria-activedescendant');
}

function selectSlashCommand(command, fragment = getSlashFragment()) {
  if (!fragment) return;
  const before = messageInput.value.slice(0, fragment.start);
  const after = messageInput.value.slice(fragment.end);
  const insert = `/${command.name} `;
  messageInput.value = before + insert + after;
  const cursor = before.length + insert.length;
  messageInput.setSelectionRange(cursor, cursor);
  messageInput.dispatchEvent(new Event('input'));
  hideSlashMenu();
  messageInput.focus();
}

function handleSlashMenuKeydown(event) {
  if (slashMenu.classList.contains('hidden')) return false;
  const items = Array.from(slashMenu.querySelectorAll('.slash-item'));
  if (items.length === 0) return false;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    slashSelectedIndex = (slashSelectedIndex + delta + items.length) % items.length;
    updateSlashMenu();
    return true;
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    const commandName = items[slashSelectedIndex]?.dataset.commandName;
    const command = slashCommands.find((item) => item.name === commandName);
    if (command) selectSlashCommand(command);
    return true;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    hideSlashMenu();
    return true;
  }

  return false;
}

document.addEventListener('click', (event) => {
  if (!slashMenu.contains(event.target) && event.target !== messageInput && !commandBtn.contains(event.target)) {
    hideSlashMenu();
  }
});

function runSlashCommand(text) {
  if (!text.startsWith('/')) return false;
  const [rawName, ...rest] = text.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(' ').trim();

  if (name === 'settings') {
    openSettings();
    return true;
  }
  if (name === 'model') {
    openModelDropdown();
    return true;
  }
  if (name === 'compact') {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    return true;
  }
  if (name === 'export') {
    rpcExportHtml();
    return true;
  }
  if (name === 'session') {
    showSessionStats();
    return true;
  }
  if (name === 'name') {
    if (args) {
      rpcCommand({ type: 'set_session_name', name: args }, 'Renaming...');
    } else {
      messageRenderer.renderSystemMessage('Usage: /name New session name');
    }
    return true;
  }
  if (name === 'new') {
    newSession();
    return true;
  }
  if (name === 'copy') {
    copyLatestAssistantMessage();
    return true;
  }
  if (name === 'reload') {
    location.reload();
    return true;
  }

  return false;
}

function copyLatestAssistantMessage() {
  const messages = Array.from(document.querySelectorAll('.message.assistant .message-content'));
  const latest = messages.at(-1);
  if (!latest) {
    messageRenderer.renderSystemMessage('No assistant message to copy');
    return;
  }
  navigator.clipboard?.writeText(latest.textContent || '');
  messageRenderer.renderSystemMessage('Copied latest assistant message');
}

async function rpcCommand(cmd, statusMsg) {
  try {
    if (statusMsg) statusText.textContent = statusMsg;
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      statusText.textContent = 'Done';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
    } else {
      statusText.textContent = data.error || 'Failed';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    }
    return data;
  } catch (e) {
    statusText.textContent = 'Error';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    statusText.textContent = `Exported: ${data.data.path}`;
    setTimeout(() => { statusText.textContent = 'Connected'; }, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
const thinkingBtn = document.getElementById('thinking-btn');
function updateThinkingBtn() {
  thinkingBtn.textContent = currentThinkingLevel;
  thinkingBtn.classList.toggle('off', currentThinkingLevel === 'off');
}
let currentModelId = '';
let currentModelProvider = '';
let availableModels = [];
let scopedModels = [];
let currentThinkingLevel = 'off';
let availableThinkingLevels = ['off'];

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models' }) }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state' }) }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
      scopedModels = modelsData.data.scopedModels || [];
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      currentModelProvider = stateData.data.model.provider || '';
      updateModelLabel();

      const model = availableModels.find(m => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      availableThinkingLevels = stateData.data.availableThinkingLevels || ['off'];
      updateThinkingBtn();
    }
    if (stateData.success && stateData.data?.cwd) {
      currentProjectPath = stateData.data.cwd;
    }
  } catch (e) {
    // ignore
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  modelDropdownLabel.textContent = shortName || 'model';
}

function modelIsCurrent(model) {
  return model.id === currentModelId && (!currentModelProvider || model.provider === currentModelProvider);
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains('hidden');
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  modelDropdownMenu.innerHTML = '';
  let showAllModels = scopedModels.length === 0;

  // Search input
  const search = document.createElement('input');
  search.className = 'model-dropdown-search';
  search.placeholder = 'Search models…';
  search.type = 'text';
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'model-dropdown-items';
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.innerHTML = '';
    const query = (filter || '').toLowerCase();
    const scopedIds = new Set(scopedModels.map(m => `${m.provider}/${m.id}`));
    const current = availableModels.find(modelIsCurrent);
    const scopedWithCurrent = current && !scopedIds.has(`${current.provider}/${current.id}`)
      ? [current, ...scopedModels]
      : scopedModels;
    const activeModels = showAllModels ? availableModels : scopedWithCurrent;

    activeModels.forEach(m => {
      const shortName = m.id.replace(/-\d{8}$/, '');
      const providerStr = m.provider || '';
      if (query && !shortName.toLowerCase().includes(query) && !providerStr.toLowerCase().includes(query)) return;

      const el = document.createElement('div');
      el.className = `model-dropdown-item${modelIsCurrent(m) ? ' active' : ''}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : '';
      const providerLabel = m.provider && m.provider !== 'anthropic' ? `<span class="model-dropdown-item-provider">${m.provider}</span>` : '';
      el.innerHTML = `<span>${shortName}${providerLabel}</span><span class="model-dropdown-item-ctx">${ctxK}</span>`;
      el.addEventListener('click', async () => {
        closeModelDropdown();
        const display = m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        const data = await rpcCommand({ type: 'set_model', provider: m.provider, modelId: m.id }, `Switching to ${display}...`);
        currentModelId = data?.data?.model?.id || m.id;
        currentModelProvider = data?.data?.model?.provider || m.provider || '';
        currentThinkingLevel = data?.data?.thinkingLevel || currentThinkingLevel;
        availableThinkingLevels = data?.data?.availableThinkingLevels || availableThinkingLevels;
        updateModelLabel();
        updateThinkingBtn();
        if (m.contextWindow) {
          contextWindowSize = m.contextWindow;
          updateTokenUsage();
        }
      });
      itemsContainer.appendChild(el);
    });

    if (scopedModels.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'model-dropdown-scope-btn';
      toggle.textContent = showAllModels ? 'Show scoped models' : `Show other models (${availableModels.length - scopedModels.length})`;
      toggle.addEventListener('click', () => {
        showAllModels = !showAllModels;
        renderItems(search.value);
      });
      itemsContainer.appendChild(toggle);
    }
  }

  renderItems('');

  search.addEventListener('input', () => renderItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelDropdown(); e.stopPropagation(); }
    if (e.key === 'Enter') {
      const first = itemsContainer.querySelector('.model-dropdown-item');
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
}

modelDropdownBtn.addEventListener('click', toggleModelDropdown);

let thinkingMenu = null;

function closeThinkingDropdown() {
  thinkingMenu?.remove();
  thinkingMenu = null;
}

function openThinkingDropdown() {
  closeThinkingDropdown();
  const levels = Array.from(new Set([...availableThinkingLevels, currentThinkingLevel])).filter(Boolean);
  thinkingMenu = document.createElement('div');
  thinkingMenu.className = 'model-dropdown-menu thinking-dropdown-menu';
  for (const level of levels) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `model-dropdown-item${level === currentThinkingLevel ? ' active' : ''}`;
    item.textContent = level;
    item.addEventListener('click', async () => {
      const data = await rpcCommand({ type: 'set_thinking_level', level }, `Switching to ${level}...`);
      if (data?.success && data.data?.level) {
        currentThinkingLevel = data.data.level;
        updateThinkingBtn();
      }
      closeThinkingDropdown();
    });
    thinkingMenu.appendChild(item);
  }
  document.body.appendChild(thinkingMenu);
  const rect = thinkingBtn.getBoundingClientRect();
  thinkingMenu.style.left = `${rect.left}px`;
  thinkingMenu.style.top = `${rect.bottom + 4}px`;
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
  if (!branchDropdown.contains(e.target)) {
    closeBranchDropdown();
  }
  if (!thinkingBtn.contains(e.target) && !thinkingMenu?.contains(e.target)) {
    closeThinkingDropdown();
  }
});

thinkingBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  thinkingMenu ? closeThinkingDropdown() : openThinkingDropdown();
});

// ═══════════════════════════════════════
// Git branch switcher
// ═══════════════════════════════════════

let currentGitState = { isRepo: false, currentBranch: '', branches: [] };

async function fetchGitState() {
  const response = await fetch('/api/git');
  const data = await response.json();
  currentGitState = data;
  renderGitState();
}

function renderGitState() {
  const isRepo = !!currentGitState.isRepo;
  branchDropdown.classList.toggle('hidden', !isRepo);
  const label = currentGitState.currentBranch || 'detached';
  branchDropdownLabel.textContent = label;
  settingsCurrentBranch.textContent = isRepo ? label : 'none';
}

function toggleBranchDropdown() {
  if (branchDropdownMenu.classList.contains('hidden')) {
    openBranchDropdown();
  } else {
    closeBranchDropdown();
  }
}

function openBranchDropdown() {
  branchDropdownMenu.innerHTML = '';
  for (const branch of currentGitState.branches || []) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `branch-dropdown-item${branch === currentGitState.currentBranch ? ' active' : ''}`;
    item.textContent = branch;
    item.addEventListener('click', async () => {
      closeBranchDropdown();
      await checkoutBranch(branch);
    });
    branchDropdownMenu.appendChild(item);
  }
  branchDropdownMenu.classList.remove('hidden');
  branchDropdown.classList.add('open');
}

function closeBranchDropdown() {
  branchDropdownMenu.classList.add('hidden');
  branchDropdown.classList.remove('open');
}

async function checkoutBranch(branch) {
  const response = await fetch('/api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    messageRenderer.renderError(data.error || 'Failed to switch branch');
    return;
  }
  currentGitState = data;
  renderGitState();
}

branchDropdownBtn.addEventListener('click', toggleBranchDropdown);
settingsCurrentBranch.addEventListener('click', () => {
  if (!currentGitState.isRepo) return;
  openBranchDropdown();
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (!slashMenu.classList.contains('hidden') && handleSlashMenuKeydown(e)) {
    return;
  }

  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains('hidden')) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains('hidden')) {
      closeModelDropdown();
      return;
    }
    if (!slashMenu.classList.contains('hidden')) {
      hideSlashMenu();
      return;
    }

    if (state.isStreaming) {
      wsClient.send({ type: 'abort' });
      messageRenderer.renderError('Aborted by user');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    openSlashMenu();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn');
newSessionBtn.addEventListener('click', () => newSession());

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  state.reset();
  messageRenderer.clear();
  toolCardRenderer.clear();
  messageRenderer.renderWelcome();
  sidebar.clearActive();
  viewingActiveSession = true;
  updateMirrorInputState();
  enterNewSessionMode();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function handleSessionSelect(session, project) {
  exitNewSessionMode();
  sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    // Clear any streaming state from previous session to prevent bleed
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage('Loading session...');

      const dirName = project?.dirName;
      const file = session.file;
      console.log('[App] Loading history:', { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const res = await fetch(`/api/sessions/${dirName}/${file}`);
          console.log('[App] History fetch status:', res.status);
          const data = await res.json();
          console.log('[App] History entries:', data.entries?.length || 0);

          messageRenderer.clear();
          renderSessionHistory(data.entries || []);
        } catch (e) {
          console.error('[App] History fetch error:', e);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      messageRenderer.renderWelcome();
    }

    // In mirror mode, check if this session is live on any instance
    if (isMirrorMode) {
      // Check if this session is live on a different instance
      const otherInstance = liveInstances.find(i => i.sessionFile === sessionFile && i.port !== new URL(wsClient.url).port * 1);
      if (otherInstance) {
        // Reconnect to the other instance
        const protocol = document.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const newUrl = `${protocol}//${location.hostname}:${otherInstance.port}/ws`;
        console.log(`[App] Switching to instance on port ${otherInstance.port}`);
        wsClient.disconnect();
        wsClient.url = newUrl;
        wsClient.forceReconnect();
        mirrorActiveSessionFile = sessionFile;
        viewingActiveSession = true;
        updateMirrorInputState();
        return;
      }

      // Check if this is the active session on the current instance
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      updateMirrorInputState();

      if (viewingActiveSession) {
        // Re-request live state from the extension
        wsClient.send({ type: 'mirror_sync_request' });
      } else {
        await launchSessionInstance(sessionFile, project?.path);
      }
    } else {
      const res = await fetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        messageRenderer.renderError(`Failed to switch session: ${err.error}`);
      }
    }
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  isMirrorMode = true;

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  currentProjectPath = data.cwd || currentProjectPath;
  viewingActiveSession = true;
  updateMirrorInputState();
  updateMirrorLiveIndicator();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
    currentModelProvider = data.model.provider || '';
    updateModelLabel();
    if (data.model.contextWindow) {
      contextWindowSize = data.model.contextWindow;
    }
  }

  // Update thinking level
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    availableThinkingLevels = data.availableThinkingLevels || availableThinkingLevels;
    updateThinkingBtn();
  }

  // Clear and render message history
  messageRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }

  updateCostDisplay();
  updateTokenUsage();
  flushPendingNewMessage();
}

// Mark all live sessions in the sidebar with a green dot
function updateMirrorLiveIndicator() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current mirror session
  if (mirrorActiveSessionFile) liveFiles.add(mirrorActiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('mirror-live', liveFiles.has(el.dataset.filePath));
  });
}

// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch('/api/instances');
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      updateMirrorLiveIndicator();
    }
  } catch {}
}

// Poll every 5 seconds
setInterval(pollInstances, 5000);
pollInstances();

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  if (!isMirrorMode) return;

  const inputArea = document.querySelector('.input-area');
  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('mirror-readonly');
  } else {
    messageInput.disabled = true;
    messageInput.placeholder = 'Viewing historical session (read-only)';
    inputArea?.classList.add('mirror-readonly');
  }
}

async function launchSessionInstance(sessionFile, projectPath) {
  if (!projectPath) {
    messageRenderer.renderError('Cannot resume session: missing project path');
    return false;
  }
  await pollInstances();
  const beforePids = new Set(liveInstances.map(instance => instance.pid));
  document.querySelector('.input-area')?.classList.remove('mirror-readonly');
  messageInput.disabled = true;
  messageInput.placeholder = 'Opening session...';
  statusText.textContent = 'Opening session...';

  const response = await fetch('/api/projects/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath, sessionFile }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    messageRenderer.renderError(data.error || 'Failed to open session');
    statusText.textContent = 'Connected';
    updateMirrorInputState();
    return false;
  }

  for (let i = 0; i < 20; i += 1) {
    await wait(500);
    await pollInstances();
    const instance = liveInstances.find(item => item.sessionFile === sessionFile && !beforePids.has(item.pid));
    if (instance) {
      navigateToInstance(instance);
      return true;
    }
  }

  messageRenderer.renderError('Session opened, but Tau did not see its mirror yet');
  statusText.textContent = 'Connected';
  updateMirrorInputState();
  return false;
}

function currentPort() {
  return Number(new URL(wsClient.url).port || location.port || 80);
}

async function launchNewSessionWithPendingMessage(cmd) {
  const projectPath = selectedNewProject?.path || currentProjectPath;
  if (!projectPath) {
    messageRenderer.renderError('Cannot start new session: missing project path');
    return;
  }

  await pollInstances();
  const beforePids = new Set(liveInstances.map(instance => instance.pid));
  localStorage.setItem('tau-pending-new-message', JSON.stringify({ sourcePort: currentPort(), cmd }));
  statusText.textContent = 'Opening new session...';

  const response = await fetch('/api/projects/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    localStorage.removeItem('tau-pending-new-message');
    messageRenderer.renderError(data.error || 'Failed to open new session');
    statusText.textContent = 'Connected';
    return;
  }

  for (let i = 0; i < 20; i += 1) {
    await wait(500);
    await pollInstances();
    const instance = liveInstances.find(item => item.cwd === projectPath && !beforePids.has(item.pid));
    if (instance) {
      navigateToInstance(instance);
      return;
    }
  }

  localStorage.removeItem('tau-pending-new-message');
  messageRenderer.renderError('New session opened, but Tau did not see its mirror yet');
  statusText.textContent = 'Connected';
}

function flushPendingNewMessage() {
  const raw = localStorage.getItem('tau-pending-new-message');
  if (!raw) return;
  const pending = JSON.parse(raw);
  if (currentPort() === pending.sourcePort) return;
  const { cmd } = pending;
  localStorage.removeItem('tau-pending-new-message');
  exitNewSessionMode();
  lastSentMessage = cmd.message;
  messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
  wsClient.send(cmd);
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

  for (const entry of entries) {
    if (entry.type === 'custom_message') {
      messageRenderer.renderCustomMessage(entry, true);
      continue;
    }

    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = (msg.content || []).filter((b) => b.type === 'text');
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === 'thinking');
      const toolCalls = (msg.content || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError
      );
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateCostDisplay();
  updateTokenUsage();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  const messagesEl = document.getElementById('messages');
  messagesEl.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle('hidden', !show);
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    tokenUsageEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to token usage in header
  tokenUsageEl.parentElement.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;

  if (isStreaming) {
    statusIndicator.classList.add('streaming');
    statusIndicator.classList.remove('connected');
    statusText.textContent = 'Working...';
  } else {
    statusIndicator.classList.remove('streaming');
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Connected';
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const themeGrid = document.getElementById('theme-grid');
const toggleAutoCompact = document.getElementById('toggle-auto-compact');
const btnThinkingLevel = document.getElementById('btn-thinking-level');
const toggleShowThinking = document.getElementById('toggle-show-thinking');
const settingsTabs = document.getElementById('settings-tabs');
const settingsTabPanels = Array.from(document.querySelectorAll('.settings-tab-panel'));
const settingsDefaultProvider = document.getElementById('settings-default-provider');
const settingsDefaultModel = document.getElementById('settings-default-model');
const settingsExternalEditor = document.getElementById('settings-external-editor');
const settingsAgentsMd = document.getElementById('settings-agents-md');
const settingsMcpJson = document.getElementById('settings-mcp-json');
const settingsPackagesJson = document.getElementById('settings-packages-json');
const settingsReload = document.getElementById('settings-reload');
const settingsSave = document.getElementById('settings-save');

let webSettings = null;

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

settingsTabs.addEventListener('click', (event) => {
  const tab = event.target instanceof Element ? event.target.closest('.settings-tab') : null;
  if (!tab) return;
  const tabId = tab.dataset.tab;
  settingsTabs.querySelectorAll('.settings-tab').forEach((item) => {
    item.classList.toggle('active', item === tab);
  });
  settingsTabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tabId);
  });
});

async function loadWebSettings() {
  const response = await fetch('/api/web-settings');
  if (!response.ok) throw new Error('Failed to load settings');
  webSettings = await response.json();
  const settings = webSettings.settings || {};
  settingsDefaultProvider.value = settings.defaultProvider || '';
  settingsDefaultModel.value = settings.defaultModel || '';
  settingsExternalEditor.value = settings.externalEditor || '';
  settingsAgentsMd.value = webSettings.agentsMd || '';
  settingsMcpJson.value = JSON.stringify(settings.mcpServers || {}, null, 2);
  settingsPackagesJson.value = JSON.stringify(settings.packages || [], null, 2);
}

async function saveWebSettings() {
  const settings = {
    defaultProvider: settingsDefaultProvider.value.trim() || null,
    defaultModel: settingsDefaultModel.value.trim() || null,
    externalEditor: settingsExternalEditor.value.trim() || null,
    mcpServers: JSON.parse(settingsMcpJson.value || '{}'),
    packages: JSON.parse(settingsPackagesJson.value || '[]'),
  };

  const response = await fetch('/api/web-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings,
      agentsMd: settingsAgentsMd.value,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to save settings');
  webSettings = data;
  statusText.textContent = 'Settings saved';
  setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
}

settingsReload.addEventListener('click', () => {
  loadWebSettings().catch((error) => {
    messageRenderer.renderError(error.message);
  });
});

settingsSave.addEventListener('click', () => {
  saveWebSettings().catch((error) => {
    messageRenderer.renderError(error.message);
  });
});

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');
  loadWebSettings().catch((error) => {
    messageRenderer.renderError(error.message);
  });
  fetchGitState();

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state' }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      currentThinkingLevel = s.thinkingLevel || 'off';
      availableThinkingLevels = s.availableThinkingLevels || availableThinkingLevels;
      updateThinkingBtn();
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', !isOn);
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth');
const authSection = document.getElementById('settings-auth-section');

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz');
const contextBar = document.getElementById('context-bar');
const contextLegend = document.getElementById('context-legend');
const contextVizUsed = document.getElementById('context-viz-used');
const contextVizTotal = document.getElementById('context-viz-total');


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: 'Cached', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: 'Input', tokens: freshInput, color: 'messages' },
    { key: 'free', label: 'Available', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `${pct}% used`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// Voice Input
// ═══════════════════════════════════════

const micBtn = document.getElementById('mic-btn');
let recognition = null;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-AU';

  let finalTranscript = '';
  let interimTranscript = '';

  recognition.addEventListener('result', (e) => {
    interimTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }
    // Show live transcription in the input
    messageInput.value = finalTranscript + interimTranscript;
    messageInput.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  });

  recognition.addEventListener('error', (e) => {
    console.error('[Voice] Error:', e.error);
    stopRecording();
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    finalTranscript = messageInput.value; // Append to existing text
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = 'Stop recording';
    recognition.start();
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    try { recognition.stop(); } catch {}
    // Commit final transcript
    messageInput.value = finalTranscript;
    messageInput.dispatchEvent(new Event('input'));
    messageInput.focus();
  }
} else {
  // No speech recognition support — hide mic button
  micBtn.style.display = 'none';
}



// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, move cost + token usage above input
if (isMobile()) {
  sidebarEl.classList.add('collapsed');

  const mobileBar = document.getElementById('mobile-model-bar');
  const sessionCost = document.getElementById('session-cost');
  const tokenUsage = document.getElementById('token-usage');
  if (mobileBar && sessionCost && tokenUsage) {
    mobileBar.appendChild(sessionCost);
    mobileBar.appendChild(tokenUsage);
  }

  // Start collapsed
  mobileBar.classList.add('collapsed');

  // Toggle via chevron
  const contextToggle = document.getElementById('mobile-context-toggle');
  contextToggle.addEventListener('click', () => {
    mobileBar.classList.toggle('collapsed');
    contextToggle.classList.toggle('flipped', !mobileBar.classList.contains('collapsed'));
  });
}

// New session project picker
const newSessionTools = document.getElementById('new-session-tools');
const newProjectBtn = document.getElementById('new-project-btn');
const newProjectLabel = document.getElementById('new-project-label');
const newProjectMenu = document.getElementById('new-project-menu');
let isNewSessionMode = false;
let newSessionProjects = [];
let selectedNewProject = null;

function projectShortName(project) {
  if (!project?.path) return '不使用项目';
  return project.name || project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path;
}

function renderNewSessionWelcome() {
  const title = messagesContainer.querySelector('.welcome p');
  if (title) title.textContent = `我们应该在 ${projectShortName(selectedNewProject)} 中构建什么？`;
}

function renderNewProjectLabel() {
  newProjectLabel.textContent = projectShortName(selectedNewProject);
  renderNewSessionWelcome();
}

async function loadNewSessionProjects() {
  const response = await fetch('/api/projects');
  const data = await response.json();
  newSessionProjects = data.projects || [];
  selectedNewProject =
    newSessionProjects.find(p => p.path === currentProjectPath) ||
    newSessionProjects.find(p => p.active) ||
    newSessionProjects[0] ||
    null;
  renderNewProjectLabel();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function navigateToInstance(instance) {
  const url = new URL(location.href);
  url.port = String(instance.port);
  location.href = url.toString();
}

function renderNewProjectMenu(filter = '') {
  const query = filter.toLowerCase();
  newProjectMenu.innerHTML = '';

  const search = document.createElement('input');
  search.className = 'new-project-search';
  search.placeholder = 'Search projects';
  search.type = 'text';
  search.value = filter;
  newProjectMenu.appendChild(search);

  const list = document.createElement('div');
  list.className = 'new-project-list';
  newProjectMenu.appendChild(list);

  const projects = newSessionProjects.filter(project => {
    const text = `${project.name || ''} ${project.path || ''}`.toLowerCase();
    return !query || text.includes(query);
  });

  for (const project of projects) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `new-project-item${project.path === selectedNewProject?.path ? ' active' : ''}`;
    item.innerHTML = `
      <span class="new-project-icon">▣</span>
      <span class="new-project-name">${escapeHtml(projectShortName(project))}</span>
      ${project.path === selectedNewProject?.path ? '<span class="new-project-check">✓</span>' : ''}
    `;
    item.addEventListener('click', async () => {
      selectedNewProject = project;
      renderNewProjectLabel();
      closeNewProjectMenu();
    });
    list.appendChild(item);
  }

  const noProject = document.createElement('button');
  noProject.type = 'button';
  noProject.className = `new-project-item${selectedNewProject ? '' : ' active'}`;
  noProject.innerHTML = '<span class="new-project-icon">×</span><span class="new-project-name">不使用项目</span>';
  noProject.addEventListener('click', () => {
    selectedNewProject = null;
    renderNewProjectLabel();
    closeNewProjectMenu();
  });
  list.appendChild(noProject);

  search.addEventListener('input', () => {
    const value = search.value;
    renderNewProjectMenu(value);
    newProjectMenu.querySelector('.new-project-search')?.focus();
  });
  requestAnimationFrame(() => search.focus());
}

async function openNewProjectMenu() {
  if (newSessionProjects.length === 0) await loadNewSessionProjects();
  renderNewProjectMenu();
  newProjectMenu.classList.remove('hidden');
}

function closeNewProjectMenu() {
  newProjectMenu.classList.add('hidden');
}

function enterNewSessionMode() {
  isNewSessionMode = true;
  document.body.classList.add('new-session-mode');
  newSessionTools.classList.remove('hidden');
  renderNewSessionWelcome();
  loadNewSessionProjects().catch(() => {});
  if (!isMobile()) messageInput.focus();
}

function exitNewSessionMode() {
  isNewSessionMode = false;
  document.body.classList.remove('new-session-mode');
  newSessionTools.classList.add('hidden');
  closeNewProjectMenu();
}

newProjectBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  if (newProjectMenu.classList.contains('hidden')) {
    openNewProjectMenu();
  } else {
    closeNewProjectMenu();
  }
});

document.addEventListener('click', (event) => {
  if (!newProjectMenu.contains(event.target) && !newProjectBtn.contains(event.target)) {
    closeNewProjectMenu();
  }
});

document.getElementById('tau-new-session-btn')?.addEventListener('click', () => newSession());

wsClient.connect();
messageRenderer.renderWelcome();
sidebar.loadSessions().then(() => {
  if (isMirrorMode) updateMirrorLiveIndicator();
});
fetchGitState().catch(() => {});

// Register service worker for PWA
if (window.__TAU_DEV__ && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const registration of registrations) registration.unregister();
  }).catch(() => {});
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('Tau initialized');
