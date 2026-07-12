/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { ExtensionTuiBridge, renderAnsiText } from './extension-tui.js';
import { SessionSidebar } from './session-sidebar.js';
import { getSessionHistoryFallback } from './session-history.js';
import { disableSessionControls, getComposerState } from './composer-state.js';
import { filterSlashCommands } from './slash-command-filter.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { createSettingsParity } from './settings-parity.js';
import { matchShortcut, visibleShortcuts } from './keymap.js';
import {
  actionTargetsDisplayedSession,
  createSessionActions,
  resolveSessionActionContext,
  sessionActionTitle,
} from './session-actions.js';


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const mutationFetch = wsClient.mutationFetch.bind(wsClient);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
const dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect,
  mutationFetch,
  handleSessionAction,
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
const sessionTitleBtn = document.getElementById('session-title-btn');
const sessionTitleText = document.getElementById('session-title-text');
const connectionStatusBtn = document.getElementById('connection-status-btn');

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
const extensionTuiBridge = new ExtensionTuiBridge(wsClient, extensionWidgetsAbove, extensionWidgetsBelow);

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let agentErrorShown = false;
let abortRequested = false;
let statusResetTimer = null;
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
let currentSessionEntries = [];
let currentSession = null;
let sessionClosed = false;
let authCapability = {
  available: false,
  configured: false,
  enabled: false,
};
let sidebarRefreshTimer = null;
let contextWindowTimer = null;
let instancePollTimer = null;
let isLaunchingNewSession = false;
let desktopSidebarCollapsed = sidebarEl.classList.contains('collapsed');
let reusedLaunchNotice = new URL(location.href).searchParams.get('tauReused') === '1';
const mobileViewport = window.matchMedia('(max-width: 768px)');

const sessionActions = createSessionActions({
  dialog: document.getElementById('session-actions-dialog'),
  titleElement: document.getElementById('session-actions-title'),
  bodyElement: document.getElementById('session-actions-body'),
  statusElement: document.getElementById('session-actions-status'),
  closeButton: document.getElementById('session-actions-close'),
  mutationFetch,
  request: (command) => wsClient.request(command),
  onRenamed: handleSessionRenamed,
});
sessionTitleBtn.disabled = true;

function scheduleSidebarRefresh() {
  if (sessionClosed) return;
  clearTimeout(sidebarRefreshTimer);
  sidebarRefreshTimer = setTimeout(async () => {
    await sidebar.loadSessions(false);
    if (sessionClosed) return;
    updateMirrorLiveIndicator();
  }, 250);
}

function getErrorMessage(error, fallback = 'Unknown error') {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;

  const candidates = [
    error?.error,
    error?.errorMessage,
    error?.message,
    error?.reason,
    error?.data?.error,
  ];
  const message = candidates.find((value) => typeof value === 'string' && value.trim());
  return message ? message.trim() : fallback;
}

function isWebSocketOpen() {
  return wsClient.ws?.readyState === WebSocket.OPEN;
}

function setStatusMessage(message, resetAfter = 0) {
  if (sessionClosed) return;
  clearTimeout(statusResetTimer);
  statusText.textContent = message;
  if (resetAfter <= 0) return;

  statusResetTimer = setTimeout(() => {
    statusResetTimer = null;
    if (state.isStreaming) {
      statusText.textContent = 'Working...';
    } else {
      statusText.textContent = isWebSocketOpen() ? 'Connected' : 'Disconnected';
    }
  }, resetAfter);
}

function renderAppError(error, fallback = 'Request failed') {
  const message = getErrorMessage(error, fallback);
  if (!sessionClosed) messageRenderer.renderError(message);
  return message;
}

function clearActiveToolExecutions(reason) {
  for (const tool of state.getAllToolExecutions()) {
    if (tool.status !== 'pending' && tool.status !== 'streaming') continue;
    state.updateToolExecution(tool.toolCallId, {
      status: 'error',
      output: reason,
      isError: true,
    });
    toolCardRenderer.finalizeToolCard(
      tool.toolCallId,
      { content: [{ type: 'text', text: reason }] },
      true,
    );
  }
}

function clearStreamingUI({ flushQueue = false, reason = '' } = {}) {
  if (reason) clearActiveToolExecutions(reason);
  document.querySelectorAll('#messages [data-message-id="streaming"]').forEach((element) => element.remove());
  document.getElementById('compaction-indicator')?.remove();
  currentStreamingElement = null;
  currentStreamingText = '';
  currentStreamingThinking = '';
  state.setStreaming(false);
  showTypingIndicator(false);
  updateUI({ flushPending: flushQueue });
}

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
  if (pendingFilePaths.some((item) => item.path === filePath)) return;
  pendingFilePaths.push({ path: filePath, name, ext });
  renderAttachmentPreviews();
}, mutationFetch);

function syncMobileFileSidebar() {
  const mobile = mobileViewport.matches;
  if (!mobile) {
    fileSidebar.style.removeProperty('display');
    fileSidebar.style.removeProperty('position');
    fileSidebar.style.removeProperty('top');
    fileSidebar.style.removeProperty('right');
    fileSidebar.style.removeProperty('bottom');
    fileSidebar.style.removeProperty('width');
    fileSidebar.style.removeProperty('flex-basis');
    fileSidebar.style.removeProperty('z-index');
    return;
  }

  fileSidebar.style.setProperty('position', 'fixed');
  fileSidebar.style.setProperty('top', 'var(--toolbar-height)');
  fileSidebar.style.setProperty('right', '0');
  fileSidebar.style.setProperty('bottom', '0');
  fileSidebar.style.setProperty('width', 'min(86vw, 320px)');
  fileSidebar.style.setProperty('flex-basis', 'min(86vw, 320px)');
  fileSidebar.style.setProperty('z-index', '250');
  fileSidebar.style.setProperty('display', fileSidebar.classList.contains('collapsed') ? 'none' : 'flex', 'important');
}

function toggleFileSidebar() {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
  syncMobileFileSidebar();
}

