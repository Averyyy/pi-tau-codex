/**
 * Dialogs - Handles extension UI dialogs
 */

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
    const { message, notifyType } = request;
    
    // Create a temporary notification element
    const notification = document.createElement('div');
    notification.className = 'error-message';
    notification.textContent = `${notifyType === 'error' ? '⚠️' : notifyType === 'warning' ? '⚠️' : 'ℹ️'} ${message}`;
    
    // Add to messages container temporarily
    const messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
      messagesContainer.appendChild(notification);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      
      // Remove after 5 seconds
      setTimeout(() => {
        notification.remove();
      }, 5000);
    }
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
