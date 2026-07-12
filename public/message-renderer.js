/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown, sanitizeImageSource } from './markdown.js';

export function hasDurableEntryActions(isHistory, entry) {
  return Boolean(isHistory && typeof entry?.entryId === 'string' && entry.entryId);
}

export function rawMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export class MessageRenderer {
  constructor(container, onEntryAction = null) {
    this.container = container;
    this.onEntryAction = onEntryAction;
    this.entryMetadata = new Map();
    this.isNearBottom = true;

    // Track scroll position for smart auto-scroll
    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
    this.container.addEventListener('click', (event) => this._handleEntryAction(event));
    this.container.addEventListener('keydown', (event) => {
      const menu = event.target.closest?.('.message-entry-menu');
      if (menu) {
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        const index = items.indexOf(event.target);
        let next = null;
        if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
        else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
        else if (event.key === 'Home') next = items[0];
        else if (event.key === 'End') next = items.at(-1);
        if (next) {
          event.preventDefault();
          next.focus();
          return;
        }
      }
      if (event.key !== 'Escape') return;
      const trigger = this._closeEntryMenus();
      if (trigger) {
        event.preventDefault();
        trigger.focus();
      }
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.('.message-entry-actions')) this._closeEntryMenus();
    });
  }

  clear() {
    this.entryMetadata.clear();
    this.container.innerHTML = '';
  }

  /**
   * Render KaTeX math in the given element if the library is loaded.
   * Safe to call on streaming/escaped content — KaTeX only processes $...$ patterns.
   */
  _renderMath(element) {
    if (typeof renderMathInElement !== 'undefined') {
      try {
        renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) {
        // KaTeX not loaded or rendering failed — math stays as raw TeX
      }
    }
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Pi Tau</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false, entry = null) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    const durable = hasDurableEntryActions(isHistory, entry);
    if (durable) {
      div.dataset.entryId = entry.entryId;
      this.entryMetadata.set(entry.entryId, entry);
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderUserMarkdown(message.content);

    if (Array.isArray(message.images) && message.images.length > 0) {
      const images = document.createElement('div');
      images.className = 'message-images';
      for (const imageData of message.images) {
        const src = sanitizeImageSource(imageData);
        if (!src) continue;
        const image = document.createElement('img');
        image.className = 'message-image';
        image.src = src;
        image.alt = 'Attached image';
        images.appendChild(image);
      }
      if (images.childElementCount > 0) content.prepend(images);
    }

    if (durable) {
      const actions = document.createElement('div');
      actions.className = 'message-entry-actions';
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'message-entry-trigger';
      trigger.dataset.entryMenuTrigger = entry.entryId;
      trigger.title = 'Message actions';
      trigger.setAttribute('aria-label', 'More message actions');
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.textContent = '•••';
      const menu = document.createElement('div');
      menu.className = 'message-entry-menu hidden';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Message actions');
      const buttons = [
        ['copy', '⎘', 'Copy'],
        ['fork', '✎', 'Edit & fork'],
        ['branch', '↗', 'Continue from here'],
        ['label', '#', 'Add label'],
      ];
      for (const [action, icon, label] of buttons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-entry-menu-item';
        button.dataset.entryAction = action;
        button.dataset.entryId = entry.entryId;
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-label', label);
        const iconElement = document.createElement('span');
        iconElement.setAttribute('aria-hidden', 'true');
        iconElement.textContent = icon;
        button.append(iconElement, label);
        menu.appendChild(button);
      }
      actions.append(trigger, menu);
      div.append(content, actions);
    } else {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'message-copy-btn';
      copy.title = 'Copy';
      copy.setAttribute('aria-label', 'Copy message');
      copy.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      div.append(content, copy);
      this._setupCopyBtn(div);
    }
    this.container.appendChild(div);
    this._renderMath(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text);
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      this._setupCopyBtn(div);
    }
    this.container.appendChild(div);
    if (!isStreaming) this._renderMath(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      // Keep any thinking block, update only the text part
      const thinkingBlock = contentDiv.querySelector('.streaming-thinking');
      if (thinkingBlock) {
        // Remove everything after the thinking block and re-add text
        let textNode = contentDiv.querySelector('.streaming-text');
        if (!textNode) {
          textNode = document.createElement('div');
          textNode.className = 'streaming-text';
          contentDiv.appendChild(textNode);
        }
        textNode.textContent = content;
      } else {
        contentDiv.textContent = content;
      }
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '') {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      // Get the raw text (exclude thinking block text)
      const streamingText = contentDiv.querySelector('.streaming-text');
      const rawText = streamingText ? streamingText.textContent : contentDiv.textContent;
      
      // Rebuild with thinking block (if any) + markdown text
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += renderMarkdown(rawText);
      contentDiv.innerHTML = html;
      // Render math after markdown is applied
      this._renderMath(contentDiv);
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (usage && usage.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector('.message-usage')) {
        const span = document.createElement('span');
        span.className = 'message-usage';
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderCustomMessage(entry, isHistory = false) {
    if (entry.display !== true) return null;

    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const message = entry.message || entry;
    const div = document.createElement('div');
    div.className = `custom-message${isHistory ? ' history' : ''}`;

    const title = document.createElement('div');
    title.className = 'custom-message-title';
    title.textContent = message.customType;
    div.appendChild(title);

    const body = document.createElement('div');
    body.className = 'custom-message-body';
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : [];

    for (const block of blocks) {
      if (block.type === 'text') {
        const text = document.createElement('div');
        text.className = 'custom-message-text';
        text.innerHTML = renderMarkdown(block.text);
        body.appendChild(text);
      } else if (block.type === 'image') {
        const image = document.createElement('img');
        image.className = 'message-image';
        const src = sanitizeImageSource(block);
        if (!src) continue;
        image.src = src;
        image.alt = 'Extension image';
        body.appendChild(image);
      }
    }
    div.appendChild(body);
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `Error: ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      this._copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  _handleEntryAction(event) {
    const trigger = event.target.closest?.('[data-entry-menu-trigger]');
    if (trigger && this.container.contains(trigger)) {
      const menu = trigger.nextElementSibling;
      const opening = menu.classList.contains('hidden');
      this._closeEntryMenus();
      if (opening) {
        menu.classList.remove('hidden');
        trigger.setAttribute('aria-expanded', 'true');
        menu.querySelector('[role="menuitem"]')?.focus();
      }
      return;
    }
    const button = event.target.closest?.('[data-entry-action]');
    if (!button || !this.container.contains(button)) return;
    const entry = this.entryMetadata.get(button.dataset.entryId);
    if (!entry || button.disabled) return;
    const messageElement = button.closest('.message');
    const controls = messageElement.querySelectorAll('[data-entry-action]');
    this._closeEntryMenus();
    if (button.dataset.entryAction === 'copy') {
      const trigger = messageElement.querySelector('[data-entry-menu-trigger]');
      this._copyText(rawMessageText(entry.message)).then(() => {
        trigger.textContent = '✓';
        trigger.title = 'Copied';
        setTimeout(() => {
          trigger.textContent = '•••';
          trigger.title = 'Message actions';
        }, 1500);
      }, (error) => {
        trigger.title = error.message;
        console.error('[Messages] Copy failed:', error);
      });
      return;
    }
    if (!this.onEntryAction) return;
    controls.forEach((control) => { control.disabled = true; });
    const enable = () => controls.forEach((control) => { control.disabled = false; });
    try {
      Promise.resolve(this.onEntryAction(button.dataset.entryAction, entry)).then(enable, (error) => {
        enable();
        console.error('[Messages] Entry action failed:', error);
      });
    } catch (error) {
      enable();
      throw error;
    }
  }

  _closeEntryMenus() {
    let focusedTrigger = null;
    for (const menu of this.container.querySelectorAll('.message-entry-menu:not(.hidden)')) {
      const trigger = menu.previousElementSibling;
      if (menu.contains(document.activeElement)) focusedTrigger = trigger;
      menu.classList.add('hidden');
      trigger?.setAttribute('aria-expanded', 'false');
    }
    return focusedTrigger;
  }

  _copyText(text) {
    if (navigator.clipboard) return navigator.clipboard.writeText(text);
    const input = document.createElement('textarea');
    input.value = text;
    input.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    return Promise.resolve();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
