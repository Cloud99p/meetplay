export interface Room {
  id: string;
  name: string | null;
  hasPassword: boolean;
  transcriptionEnabled: boolean;
  state: 'active' | 'locked' | 'ended';
  participantCount?: number;
  participants?: Participant[];
  createdAt?: string;
}

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  isMuted: boolean;
  joinedAt?: string;
}