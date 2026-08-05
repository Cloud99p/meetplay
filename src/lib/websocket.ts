import { getServerUrl } from './api';

type MessageHandler = (payload: any) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private pendingQueue: string[] = [];
  private roomId = '';
  private participantId = '';
  private token = '';

  connect(roomId: string, participantId: string, token: string): void {
    this.roomId = roomId;
    this.participantId = participantId;
    this.token = token;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  private doConnect(): void {
    const url = `${getServerUrl().replace(/^http/, 'ws')}/ws?roomId=${encodeURIComponent(this.roomId)}&participantId=${encodeURIComponent(this.participantId)}&token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('[ws] connection error:', e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Flush pending messages
      while (this.pendingQueue.length > 0) {
        const msg = this.pendingQueue.shift();
        if (msg) this.ws?.send(msg);
      }
      this.emit('_connected', {});
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const type: string = data.type;
        const payload = data.payload ?? {};
        this.emit(type, payload);
        // Also emit a generic handler
        this.emit('_message', data);
      } catch {
        // ignore malformed
      }
    };

    this.ws.onclose = (event) => {
      this.emit('_disconnected', { code: event.code });
      this.ws = null;
      if (this.shouldReconnect && event.code !== 1000 && event.code !== 4001) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 8000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect) this.doConnect();
    }, delay);
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    const msg = JSON.stringify({ type, payload });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      // Queue for later
      this.pendingQueue.push(msg);
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, payload: any): void {
    const set = this.handlers.get(type);
    if (set) {
      for (const h of set) {
        try { h(payload); } catch (e) { console.error('[ws] handler error:', e); }
      }
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.handlers.clear();
    this.pendingQueue = [];
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}