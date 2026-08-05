import { WebSocket } from 'ws';
import { encode, type ServerMessage } from './messages.js';

interface RoomChannel {
  participants: Map<string, { ws: WebSocket; participantName: string }>;
}

class ChannelManager {
  private rooms = new Map<string, RoomChannel>();

  getOrCreate(roomId: string): RoomChannel {
    let ch = this.rooms.get(roomId);
    if (!ch) {
      ch = { participants: new Map() };
      this.rooms.set(roomId, ch);
    }
    return ch;
  }

  join(roomId: string, participantId: string, participantName: string, ws: WebSocket): void {
    const ch = this.getOrCreate(roomId);
    ch.participants.set(participantId, { ws, participantName });
    this.broadcast(roomId, {
      type: 'participant:joined',
      payload: { id: participantId, name: participantName },
    }, participantId);
  }

  leave(roomId: string, participantId: string): void {
    const ch = this.rooms.get(roomId);
    if (!ch) return;
    ch.participants.delete(participantId);
    if (ch.participants.size === 0) {
      this.rooms.delete(roomId);
    } else {
      this.broadcast(roomId, {
        type: 'participant:left',
        payload: { id: participantId },
      });
    }
  }

  broadcast(roomId: string, msg: ServerMessage, excludeId?: string): void {
    const ch = this.rooms.get(roomId);
    if (!ch) return;
    const data = encode(msg);
    for (const [pid, entry] of ch.participants) {
      if (pid === excludeId) continue;
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(data);
      }
    }
  }

  sendTo(roomId: string, participantId: string, msg: ServerMessage): void {
    const ch = this.rooms.get(roomId);
    if (!ch) return;
    const entry = ch.participants.get(participantId);
    if (entry && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(encode(msg));
    }
  }

  getParticipantCount(roomId: string): number {
    const ch = this.rooms.get(roomId);
    return ch ? ch.participants.size : 0;
  }

  getParticipantIds(roomId: string): string[] {
    const ch = this.rooms.get(roomId);
    return ch ? Array.from(ch.participants.keys()) : [];
  }

  getSocket(roomId: string, participantId: string): WebSocket | undefined {
    const ch = this.rooms.get(roomId);
    return ch?.participants.get(participantId)?.ws;
  }

  closeRoom(roomId: string): void {
    const ch = this.rooms.get(roomId);
    if (!ch) return;
    for (const entry of ch.participants.values()) {
      if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
        entry.ws.close(1000, 'Room ended');
      }
    }
    this.rooms.delete(roomId);
  }

  removeFromRoom(roomId: string, participantId: string): void {
    const ch = this.rooms.get(roomId);
    if (!ch) return;
    const entry = ch.participants.get(participantId);
    if (entry && (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING)) {
      entry.ws.close(1000, 'Removed from room');
    }
    ch.participants.delete(participantId);
  }
}

export const channelManager = new ChannelManager();