import { useEffect, useRef, useState, useCallback } from 'react';
import { WebSocketClient } from '../lib/websocket';

let sharedClient: WebSocketClient | null = null;

function getClient(): WebSocketClient {
  if (!sharedClient) sharedClient = new WebSocketClient();
  return sharedClient;
}

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const clientRef = useRef(getClient());

  useEffect(() => {
    const c = clientRef.current;
    const unsub1 = c.on('_connected', () => setConnected(true));
    const unsub2 = c.on('_disconnected', () => setConnected(false));
    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  const connect = useCallback((roomId: string, participantId: string, token: string) => {
    const c = clientRef.current;
    c.connect(roomId, participantId, token);
  }, []);

  const disconnect = useCallback(() => {
    const c = clientRef.current;
    c.disconnect();
    setConnected(false);
  }, []);

  const send = useCallback((type: string, payload?: Record<string, unknown>) => {
    clientRef.current.send(type, payload);
  }, []);

  const on = useCallback((type: string, handler: (payload: any) => void): (() => void) => {
    return clientRef.current.on(type, handler);
  }, []);

  return { connected, connect, disconnect, send, on, client: clientRef.current };
}