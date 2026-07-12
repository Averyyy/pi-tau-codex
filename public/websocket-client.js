/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

const MUTATION_TOKEN_HEADER = 'X-Tau-Mutation-Token';

export function withMutationToken(init = {}, token) {
  if (!token) throw new Error('No live Tau connection token');
  const headers = new Headers(init.headers);
  headers.set(MUTATION_TOKEN_HEADER, token);
  return { ...init, headers };
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function responseError(response) {
  const error = new Error(response.error || `${response.command || 'WebSocket request'} failed`);
  error.name = 'WebSocketRequestError';
  error.response = response;
  return error;
}

export class WebSocketClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.mutationToken = null;
    this.tokenWaiters = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = 'idle';
  }

  connect() {
    if (this.connectionState === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }
    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.connectionState = 'handshaking';
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        this.handleMessage(JSON.parse(event.data));
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
        socket.close(1002, 'invalid server message');
      }
    };

    socket.onerror = (error) => {
      if (this.ws !== socket) return;
      console.error('[WS] Error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.connectionState = 'closed';
      this.clearConnection(new Error('WebSocket disconnected'));
      this.dispatchEvent(new CustomEvent('disconnected'));

      if (!this.isIntentionallyClosed) this.attemptReconnect();
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = 'closed';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnection(new Error('WebSocket disconnected'));
    if (this.ws) this.ws.close();
  }

  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = 'closed';
    this.clearConnection(new Error('WebSocket reconnecting'));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'force reconnect');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    if (!this.mutationToken) {
      throw new Error('Tau connection token has not arrived');
    }
    this.ws.send(JSON.stringify({ ...data, mutationToken: this.mutationToken }));
    return true;
  }

  request(command, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.connectionState === 'closed'
      || (!this.mutationToken && !['idle', 'connecting', 'handshaking'].includes(this.connectionState))) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }
    const id = String(this.nextRequestId++);

    return new Promise((resolve, reject) => {
      const abort = () => {
        this.deletePending(id);
        reject(abortError());
      };
      this.pending.set(id, {
        command: { ...command, id },
        resolve,
        reject,
        signal,
        abort,
        sent: false,
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.sendPending(id);
    });
  }

  async mutationFetch(input, init = {}) {
    const token = await this.waitForMutationToken(init.signal);
    return fetch(input, withMutationToken(init, token));
  }

  waitForMutationToken(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.mutationToken) return Promise.resolve(this.mutationToken);
    if (!['idle', 'connecting', 'handshaking'].includes(this.connectionState)) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        this.tokenWaiters.delete(waiter);
        reject(abortError());
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.tokenWaiters.add(waiter);
    });
  }

  handleMessage(message) {
    if (message.type === 'connection_hello') {
      if (typeof message.mutationToken !== 'string' || !message.mutationToken) {
        throw new Error('Tau connection hello did not include a mutation token');
      }
      const becameReady = !this.mutationToken;
      this.mutationToken = message.mutationToken;
      this.connectionState = 'open';
      for (const waiter of this.tokenWaiters) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.resolve(this.mutationToken);
      }
      this.tokenWaiters.clear();
      for (const id of this.pending.keys()) this.sendPending(id);
      if (becameReady) this.dispatchEvent(new CustomEvent('connected'));
      return;
    }

    if (message.type === 'response' && Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.deletePending(message.id);
        if (message.success === false) pending.reject(responseError(message));
        else pending.resolve(message);
      }
      return;
    }

    switch (message.type) {
      case 'event':
        this.dispatchEvent(new CustomEvent('rpcEvent', { detail: message.event }));
        break;
      case 'state':
        this.dispatchEvent(new CustomEvent('stateUpdate', { detail: message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('serverError', { detail: message }));
        break;
      case 'session_switch':
        this.dispatchEvent(new CustomEvent('sessionSwitch'));
        break;
      case 'mirror_sync':
        this.dispatchEvent(new CustomEvent('mirrorSync', { detail: message }));
        break;
      case 'response':
        this.dispatchEvent(new CustomEvent('response', { detail: message }));
        break;
      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  }

  sendPending(id) {
    const pending = this.pending.get(id);
    if (!pending || pending.sent || !this.mutationToken) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.deletePending(id);
      pending.reject(new Error('WebSocket is not connected'));
      return;
    }
    pending.sent = true;
    this.ws.send(JSON.stringify({ ...pending.command, mutationToken: this.mutationToken }));
  }

  deletePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.signal?.removeEventListener('abort', pending.abort);
    this.pending.delete(id);
  }

  clearConnection(error) {
    this.mutationToken = null;
    for (const [id, pending] of this.pending) {
      this.deletePending(id);
      pending.reject(error);
    }
    for (const waiter of this.tokenWaiters) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(error);
    }
    this.tokenWaiters.clear();
  }
}