fileSidebarToggle.addEventListener('click', toggleFileSidebar);

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
  syncMobileFileSidebar();
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
    mutationFetch('/api/open', {
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

syncMobileFileSidebar();


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  if (sessionClosed) return;
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (!sessionClosed && document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
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
  if (sessionClosed) return;
  updateConnectionStatus('connected');
  sidebar.loadSessions().then(() => {
    if (sessionClosed) return;
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
  // Fetch model context window size for token % display
  clearTimeout(contextWindowTimer);
  contextWindowTimer = setTimeout(fetchContextWindow, 1000);
  fetchSlashCommands().catch((error) => {
    console.error('[App] Failed to load slash commands:', error);
    renderAppError(error, 'Failed to load slash commands');
  });
});

wsClient.addEventListener('disconnected', () => {
  if (sessionClosed) return;
  dialogHandler.dismissCurrentDialog();
  clearExtensionUIState();
  if (state.isStreaming || currentStreamingElement) {
    clearStreamingUI({ flushQueue: false, reason: 'Connection lost while the agent was working' });
  }
  updateConnectionStatus('disconnected');
});

wsClient.addEventListener('reconnectFailed', () => {
  if (sessionClosed) return;
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e) => {
  if (sessionClosed) return;
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  if (sessionClosed) return;
  const message = renderAppError(e.detail, 'Server error');
  if (state.isStreaming || currentStreamingElement) {
    clearStreamingUI({ flushQueue: false, reason: message });
  }
});

wsClient.addEventListener('response', (e) => {
  if (sessionClosed) return;
  handleRPCResponse(e.detail);
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  if (sessionClosed) return;
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  if (sessionClosed) return;
  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd(event);
      break;
    case 'agent_error':
      handleAgentError(event);
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
    case 'extension_ui_cancel':
      dialogHandler.cancel(event.id);
      break;
    case 'extension_tui_mount':
      extensionTuiBridge.mount(event);
      break;
    case 'extension_tui_update':
      extensionTuiBridge.update(event);
      break;
    case 'extension_tui_unmount':
      extensionTuiBridge.unmount(event.id);
      break;
    case 'extension_tui_error':
      messageRenderer.renderError(`Extension UI rendering failed: ${event.error}`);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'auth_changed':
      updateAuthCapability({
        configured: authCapability.configured,
        enabled: event.enabled,
        available: true,
      });
      break;
    case 'session_name':
      if (event.name) {
        if (viewingActiveSession) {
          currentSession = { ...(currentSession || {}), filePath: mirrorActiveSessionFile, name: event.name };
          setSessionTitle(event.name);
        }
        document.querySelectorAll('.session-item').forEach((item) => {
          if (item.dataset.filePath === mirrorActiveSessionFile) {
            const title = item.querySelector('.session-title');
            if (title) title.textContent = event.name;
          }
        });
      }
      scheduleSidebarRefresh();
      break;
  }
}

function handleRPCResponse(response) {
  if (sessionClosed) return;
  if (response?.success !== false) return;

  const message = renderAppError(
    response,
    `${response?.command || 'RPC command'} failed`,
  );
  if (response?.command === 'prompt') {
    clearStreamingUI({ flushQueue: false, reason: message });
  }
}

function requestRpc(command) {
  return wsClient.request(command).catch((error) => {
    const response = error?.response || {
      type: 'response',
      command: command.type,
      success: false,
      error: getErrorMessage(error, `${command.type || 'RPC command'} failed`),
    };
    handleRPCResponse(response);
    return response;
  });
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
  abortRequested = false;
  agentErrorShown = false;
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd(event) {
  const failedMessage = Array.isArray(event?.messages)
    ? [...event.messages].reverse().find((message) => (
      message?.role === 'assistant'
      && message.stopReason === 'error'
      && message.errorMessage
    ))
    : null;
  if (failedMessage && !abortRequested) {
    handleAgentError({ error: failedMessage.errorMessage });
  }

  clearStreamingUI({ flushQueue: false });
  abortRequested = false;
  updateUI();

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

function handleAgentError(event) {
  const errorMessage = getErrorMessage(event, 'Agent failed to respond');
  if (abortRequested) {
    clearStreamingUI({ flushQueue: false });
    return;
  }
  if (!agentErrorShown) {
    agentErrorShown = true;
    renderAppError(errorMessage);
  }
  clearStreamingUI({ flushQueue: false, reason: errorMessage });
}

let currentStreamingThinking = '';

function handleMessageStart(message) {
  if (message.role === 'user') {
    agentErrorShown = false;
    scheduleSidebarRefresh();
  }
  if (message.role === 'assistant') {
    if (agentErrorShown) return;
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
  } else if (message.role === 'custom' && message.display === true) {
    messageRenderer.renderCustomMessage(message);
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
  if (message?.role === 'user') scheduleSidebarRefresh();
  if (message?.role === 'assistant' && message.stopReason === 'error') return;
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
    scheduleSidebarRefresh();
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

function clearExtensionUIState() {
  extensionStatuses.clear();
  extensionWidgets.clear();
  extensionWidgetsAbove.replaceChildren();
  extensionWidgetsBelow.replaceChildren();
  extensionTuiBridge.clear();
}

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
      item.append(`${key}: `);
      const content = document.createElement('span');
      renderAnsiText(content, value);
      item.appendChild(content);
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

  const shortcut = matchShortcut(e, 'composer');
  if (shortcut?.id === 'composer.send' && !e.isComposing) {
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
  if (getCurrentComposerState().disabled) return;

  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  if (pendingImages.length === 0 && runSlashCommand(message)) {
    clearMessageInput();
    return;
  }

  const newSessionDraft = isNewSessionMode ? {
    message,
    images: [...pendingImages],
    filePaths: [...pendingFilePaths],
  } : null;

  clearMessageInput();

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

  if (isNewSessionMode) {
    agentErrorShown = false;
    exitNewSessionMode();
    lastSentMessage = message;
    messageRenderer.renderUserMessage({ content: message, images: cmd.images });
    void launchNewSessionWithPendingMessage(cmd).then((result) => {
      if (!result.ok) restoreNewSessionDraft(newSessionDraft, result.error);
    });
    return;
  }

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  agentErrorShown = false;
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  void requestRpc(cmd);
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
    agentErrorShown = false;
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    void requestRpc(cmd);
  }
}

function abortCurrentAgent() {
  if (!state.isStreaming && !currentStreamingElement) return;

  const connected = isWebSocketOpen();
  abortRequested = connected;
  void requestRpc({ type: 'abort' });
  const message = connected ? 'Aborted by user' : 'Abort failed: WebSocket is not connected';
  if (!connected) abortRequested = false;
  clearStreamingUI({ flushQueue: false, reason: message });
  renderAppError(message);
  setStatusMessage(connected ? 'Aborted' : 'Abort failed', 3000);
}

abortBtn.addEventListener('click', abortCurrentAgent);

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');

const commands = [
  { icon: '/', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '<>', label: 'Export', desc: 'Export the current session', action: () => {
    const context = requireSessionActionContext();
    if (context) sessionActions.openExport(context);
  } },
  { icon: '#', label: 'Session Info', desc: 'Show session details', action: () => {
    const context = requireSessionActionContext();
    if (context) void sessionActions.openInfo(context);
  } },
  { icon: '+', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '-', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },

];

const webSlashCommands = [
  { name: 'settings', description: 'Open settings', source: 'builtin', execution: 'web' },
  { name: 'model', description: 'Open model picker', source: 'builtin', execution: 'web' },
  { name: 'scoped-models', description: 'Change the model cycling scope', source: 'builtin', execution: 'unsupported' },
  { name: 'compact', description: 'Compact context', source: 'builtin', execution: 'web' },
  { name: 'export', description: 'Export the current session as HTML', source: 'builtin', execution: 'web' },
  { name: 'import', description: 'Import and resume a session from a JSONL file', source: 'builtin', execution: 'unsupported' },
  { name: 'share', description: 'Share the current session', source: 'builtin', execution: 'unsupported' },
  { name: 'session', description: 'Show current session stats', source: 'builtin', execution: 'web' },
  { name: 'name', description: 'Rename this session', source: 'builtin', execution: 'web' },
  { name: 'new', description: 'Start a new session', source: 'builtin', execution: 'web' },
  { name: 'copy', description: 'Copy the latest assistant message', source: 'builtin', execution: 'web' },
  { name: 'changelog', description: 'Show changelog entries', source: 'builtin', execution: 'unsupported' },
  { name: 'hotkeys', description: 'Show web keyboard shortcuts', source: 'builtin', execution: 'web' },
  { name: 'fork', description: 'Preview fork points (read-only in web)', source: 'builtin', execution: 'readonly' },
  { name: 'clone', description: 'Duplicate the current session', source: 'builtin', execution: 'unsupported' },
  { name: 'tree', description: 'Inspect the session tree (read-only in web)', source: 'builtin', execution: 'readonly' },
  { name: 'trust', description: 'Save the project trust decision', source: 'builtin', execution: 'unsupported' },
  { name: 'login', description: 'Configure provider authentication', source: 'builtin', execution: 'rpc' },
  { name: 'logout', description: 'Remove provider authentication', source: 'builtin', execution: 'rpc' },
  { name: 'resume', description: 'Resume a different session from the sidebar', source: 'builtin', execution: 'web' },
  { name: 'reload-web', description: 'Reload the Tau web UI', source: 'tau', execution: 'web' },
  { name: 'quit', description: 'Quit Pi', source: 'builtin', execution: 'rpc' },
];

const localSlashCapabilities = Object.freeze({
  settings: { mode: 'web', enabled: true, label: 'web' },
  model: { mode: 'web', enabled: true, label: 'web' },
  'scoped-models': {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: 'Changing the model cycling scope is not exposed by the Tau web RPC.',
  },
  compact: { mode: 'web', enabled: true, label: 'web' },
  export: { mode: 'web', enabled: true, label: 'web' },
  session: { mode: 'web', enabled: true, label: 'web' },
  name: { mode: 'web', enabled: true, label: 'web' },
  new: { mode: 'web', enabled: true, label: 'web' },
  copy: { mode: 'web', enabled: true, label: 'web' },
  hotkeys: { mode: 'web', enabled: true, label: 'web' },
  fork: {
    mode: 'readonly',
    enabled: true,
    label: 'read-only',
    reason: 'The web mirror can inspect fork points but cannot create a fork without a Pi fork RPC.',
  },
  clone: {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: 'Session cloning is not exposed by the Tau web RPC.',
  },
  tree: {
    mode: 'readonly',
    enabled: true,
    label: 'read-only',
    reason: 'The web mirror can inspect tree metadata but cannot switch branches without a Pi tree RPC.',
  },
  trust: {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: 'Project trust decisions are resolved by Pi before the web mirror and have no web RPC.',
  },
  login: {
    mode: 'rpc',
    enabled: true,
    label: 'extension',
    reason: 'Uses the Tau web-parity extension and Pi public auth storage API.',
  },
  logout: {
    mode: 'rpc',
    enabled: true,
    label: 'extension',
    reason: 'Uses the Tau web-parity extension and Pi public auth storage API.',
  },
  resume: { mode: 'web', enabled: true, label: 'web' },
  'reload-web': {
    mode: 'web',
    enabled: true,
    label: 'web',
    reason: 'This reloads only the Tau web UI.',
  },
  import: {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: 'Session import needs a server upload/import endpoint, which this mirror does not expose.',
  },
  share: {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: 'Session sharing needs a server share endpoint, which this mirror does not expose.',
  },
  changelog: {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: 'Pi changelog access is not exposed by the Tau web RPC.',
  },
  quit: {
    mode: 'rpc',
    enabled: true,
    label: 'extension',
    reason: 'Uses the Tau web-parity extension and Pi public ctx.shutdown() API.',
  },
});

let slashCommands = [...webSlashCommands];
let slashSelectedIndex = 0;
let lastSlashQuery = null;

function getSlashCommandName(command) {
  return String(command?.name || '').trim().toLowerCase();
}

function getSlashCapability(command) {
  const name = getSlashCommandName(command);
  const local = localSlashCapabilities[name];
  const backendAvailable = command?.available;
  const backendExecution = command?.execution;
  const backendReason = command?.reason;
  if (local) {
    return {
      ...local,
      backendAvailable,
      backendExecution,
      reason: local.reason || (!local.enabled && backendAvailable === false ? backendReason : undefined),
    };
  }

  if (backendExecution === 'rpc' && backendAvailable !== false) {
    return { mode: 'rpc', enabled: true, label: 'rpc', reason: backendReason };
  }

  return {
    mode: 'unsupported',
    enabled: false,
    label: 'unavailable',
    reason: backendReason || (command?.source === 'builtin'
      ? 'This Pi builtin is not exposed by the Tau web RPC.'
      : 'This extension command is registered by Pi but is not executable through the web mirror.'),
    backendAvailable,
    backendExecution,
  };
}

function renderSlashCapabilityError(name, capability) {
  const reason = capability?.reason || 'This command is not available in Tau web.';
  renderAppError(`/${name} is unavailable: ${reason}`);
  setStatusMessage(`/${name} unavailable`, 3500);
}

async function fetchSlashCommands() {
  const data = await wsClient.request({ type: 'get_commands' });
  if (sessionClosed) return;
  if (!Array.isArray(data.data?.commands)) throw new Error('Slash command registry is invalid');

  const byName = new Map();
  for (const command of webSlashCommands) {
    byName.set(getSlashCommandName(command), command);
  }
  for (const command of data.data.commands) {
    const name = getSlashCommandName(command);
    if (!name) continue;
    const local = byName.get(name);
    byName.set(name, local ? { ...local, ...command, description: local.description || command.description } : command);
  }
  slashCommands = [...byName.values()];

  if (!slashMenu.classList.contains('hidden')) updateSlashMenu();
}

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

  const filtered = filterSlashCommands(slashCommands, fragment.query);

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
    const capability = getSlashCapability(command);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `slash-item${index === slashSelectedIndex ? ' active' : ''}${capability.enabled ? '' : ' capability-disabled'}`;
    item.id = `slash-command-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === slashSelectedIndex));
    item.setAttribute('aria-disabled', String(!capability.enabled));
    item.dataset.commandName = command.name;
    item.dataset.capability = capability.mode;
    item.title = capability.reason || `${command.description || ''} (${capability.label})`;
    item.innerHTML = `
      <span class="slash-name">/${escapeHtml(command.name)}</span>
      <span class="slash-desc">${escapeHtml(command.description || '')}</span>
      <span class="slash-source">${escapeHtml(capability.label || command.source || 'command')}</span>
    `;
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      executeSlashCommand(command, fragment);
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

function clearMessageInput() {
  messageInput.value = '';
  messageInput.style.height = 'auto';
  hideSlashMenu();
}

function buildSlashCommandText(command, fragment) {
  const before = messageInput.value.slice(0, fragment.start);
  const after = messageInput.value.slice(fragment.end);
  return { before, after, text: `${before}/${command.name}${after}` };
}

function selectSlashCommand(command, fragment = getSlashFragment()) {
  if (!fragment) return;
  const { before, after } = buildSlashCommandText(command, fragment);
  const insert = `/${command.name} `;
  messageInput.value = before + insert + after;
  const cursor = before.length + insert.length;
  messageInput.setSelectionRange(cursor, cursor);
  messageInput.dispatchEvent(new Event('input'));
  hideSlashMenu();
  messageInput.focus();
}

function executeSlashCommand(command, fragment = getSlashFragment()) {
  if (!fragment) return false;
  const { text } = buildSlashCommandText(command, fragment);
  const commandText = text.trim();

  // A slash token inside a normal prompt remains an autocomplete action.
  if (!commandText.startsWith('/')) {
    selectSlashCommand(command, fragment);
    return false;
  }

  const capability = getSlashCapability(command);
  if (!capability.enabled) {
    renderSlashCapabilityError(getSlashCommandName(command), capability);
    clearMessageInput();
    messageInput.focus();
    return true;
  }

  const handled = runSlashCommand(commandText);
  if (!handled) return false;
  clearMessageInput();
  messageInput.focus();
  return true;
}

function handleSlashMenuKeydown(event) {
  if (slashMenu.classList.contains('hidden')) return false;
  const items = Array.from(slashMenu.querySelectorAll('.slash-item'));
  if (items.length === 0) return false;
  const shortcut = matchShortcut(event, 'slash');

  if (shortcut?.id === 'slash.next' || shortcut?.id === 'slash.previous') {
    event.preventDefault();
    const delta = shortcut.id === 'slash.next' ? 1 : -1;
    slashSelectedIndex = (slashSelectedIndex + delta + items.length) % items.length;
    updateSlashMenu();
    return true;
  }

  if (shortcut?.id === 'slash.choose' || shortcut?.id === 'slash.choose-enter') {
    event.preventDefault();
    const commandName = items[slashSelectedIndex]?.dataset.commandName;
    const command = slashCommands.find((item) => String(item.name).toLowerCase() === String(commandName).toLowerCase());
    if (command) {
      executeSlashCommand(command);
    }
    return true;
  }

  if (shortcut?.id === 'slash.dismiss') {
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

function findSlashCommand(name) {
  return slashCommands.find((command) => String(command.name).toLowerCase() === name.toLowerCase());
}

async function executeRegisteredSlashCommand(command, args) {
  const response = await rpcCommand(
    { type: 'run_command', name: command.name, args },
    `Running /${command.name}...`,
  );
  if (response?.success === true && response.data?.command === 'quit' && response.data.status === 'shutdown') {
    enterSessionClosedState();
  }
  return response;
}

function runSlashCommand(text) {
  if (!text.startsWith('/')) return false;
  const [rawName, ...rest] = text.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(' ').trim();
  const command = findSlashCommand(name);
  const capability = getSlashCapability(command || { name });

  if (!capability.enabled) {
    renderSlashCapabilityError(name, capability);
    return true;
  }

  if (name === 'settings') {
    void openSettings();
    return true;
  }
  if (name === 'model') {
    openModelDropdown();
    return true;
  }
  if (name === 'compact') {
    void rpcCommand({ type: 'compact' }, 'Compacting...');
    return true;
  }
  if (name === 'export') {
    const context = requireSessionActionContext();
    if (context) sessionActions.openExport(context);
    return true;
  }
  if (name === 'session') {
    const context = requireSessionActionContext();
    if (context) void sessionActions.openInfo(context);
    return true;
  }
  if (name === 'hotkeys') {
    sessionActions.openHotkeys(visibleShortcuts());
    return true;
  }
  if (name === 'name') {
    if (args) {
      void renameCurrentSession(args);
    } else {
      const context = requireSessionActionContext();
      if (context) sessionActions.openRename(context);
    }
    return true;
  }
  if (name === 'new') {
    newSession();
    return true;
  }
  if (name === 'resume') {
    void openResumeChooser(args);
    return true;
  }
  if (name === 'fork') {
    void showForkPreview();
    return true;
  }
  if (name === 'tree') {
    void showSessionTreePreview();
    return true;
  }
  if (name === 'copy') {
    copyLatestAssistantMessage();
    return true;
  }
  if (name === 'reload-web') {
    setStatusMessage('Reloading Tau web UI...', 1500);
    location.reload();
    return true;
  }

  if (command && capability.mode === 'rpc') {
    void executeRegisteredSlashCommand(command, args);
    return true;
  }

  renderSlashCapabilityError(name, capability);
  return true;
}

async function getCurrentSessionEntriesForWeb() {
  if (currentSessionEntries.length > 0) return currentSessionEntries;
  const data = await rpcCommand({ type: 'get_messages' }, 'Loading session tree...');
  if (sessionClosed) return null;
  if (!data?.success) return null;
  currentSessionEntries = Array.isArray(data.data?.entries) ? data.data.entries : [];
  return currentSessionEntries;
}

function getSessionEntryText(entry) {
  if (entry?.type !== 'message') return entry?.type || 'entry';
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ');
  }
  return entry.message?.role || 'message';
}

function getSessionTreeInfo(entries) {
  const nodes = entries.filter((entry) => (
    entry && typeof entry.id === 'string' && Object.prototype.hasOwnProperty.call(entry, 'parentId')
  ));
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const children = new Map();
  for (const entry of nodes) {
    if (!entry.parentId || !byId.has(entry.parentId)) continue;
    const siblings = children.get(entry.parentId) || [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  return {
    hasTreeMetadata: nodes.length > 0,
    entries: nodes,
    roots: nodes.filter((entry) => entry.parentId === null),
    branchPoints: nodes.filter((entry) => (children.get(entry.id)?.length || 0) > 1),
    userMessages: nodes.filter((entry) => entry.type === 'message' && entry.message?.role === 'user'),
  };
}

function getLoadedSessionMatches(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const matches = [];
  for (const project of sidebar.allGroups()) {
    for (const session of project.sessions || []) {
      const values = [session.filePath, session.id, session.name].filter(Boolean).map((value) => String(value).toLowerCase());
      if (values.includes(normalized)) matches.push({ session, project });
    }
  }
  return matches;
}

async function openResumeChooser(query = '') {
  if (isMobile() && sidebarEl.classList.contains('collapsed')) toggleSidebar();
  const normalized = query.trim();
  sessionSearchInput.value = normalized;
  sidebar.setSearchQuery(normalized);
  await sidebar.loadSessions(false);
  if (sessionClosed) return;

  const exactMatches = getLoadedSessionMatches(normalized);
  if (normalized && exactMatches.length === 1) {
    await handleSessionSelect(exactMatches[0].session, exactMatches[0].project);
    return;
  }

  sessionSearchInput.focus();
  if (normalized) sessionSearchInput.select();
  messageRenderer.renderSystemMessage(normalized
    ? `Resume chooser filtered to "${normalized}". Select a session in the sidebar.`
    : 'Resume chooser opened. Select a session in the sidebar.');
}

async function showSessionTreePreview() {
  const entries = await getCurrentSessionEntriesForWeb();
  if (sessionClosed) return;
  if (!entries) return;
  const info = getSessionTreeInfo(entries);
  if (!info.hasTreeMetadata) {
    renderAppError('Session tree metadata is unavailable in the current session. Pi /tree navigation is not exposed by the web mirror.');
    return;
  }

  const lines = [
    'Session tree (read-only in Tau web)',
    `Entries: ${info.entries.length} · Roots: ${info.roots.length} · Branch points: ${info.branchPoints.length}`,
  ];
  if (info.branchPoints.length === 0) {
    lines.push('No branch point was found in the current session.');
  } else {
    for (const entry of info.branchPoints.slice(-6)) {
      const text = getSessionEntryText(entry).replace(/\s+/g, ' ').trim() || entry.type;
      const children = info.entries.filter((candidate) => candidate.parentId === entry.id).length;
      lines.push(`• ${text.slice(0, 100)} (${children} branches)`);
    }
  }
  lines.push('Switching branches requires Pi TUI /tree; the web mirror has no tree navigation RPC.');
  messageRenderer.renderSystemMessage(lines.join('\n'));
}

async function showForkPreview() {
  const entries = await getCurrentSessionEntriesForWeb();
  if (sessionClosed) return;
  if (!entries) return;
  const info = getSessionTreeInfo(entries);
  if (!info.hasTreeMetadata) {
    renderAppError('Fork points cannot be identified because this session has no tree metadata. Pi /fork is not exposed by the web mirror.');
    return;
  }

  const messages = info.userMessages.slice(-8);
  const lines = [
    'Fork preview (read-only in Tau web)',
    `Available user-message points: ${info.userMessages.length}`,
  ];
  for (const [index, entry] of messages.entries()) {
    const text = getSessionEntryText(entry).replace(/\s+/g, ' ').trim() || 'empty message';
    lines.push(`${index + 1}. ${text.slice(0, 100)}`);
  }
  lines.push('Creating a fork requires Pi TUI /fork; the web mirror has no fork RPC.');
  messageRenderer.renderSystemMessage(lines.join('\n'));
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
    if (statusMsg) setStatusMessage(statusMsg);
    const data = await wsClient.request(cmd);
    setStatusMessage('Done', 2000);
    return data;
  } catch (e) {
    const message = renderAppError(e, `${cmd.type || 'RPC command'} failed`);
    setStatusMessage(message, 3000);
    return e?.response || { success: false, error: message };
  }
}

async function renameCurrentSession(name) {
  const context = requireSessionActionContext();
  if (!context) return;
  try {
    setStatusMessage('Renaming...');
    await sessionActions.rename(context, name);
    setStatusMessage('Renamed', 2000);
  } catch (error) {
    const message = renderAppError(error, 'Failed to rename session');
    setStatusMessage(message, 3000);
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
let currentModelId = '';
let currentModelProvider = '';
let availableModels = [];
let scopedModels = [];
let currentThinkingLevel = 'off';
let availableThinkingLevels = ['off'];

async function fetchModelInfo() {
  try {
    const [modelsData, stateData] = await Promise.all([
      wsClient.request({ type: 'get_available_models' }),
      wsClient.request({ type: 'get_state' }),
    ]);
    if (sessionClosed) return;

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
      scopedModels = modelsData.data.scopedModels || [];
    } else if (modelsData.success === false) {
      renderAppError(modelsData, 'Failed to load models');
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      currentModelProvider = stateData.data.model.provider || '';
      updateModelLabel();

      const model = availableModels.find(modelIsCurrent);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    } else if (stateData.success === false) {
      renderAppError(stateData, 'Failed to load model state');
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      availableThinkingLevels = stateData.data.availableThinkingLevels || ['off'];
      updateModelLabel();
    }
    if (stateData.success && stateData.data?.cwd) {
      currentProjectPath = stateData.data.cwd;
    }
  } catch (e) {
    console.error('[App] Failed to load model info:', e);
    renderAppError(e, 'Failed to load model information');
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  modelDropdownLabel.textContent = `${shortName || 'model'} · ${currentThinkingLevel}`;
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
  const chevron = '<svg width="7" height="12" viewBox="0 0 7 12" fill="none"><path d="m1 1 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const renderConfig = () => {
    modelDropdownMenu.innerHTML = '';
    const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '') || 'model';
    const rows = [
      { label: 'Model', value: shortName, action: renderModels },
      { label: 'Reasoning', value: currentThinkingLevel, action: renderThinking },
    ];
    for (const row of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-config-row';
      button.innerHTML = `<span>${row.label}</span><span class="model-config-value">${escapeHtml(row.value)}</span>${chevron}`;
      button.addEventListener('click', row.action);
      modelDropdownMenu.appendChild(button);
    }
  };

  const renderBack = (title, onBack = renderConfig) => {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'model-dropdown-back';
    back.innerHTML = `<span>‹</span><strong>${title}</strong>`;
    back.addEventListener('click', onBack);
    modelDropdownMenu.appendChild(back);
  };

  function renderModels() {
    modelDropdownMenu.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'model-dropdown-heading';
    heading.textContent = 'Models';
    modelDropdownMenu.appendChild(heading);

    const reasoning = document.createElement('button');
    reasoning.type = 'button';
    reasoning.className = 'model-config-row';
    reasoning.innerHTML = `<span>Reasoning</span><span class="model-config-value">${escapeHtml(currentThinkingLevel)}</span>${chevron}`;
    reasoning.addEventListener('click', renderThinking);
    modelDropdownMenu.appendChild(reasoning);

    let showAllModels = scopedModels.length === 0 || !scopedModels.some((model) => model.availability?.available !== false);
    let includeUnavailable = false;
    const search = document.createElement('input');
    search.className = 'model-dropdown-search';
    search.placeholder = 'Search models…';
    search.type = 'text';
    modelDropdownMenu.appendChild(search);
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'model-dropdown-items';
    modelDropdownMenu.appendChild(itemsContainer);

    const renderItems = () => {
      itemsContainer.innerHTML = '';
      const query = search.value.trim().toLowerCase();
      const scopedIds = new Set(scopedModels.map(m => `${m.provider}/${m.id}`));
      const current = availableModels.find(modelIsCurrent);
      const scopedWithCurrent = current && !scopedIds.has(`${current.provider}/${current.id}`) ? [current, ...scopedModels] : scopedModels;
      const activeModels = [...(showAllModels ? availableModels : scopedWithCurrent)].sort((a, b) => {
        const aCurrent = modelIsCurrent(a) ? 0 : 1;
        const bCurrent = modelIsCurrent(b) ? 0 : 1;
        if (aCurrent !== bCurrent) return aCurrent - bCurrent;
        const aAvailable = a.availability?.available === false ? 1 : 0;
        const bAvailable = b.availability?.available === false ? 1 : 0;
        if (aAvailable !== bAvailable) return aAvailable - bAvailable;
        const providerCompare = String(a.provider || '').localeCompare(String(b.provider || ''));
        if (providerCompare !== 0) return providerCompare;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
      const visibleModels = activeModels.filter((model) => {
        const available = model.availability?.available !== false;
        const searchableText = `${model.id || ''} ${model.provider || ''}`.toLowerCase();
        if (query && !searchableText.includes(query)) return false;
        return available || includeUnavailable || Boolean(query) || modelIsCurrent(model);
      });

      for (const model of visibleModels) {
        const shortName = model.id.replace(/-\d{8}$/, '');
        const item = document.createElement('button');
        item.type = 'button';
        const available = model.availability?.available !== false;
        const availabilityReason = model.availability?.reason || 'Provider authentication is not configured';
        item.disabled = !available;
        item.className = `model-dropdown-item${modelIsCurrent(model) ? ' active' : ''}${available ? '' : ' unavailable'}`;
        item.innerHTML = `<span class="model-dropdown-item-main"><span class="model-dropdown-item-name">${escapeHtml(shortName)}</span><span class="model-dropdown-item-provider">${escapeHtml(model.provider || '')}</span>${available ? '' : `<span class="model-dropdown-item-availability">${escapeHtml(availabilityReason)}</span>`}</span>${modelIsCurrent(model) ? '<span>✓</span>' : ''}`;
        if (!available) {
          item.title = availabilityReason;
          itemsContainer.appendChild(item);
          continue;
        }
        item.addEventListener('click', async () => {
          const data = await rpcCommand({ type: 'set_model', provider: model.provider, modelId: model.id }, `Switching to ${shortName}...`);
          if (!data?.success) return;
          currentModelId = data.data?.model?.id || model.id;
          currentModelProvider = data.data?.model?.provider || model.provider || '';
          currentThinkingLevel = data.data?.thinkingLevel || currentThinkingLevel;
          availableThinkingLevels = data.data?.availableThinkingLevels || availableThinkingLevels;
          if (model.contextWindow) contextWindowSize = model.contextWindow;
          updateModelLabel();
          closeModelDropdown();
        });
        itemsContainer.appendChild(item);
      }

      if (visibleModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-dropdown-empty';
        empty.textContent = query ? 'No matching models' : 'No available models';
        itemsContainer.appendChild(empty);
      }

      const unavailableCount = activeModels.filter((model) => model.availability?.available === false).length;
      if (unavailableCount > 0) {
        const availabilityToggle = document.createElement('button');
        availabilityToggle.type = 'button';
        availabilityToggle.className = 'model-dropdown-scope-btn';
        availabilityToggle.textContent = includeUnavailable
          ? 'Hide unavailable models'
          : `Show unavailable models (${unavailableCount})`;
        availabilityToggle.addEventListener('click', () => {
          includeUnavailable = !includeUnavailable;
          renderItems();
        });
        itemsContainer.appendChild(availabilityToggle);
      }

      if (scopedModels.length > 0) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'model-dropdown-scope-btn';
        const otherCount = availableModels.filter((model) => !scopedIds.has(`${model.provider}/${model.id}`)).length;
        toggle.textContent = showAllModels ? 'Show scoped models' : `Show other models (${otherCount})`;
        toggle.addEventListener('click', () => { showAllModels = !showAllModels; renderItems(); });
        itemsContainer.appendChild(toggle);
      }
    };
    search.addEventListener('input', renderItems);
    renderItems();
    requestAnimationFrame(() => search.focus());
  }

  function renderThinking() {
    modelDropdownMenu.innerHTML = '';
    renderBack('Reasoning', renderModels);
    const levels = Array.from(new Set([...availableThinkingLevels, currentThinkingLevel])).filter(Boolean);
    for (const level of levels) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `model-dropdown-item${level === currentThinkingLevel ? ' active' : ''}`;
      item.innerHTML = `<span>${escapeHtml(level)}</span>${level === currentThinkingLevel ? '<span>✓</span>' : ''}`;
      item.addEventListener('click', async () => {
        const data = await rpcCommand({ type: 'set_thinking_level', level }, `Switching to ${level}...`);
        if (!data?.success) return;
        currentThinkingLevel = data.data?.level || level;
        updateModelLabel();
        closeModelDropdown();
      });
      modelDropdownMenu.appendChild(item);
    }
  }

  renderModels();

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
}

modelDropdownBtn.addEventListener('click', toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const clickPath = e.composedPath();
  if (!clickPath.includes(modelDropdown)) {
    closeModelDropdown();
  }
  if (!clickPath.includes(branchDropdown)) {
    closeBranchDropdown();
  }
});

// ═══════════════════════════════════════
// Git branch switcher
// ═══════════════════════════════════════

let currentGitState = { isRepo: false, currentBranch: '', branches: [] };

async function fetchGitState() {
  const response = await fetch('/api/git');
  if (sessionClosed) return;
  const data = await response.json();
  if (sessionClosed) return;
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
  const response = await mutationFetch('/api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (sessionClosed) return;
  const data = await response.json();
  if (sessionClosed) return;
  if (!response.ok || !data.ok) {
    renderAppError(data.error || 'Failed to switch branch');
    return;
  }
  currentGitState = data;
  renderGitState();
}

branchDropdownBtn.addEventListener('click', toggleBranchDropdown);

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (!slashMenu.classList.contains('hidden') && handleSlashMenuKeydown(e)) {
    return;
  }

  const shortcut = matchShortcut(e, 'global');

  if (shortcut?.id === 'ui.dismiss') {
    if (document.getElementById('session-actions-dialog').open) {
      sessionActions.close();
      return;
    }
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
      abortCurrentAgent();
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  if (shortcut?.id === 'commands.focus' && !isInInput() && !sessionClosed) {
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
  return mobileViewport.matches;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  if (!isMobile()) desktopSidebarCollapsed = sidebarEl.classList.contains('collapsed');
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
    if (sessionClosed) return;
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

function setSessionTitle(title) {
  if (sessionClosed) return;
  const value = title || 'Untitled session';
  sessionTitleText.textContent = value;
  sessionTitleBtn.title = `Rename ${value}`;
}

function getSessionActionContext(session) {
  return resolveSessionActionContext({
    session,
    currentSession,
    mirrorActiveSessionFile,
    viewingActiveSession,
    isNewSessionMode,
  });
}

function requireSessionActionContext() {
  const context = getSessionActionContext();
  if (context) return context;
  messageRenderer.renderSystemMessage('Start the new session before using session actions.');
  return null;
}

async function handleSessionRenamed(session) {
  if (sessionClosed) return;
  if (actionTargetsDisplayedSession({
    sessionFile: session.sessionFile,
    active: session.active,
    currentSessionFile: currentSession?.filePath || null,
    viewingActiveSession,
  })) {
    currentSession = {
      ...(currentSession || {}),
      filePath: session.sessionFile,
      name: session.name,
    };
    setSessionTitle(session.name);
  }
  if (session.sessionFile) {
    document.querySelectorAll('.session-item').forEach((item) => {
      if (item.dataset.filePath === session.sessionFile) {
        const title = item.querySelector('.session-title');
        if (title) title.textContent = session.name;
      }
    });
  }
  await sidebar.loadSessions(false);
  if (sessionClosed) return;
  if (currentSession?.filePath) sidebar.setActive(currentSession.filePath);
}

function handleSessionAction(action, { session, project }) {
  if (sessionClosed) return;
  const context = getSessionActionContext(session);
  if (action === 'open') {
    void handleSessionSelect(session, project);
  } else if (action === 'rename') {
    sessionActions.openRename(context);
  } else if (action === 'export') {
    sessionActions.openExport(context);
  } else if (action === 'info') {
    void sessionActions.openInfo(context);
  }
}

sessionTitleBtn.addEventListener('click', () => {
  if (sessionClosed) return;
  const context = requireSessionActionContext();
  if (context) sessionActions.openRename(context);
});

connectionStatusBtn.addEventListener('click', () => {
  if (!sessionClosed) void sessionActions.openConnect();
});

async function newSession() {
  if (sessionClosed) return;
  newTrustMode.value = 'saved';
  sessionTotalCost = 0;
  lastInputTokens = 0;
  currentSessionEntries = [];
  updateCostDisplay();
  updateTokenUsage();
  state.reset();
  messageQueue = [];
  lastSentMessage = null;
  renderQueuedMessages();
  messageRenderer.clear();
  toolCardRenderer.clear();
  messageRenderer.renderWelcome();
  sidebar.clearActive();
  currentSession = null;
  setSessionTitle('New session');
  viewingActiveSession = true;
  updateMirrorInputState();
  enterNewSessionMode();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function handleSessionSelect(session, project) {
  if (sessionClosed) return;
  if (!session) {
    await newSession();
    return;
  }
  exitNewSessionMode();
  currentSession = session;
  sessionTitleBtn.disabled = false;
  setSessionTitle(sessionActionTitle(session));
  sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(session.filePath, session, project);
  if (sessionClosed) return;

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
    currentSessionEntries = [];
    messageRenderer.clear();
    toolCardRenderer.clear();

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage('Loading session...');

      const dirName = project?.dirName;
      const file = session.file;
      console.log('[App] Loading history:', { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const sessionPath = encodeURIComponent(`${dirName}/${file}`);
          const res = await fetch(`/api/sessions/${sessionPath}`);
          if (sessionClosed) return;
          console.log('[App] History fetch status:', res.status);
          const data = await res.json();
          if (sessionClosed) return;
          console.log('[App] History entries:', data.entries?.length || 0);

          messageRenderer.clear();
          currentSessionEntries = Array.isArray(data.entries) ? data.entries : [];
          renderSessionHistoryOrWelcome(data.entries || []);
        } catch (e) {
          if (sessionClosed) return;
          console.error('[App] History fetch error:', e);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      messageRenderer.renderWelcome();
    }
    if (sessionClosed) return;

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
    }
  } catch (error) {
    if (sessionClosed) return;
    console.error('[App] Failed to switch session:', error);
    renderAppError(error, 'Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  clearExtensionUIState();
  isMirrorMode = true;

  if (typeof data.isStreaming === 'boolean') {
    state.setStreaming(data.isStreaming);
    showTypingIndicator(data.isStreaming);
  }

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  currentSessionEntries = Array.isArray(data.entries) ? data.entries : [];
  currentSession = {
    filePath: mirrorActiveSessionFile,
    name: data.sessionName || null,
  };
  sessionTitleBtn.disabled = false;
  setSessionTitle(data.sessionName || 'Untitled session');
  sidebar.setActive(mirrorActiveSessionFile);
  currentProjectPath = data.cwd || currentProjectPath;
  viewingActiveSession = true;
  updateMirrorInputState();
  updateMirrorLiveIndicator();
  fetchGitState().catch(() => {});

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
    updateModelLabel();
  }

  // Keep the optimistic user bubble while Pi is still flushing the first entry.
  const pendingUserMessage = lastSentMessage && messagesContainer.querySelector('.message.user:not(.history)')
    ? lastSentMessage
    : null;

  // Clear and render message history
  messageRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;

  renderSessionHistoryOrWelcome(data.entries || [], pendingUserMessage);

  if (reusedLaunchNotice) {
    const notice = 'Connected to the existing instance. Trust mode only applies when starting a new instance.';
    messageRenderer.renderSystemMessage(notice);
    setStatusMessage(notice, 5000);
    const url = new URL(location.href);
    url.searchParams.delete('tauReused');
    history.replaceState(null, '', url);
    reusedLaunchNotice = false;
  }

  updateCostDisplay();
  updateTokenUsage();
  updateUI();
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
  if (sessionClosed) return;
  try {
    const res = await fetch('/api/instances');
    if (sessionClosed) return;
    if (res.ok) {
      const data = await res.json();
      if (sessionClosed) return;
      liveInstances = data.instances || [];
      updateMirrorLiveIndicator();
    }
  } catch {}
}

// Poll every 5 seconds
instancePollTimer = setInterval(pollInstances, 5000);
pollInstances();

function getCurrentComposerState() {
  return getComposerState({ isMirrorMode, viewingActiveSession, isLaunchingNewSession, sessionClosed });
}

// Keep every composer entry point aligned with the active session state.
function updateMirrorInputState() {
  const inputArea = document.querySelector('.input-area');
  const composerState = getCurrentComposerState();
  messageInput.disabled = composerState.disabled;
  sendBtn.disabled = composerState.disabled;
  messageInput.placeholder = composerState.placeholder;
  inputArea?.classList.toggle('mirror-readonly', composerState.readOnly);
}

function enterSessionClosedState() {
  if (sessionClosed) return;
  sessionClosed = true;
  clearTimeout(sidebarRefreshTimer);
  clearTimeout(contextWindowTimer);
  clearTimeout(statusResetTimer);
  clearInterval(instancePollTimer);
  sidebarRefreshTimer = null;
  contextWindowTimer = null;
  statusResetTimer = null;
  instancePollTimer = null;
  messageQueue = [];
  state.reset();
  showTypingIndicator(false);
  sessionActions.close();
  dialogHandler.dismissCurrentDialog();
  clearExtensionUIState();
  sidebar.closeContextMenu();
  sidebar.hideSessionHoverCard();
  closeCommandPalette();
  hideSlashMenu();
  closeModelDropdown();
  closeBranchDropdown();
  closeSettings();
  if (sessionLaunchDialog.open) sessionLaunchDialog.close();
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  fileSidebar.classList.add('collapsed');
  syncMobileFileSidebar();
  wsClient.disconnect();

  document.body.classList.remove('new-session-mode');
  document.body.classList.add('session-closed');
  sessionTitleText.textContent = '';
  sessionTitleBtn.disabled = true;
  statusText.textContent = '';
  statusIndicator.className = 'status-indicator';
  connectionStatusBtn.disabled = true;
  sessionCostEl.textContent = '';
  tokenUsageEl.textContent = '';
  contextViz.classList.add('hidden');
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  abortBtn.classList.add('hidden');
  sendBtn.classList.remove('hidden');
  disableSessionControls(document);
  for (const region of [sidebarEl, document.querySelector('.header'), settingsPanel, fileSidebar, document.querySelector('.input-area')]) {
    if (region) region.inert = true;
  }
  updateMirrorInputState();

  const closed = document.createElement('section');
  closed.className = 'session-closed-state';
  const heading = document.createElement('h1');
  heading.textContent = 'Session closed';
  const detail = document.createElement('p');
  detail.textContent = 'The Pi session has ended.';
  closed.append(heading, detail);
  messagesContainer.replaceChildren(closed);
}

async function launchSessionInstance(sessionFile, projectPath) {
  if (sessionClosed) return false;
  if (!projectPath) {
    renderAppError('Cannot resume session: missing project path');
    return false;
  }
  const trustMode = await chooseSessionLaunchTrustMode();
  if (sessionClosed) return false;
  if (!trustMode) return false;
  document.querySelector('.input-area')?.classList.remove('mirror-readonly');
  messageInput.disabled = true;
  messageInput.placeholder = 'Opening session...';
  statusText.textContent = 'Opening session...';

  try {
    const response = await mutationFetch('/api/sessions/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, sessionFile, trustMode }),
    });
    if (sessionClosed) return false;
    const data = await response.json();
    if (sessionClosed) return false;
    if (!response.ok) {
      renderAppError(data.error || 'Failed to open session');
      statusText.textContent = 'Connected';
      updateMirrorInputState();
      return false;
    }

    navigateToInstance(data, data.reused === true);
    return true;
  } catch (error) {
    if (sessionClosed) return false;
    renderAppError(error, 'Failed to open session');
    statusText.textContent = 'Connected';
    updateMirrorInputState();
    return false;
  }
}

async function launchNewSessionWithPendingMessage(cmd) {
  if (sessionClosed) return { ok: false, error: 'Session closed' };
  if (isLaunchingNewSession) return { ok: false, error: 'New session is already opening' };
  isLaunchingNewSession = true;
  messageInput.disabled = true;
  sendBtn.disabled = true;

  let navigated = false;
  try {
    if (!newSessionProjectLoad) startNewSessionProjectLoad();
    await newSessionProjectLoad;
    if (sessionClosed) return { ok: false, error: 'Session closed' };
    statusText.textContent = 'Opening new session...';

    const response = await mutationFetch('/api/projects/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selectedNewProject
        ? { path: selectedNewProject.path, command: cmd, trustMode: newTrustMode.value }
        : { noProject: true, command: cmd, trustMode: newTrustMode.value }),
    });
    if (sessionClosed) return { ok: false, error: 'Session closed' };
    const data = await response.json();
    if (sessionClosed) return { ok: false, error: 'Session closed' };
    if (!response.ok) {
      statusText.textContent = 'Connected';
      return { ok: false, error: data.error || 'Failed to open new session' };
    }

    navigated = true;
    navigateToInstance(data);
    return { ok: true };
  } catch (error) {
    if (sessionClosed) return { ok: false, error: 'Session closed' };
    console.error('[App] Failed to launch new session:', error);
    statusText.textContent = 'Connected';
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to open new session' };
  } finally {
    if (!navigated && !sessionClosed) {
      isLaunchingNewSession = false;
      messageInput.disabled = false;
      sendBtn.disabled = false;
      updateMirrorInputState();
    }
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistoryOrWelcome(entries, pendingUserMessage = null) {
  const fallback = getSessionHistoryFallback(
    renderSessionHistory(entries),
    pendingUserMessage,
  );
  if (fallback === 'pending-user') {
    messageRenderer.renderUserMessage({ content: pendingUserMessage });
  } else if (fallback === 'welcome') {
    messageRenderer.renderWelcome();
  }
}

function renderSessionHistory(entries) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0, renderedCount = 0;

  for (const entry of entries) {
    if (entry.type === 'custom_message' && entry.display === true) {
      if (messageRenderer.renderCustomMessage(entry, true)) renderedCount++;
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
        renderedCount++;
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
        renderedCount++;

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
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        if (card) {
          toolCardCount++;
          renderedCount++;
        }
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

  return renderedCount;
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
  if (sessionClosed) return;
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (sessionClosed) return;
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

function updateUI({ flushPending = true } = {}) {
  if (sessionClosed) return;
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

  updateMirrorInputState();
  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    if (flushPending && !getCurrentComposerState().disabled) flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  if (sessionClosed) return;
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
const settingsParity = createSettingsParity({
  request: (command) => wsClient.request(command),
  onModelsSaved: fetchModelInfo,
});

let webSettings = null;

function updateAuthCapability(next) {
  authCapability = { ...authCapability, ...next };
  const configured = authCapability.configured === true;
  authSection.style.display = configured ? '' : 'none';
  toggleAuth.classList.toggle('on', configured && authCapability.enabled === true);
  toggleAuth.disabled = !configured || authCapability.available === false;
  toggleAuth.title = configured
    ? (authCapability.available === false ? 'Tau web authentication is unavailable' : 'Require login for Tau web')
    : 'Tau web authentication is not configured';
}

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    btn.type = 'button';
    btn.setAttribute('aria-label', theme.name);
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span>${escapeHtml(theme.name)}</span><span class="swatch-colors">${dots}</span>`;
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

  const response = await mutationFetch('/api/web-settings', {
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
}

settingsReload.addEventListener('click', () => {
  Promise.all([loadWebSettings(), settingsParity.load()]).catch((error) => {
    renderAppError(error);
  });
});

settingsSave.addEventListener('click', () => {
  (async () => {
    await saveWebSettings();
    await settingsParity.save();
    setStatusMessage('Settings saved', 2000);
  })().catch((error) => {
    renderAppError(error);
  });
});

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');
  loadWebSettings().catch((error) => {
    renderAppError(error);
  });
  void settingsParity.load();
  fetchGitState();

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      updateAuthCapability({
        configured: true,
        enabled: authData.data.enabled === true,
        available: true,
      });
    } else {
      updateAuthCapability({ configured: false, enabled: false, available: false });
    }
  } catch {
    updateAuthCapability({ configured: false, enabled: false, available: false });
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

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
  if (sessionClosed) return;
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
    if (!isOn) location.reload();
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

function syncResponsiveSidebar(event) {
  if (event.matches) {
    desktopSidebarCollapsed = sidebarEl.classList.contains('collapsed');
    sidebarEl.classList.add('collapsed');
  } else {
    sidebarEl.classList.toggle('collapsed', desktopSidebarCollapsed);
  }
  sidebarOverlay.classList.remove('visible');
}

syncResponsiveSidebar(mobileViewport);
mobileViewport.addEventListener('change', syncResponsiveSidebar);

// New session project picker
const newSessionTools = document.getElementById('new-session-tools');
const newProjectBtn = document.getElementById('new-project-btn');
const newProjectLabel = document.getElementById('new-project-label');
const newProjectMenu = document.getElementById('new-project-menu');
const newTrustMode = document.getElementById('new-trust-mode');
const sessionLaunchDialog = document.getElementById('session-launch-dialog');
const sessionLaunchTrustMode = document.getElementById('session-launch-trust-mode');
let isNewSessionMode = false;
let newSessionProjects = [];
let selectedNewProject = null;
let newSessionTaskPath = '';
let newSessionProjectLoad = null;

function chooseSessionLaunchTrustMode() {
  sessionLaunchTrustMode.value = 'saved';
  sessionLaunchDialog.returnValue = '';
  sessionLaunchDialog.showModal();
  return new Promise((resolve) => {
    sessionLaunchDialog.addEventListener('close', () => {
      resolve(sessionLaunchDialog.returnValue === 'launch' ? sessionLaunchTrustMode.value : null);
    }, { once: true });
  });
}

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
  if (sessionClosed) return;
  const data = await response.json();
  if (sessionClosed) return;
  newSessionProjects = data.projects || [];
  newSessionTaskPath = data.taskPath || '';
  selectedNewProject = currentProjectPath === newSessionTaskPath
    ? null
    : newSessionProjects.find(p => p.path === currentProjectPath) ||
      newSessionProjects.find(p => p.active) ||
      newSessionProjects[0] ||
      null;
  renderNewProjectLabel();
}

function startNewSessionProjectLoad() {
  const load = loadNewSessionProjects();
  newSessionProjectLoad = load;
  load.catch((error) => {
    if (newSessionProjectLoad === load) newSessionProjectLoad = null;
    console.error('[App] Failed to load projects:', error);
  });
  return load;
}

function navigateToInstance(instance, reused = false) {
  if (sessionClosed) return;
  const url = new URL(location.href);
  url.port = String(instance.port);
  if (reused) url.searchParams.set('tauReused', '1');
  else url.searchParams.delete('tauReused');
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
  if (sessionClosed) return;
  renderNewProjectMenu();
  newProjectMenu.classList.remove('hidden');
}

function closeNewProjectMenu() {
  newProjectMenu.classList.add('hidden');
}

function restoreNewSessionDraft(draft, error) {
  if (sessionClosed) return;
  state.reset();
  lastSentMessage = null;
  messageRenderer.clear();
  toolCardRenderer.clear();
  sidebar.clearActive();
  isNewSessionMode = true;
  sessionTitleBtn.disabled = true;
  document.body.classList.add('new-session-mode');
  newSessionTools.classList.remove('hidden');
  messageRenderer.renderWelcome();
  renderNewProjectLabel();
  messageRenderer.renderError(error);

  pendingImages = draft.images;
  pendingFilePaths = draft.filePaths;
  renderAttachmentPreviews();
  messageInput.value = draft.message;
  messageInput.dispatchEvent(new Event('input'));
  messageInput.disabled = false;
  sendBtn.disabled = false;
  updateMirrorInputState();
  if (!isMobile()) messageInput.focus();
}

function enterNewSessionMode() {
  isNewSessionMode = true;
  sessionTitleBtn.disabled = true;
  document.body.classList.add('new-session-mode');
  newSessionTools.classList.remove('hidden');
  renderNewSessionWelcome();
  startNewSessionProjectLoad();
  if (!isMobile()) messageInput.focus();
}

function exitNewSessionMode() {
  isNewSessionMode = false;
  sessionTitleBtn.disabled = !currentSession;
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
