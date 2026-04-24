// ═══════════════════════════════════════════════
// ScreenSync — WebSocket Signaling Client
// ═══════════════════════════════════════════════

class SignalingClient {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    this._handlers = new Map();
    this._reconnectAttempts = 0;
    this._maxReconnects = 3;
    this._reconnectDelays = [1000, 2000, 4000];
    this._autoReconnect = true;
    this._url = '';
    this._pendingMessages = [];

    // Public event callbacks
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
  }

  /**
   * Connect to the signaling server.
   * @param {string} url WebSocket URL
   * @returns {Promise<void>}
   */
  connect(url) {
    this._url = url;
    this._autoReconnect = true;
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        console.log('[Signaling] Connected');
        this._reconnectAttempts = 0;

        // Flush pending messages
        while (this._pendingMessages.length > 0) {
          const msg = this._pendingMessages.shift();
          this.ws.send(msg);
        }

        if (this.onOpen) this.onOpen();
        resolve();
      };

      this.ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          console.warn('[Signaling] Non-JSON message received');
          return;
        }
        const handler = this._handlers.get(msg.type);
        if (handler) {
          handler(msg);
        } else {
          console.log('[Signaling] Unhandled message type:', msg.type, msg);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[Signaling] Disconnected', event.code, event.reason);
        if (this.onClose) this.onClose(event);

        if (this._autoReconnect && this._reconnectAttempts < this._maxReconnects) {
          const delay = this._reconnectDelays[this._reconnectAttempts] || 4000;
          console.log(`[Signaling] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts + 1}/${this._maxReconnects})`);
          this._reconnectAttempts++;
          setTimeout(() => {
            this.connect(this._url).catch(() => {});
          }, delay);
        }
      };

      this.ws.onerror = (err) => {
        console.error('[Signaling] Error:', err);
        if (this.onError) this.onError(err);
        reject(err);
      };
    });
  }

  /**
   * Send a message through the WebSocket.
   * @param {string} type  Message type
   * @param {object} payload  Additional fields
   */
  send(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      console.warn('[Signaling] Queuing message (not connected):', type);
      this._pendingMessages.push(data);
    }
  }

  /**
   * Register a handler for a specific message type.
   * @param {string} type
   * @param {function} handler
   */
  on(type, handler) {
    this._handlers.set(type, handler);
  }

  /**
   * Remove handler for a message type.
   * @param {string} type
   */
  off(type) {
    this._handlers.delete(type);
  }

  /**
   * Disconnect and stop auto-reconnect.
   */
  disconnect() {
    this._autoReconnect = false;
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
  }

  /** @returns {boolean} */
  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

// Expose globally
window.SignalingClient = SignalingClient;
