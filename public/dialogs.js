/**
 * Dialogs - Handles extension UI dialogs
 */

import { renderUserMarkdown } from './markdown.js';

export function configureDialogInput(input, secret, label) {
  input.type = secret === true ? 'password' : 'text';
  input.setAttribute('aria-label', label);
  if (secret !== true) return;
  input.spellcheck = false;
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
}

export function mountExtensionNotification(documentRef, request) {
  let region = documentRef.getElementById('extension-notifications');
  if (!region) {
    region = documentRef.createElement('div');
    region.id = 'extension-notifications';
    region.setAttribute('aria-live', 'polite');
    documentRef.body.appendChild(region);
  }

  const notification = documentRef.createElement('div');
  notification.className = `extension-notification ${request.notifyType || 'info'}`;
  notification.setAttribute('role', request.notifyType === 'error' ? 'alert' : 'status');

  const message = documentRef.createElement('span');
  message.innerHTML = renderUserMarkdown(request.message || '');
  const close = documentRef.createElement('button');
  close.type = 'button';
  close.className = 'extension-notification-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';

  const dismiss = () => {
    notification.remove();
    if (region.childElementCount === 0) region.remove();
  };
  close.onclick = dismiss;
  notification.append(message, close);
  region.appendChild(notification);
  return { notification, dismiss };
}

export class DialogHandler {
  constructor(container, wsClient) {
    this.container = container;
    this.wsClient = wsClient;
    this.currentDialog = null;
    this.currentRequestId = null;
    this.timeoutId = null;
    this.handleKeyDown = (event) => {
      if (event.key !== 'Escape' || !this.currentRequestId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.respond(this.currentRequestId, { cancelled: true });
    };
    this.handleBackdropClick = (event) => {
      if (event.target !== this.container || !this.currentRequestId) return;
      this.respond(this.currentRequestId, { cancelled: true });
    };
  }

  showSelect(request) {
    this.dismissCurrentDialog(true);

    const { id, title, options, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Select an option')}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
      </div>
    `;

    const optionsContainer = dialog.querySelector('#dialog-options');
    
    (options || []).forEach(option => {
      const optionDiv = document.createElement('div');
      optionDiv.className = 'dialog-option';
      optionDiv.tabIndex = 0;
      optionDiv.setAttribute('role', 'option');
      optionDiv.textContent = option;
      const selectOption = () => this.respond(id, { value: option });
      optionDiv.onclick = selectOption;
      optionDiv.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectOption();
      };
      optionsContainer.appendChild(optionDiv);
    });

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);
  }

  showConfirm(request) {
    this.dismissCurrentDialog(true);

    const { id, title, message, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Confirm')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button id="dialog-no">No</button>
        <button id="dialog-yes">Yes</button>
      </div>
    `;

    dialog.querySelector('#dialog-yes').onclick = () => {
      this.respond(id, { confirmed: true });
    };

    dialog.querySelector('#dialog-no').onclick = () => {
      this.respond(id, { confirmed: false });
    };

    this.showDialog(dialog, timeout, id);
  }

  showInput(request) {
    this.dismissCurrentDialog(true);

    const { id, title, placeholder, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Input')}</div>
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" />
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-submit">Submit</button>
      </div>
    `;

    const input = dialog.querySelector('#dialog-input');
    configureDialogInput(input, request.secret, title || 'Input');
    
    const submit = () => {
      this.respond(id, { value: input.value });
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit').onclick = submit;
    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);
  }

  showEditor(request) {
    this.dismissCurrentDialog(true);

    const { id, title, prefill, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Editor')}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-save">Save</button>
      </div>
    `;

    const textarea = dialog.querySelector('#dialog-textarea');

    dialog.querySelector('#dialog-save').onclick = () => {
      this.respond(id, { value: textarea.value });
    };

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      this.respond(id, { value: textarea.value });
    });

    this.showDialog(dialog, timeout, id);
  }

  showNotification(request) {
    const { dismiss } = mountExtensionNotification(document, request);
    setTimeout(dismiss, 30_000);
  }

  showDialog(dialogElement, timeout, requestId) {
    this.currentDialog = dialogElement;
    this.currentRequestId = requestId;
    const title = dialogElement.querySelector('.dialog-title');
    if (title) {
      title.id = `dialog-title-${requestId}`;
      dialogElement.setAttribute('aria-labelledby', title.id);
    }
    dialogElement.setAttribute('role', 'dialog');
    dialogElement.setAttribute('aria-modal', 'true');
    this.container.innerHTML = '';
    this.container.appendChild(dialogElement);
    this.container.classList.remove('hidden');
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.container.addEventListener('click', this.handleBackdropClick);
    dialogElement.querySelector('input, textarea, [tabindex="0"], button')?.focus();

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true });
      }, timeout);
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.container.removeEventListener('click', this.handleBackdropClick);
    
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
    this.currentDialog = null;
    this.currentRequestId = null;
  }

  dismissCurrentDialog(notifyServer = false) {
    const id = this.currentRequestId;
    this.clearCurrentDialog();
    if (notifyServer && id) this.sendResponse(id, { cancelled: true });
  }

  cancel(id) {
    if (id === this.currentRequestId) this.clearCurrentDialog();
  }

  isActive() {
    return this.currentRequestId !== null;
  }

  respond(id, response) {
    if (id !== this.currentRequestId) return;
    this.clearCurrentDialog();
    this.sendResponse(id, response);
  }

  sendResponse(id, response) {
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      ...response
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
