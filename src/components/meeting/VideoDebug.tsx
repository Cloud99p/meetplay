/**
 * VideoDebug — a temporary, read-only stats readout for diagnosing picture quality.
 *
 * Rendered only when the URL carries `?debug=video`, so a normal call sees nothing.
 * Strictly non-invasive: it calls `getStats()` and displays numbers. It never touches
 * publish settings, simulcast layers, or subscriptions, so it cannot change the
 * behaviour it is measuring.
 *
 * Why two panels: "my picture is pixelated" has two very different causes.
 *  - OUTBOUND rows describe what we SEND. If `qualityLimitationReason` is
 *    `bandwidth` and kbps sits well under the layer ceiling, our uplink is the
 *    bottleneck.
 *  - INBOUND rows describe what we RECEIVE per remote tile. If we are subscribed
 *    to a layer smaller than the sender publishes, the problem is the receive
 *    path (layer selection / bandwidth adaptation), not the encoder.
 * The second is what matters when the picture of OTHER people degrades.
 *
 * NOTE ON ROUTING: this app uses HashRouter, so the query string lives after the
 * `#` and `window.location.search` would be empty. Read it via useLocation().
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client';

interface Row {
  id: string;
  kind: 'out' | 'in';
  label: string;
  resolution: string;
  fps: number | null;
  kbps: number | null;
  /** Outbound: why the encoder is limiting itself. Inbound: frozen packets. */
  note: string;
}

/** Bytes-per-second delta helper: stats are cumulative counters, so we diff them. */
const prev = new Map<string, { bytes: number; at: number }>();

function kbpsFrom(key: string, bytes: number, at: number): number | null {
  const before = prev.get(key);
  prev.set(key, { bytes, at });
  if (!before) return null;
  const ms = at - before.at;
  if (ms <= 0) return null;
  return ((bytes - before.bytes) * 8) / ms; // bytes/ms*8 === kbit/s
}

async function collect(room: Room): Promise<Row[]> {
  const rows: Row[] = [];
  const now = performance.now();

  // ── outbound: our own camera ────────────────────────────────────────────
  for (const pub of room.localParticipant.trackPublications.values()) {
    const p = pub as LocalTrackPublication;
    if (p.kind !== Track.Kind.Video || !p.track) continue;
    try {
      const report = await p.track.getRTCStatsReport();
      if (!report) continue;
      let res = '—';
      let fps: number | null = null;
      let kbps: number | null = null;
      let note = '';
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          const w = Number(s.frameWidth ?? 0);
          const h = Number(s.frameHeight ?? 0);
          if (w && h) res = `${w}x${h}`;
          if (typeof s.framesPerSecond === 'number') fps = s.framesPerSecond;
          const bytes = Number(s.bytesSent ?? 0);
          if (bytes) kbps = kbpsFrom(`out:${p.trackSid}`, bytes, now);
          const limit = s.qualityLimitationReason;
          if (limit) note = `limitation: ${limit}`;
          if (s.encoderImplementation) note += ` · ${s.encoderImplementation}`;
        }
      });
      rows.push({
        id: `out:${p.trackSid}`,
        kind: 'out',
        label: 'You (camera)',
        resolution: res,
        fps,
        kbps: kbps === null ? null : Math.round(kbps),
        note,
      });
    } catch {
      /* stats are best-effort; a missing report must not break the panel */
    }
  }

  // ── inbound: one row per remote camera we are subscribed to ─────────────
  for (const participant of room.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      const rp = pub as RemoteTrackPublication;
      if (rp.kind !== Track.Kind.Video || !rp.track || rp.isMuted) continue;
      try {
        const report = await rp.track.getRTCStatsReport();
        if (!report) continue;
        let res = '—';
        let fps: number | null = null;
        let kbps: number | null = null;
        let frozen = 0;
        report.forEach((s: Record<string, unknown>) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const w = Number(s.frameWidth ?? 0);
            const h = Number(s.frameHeight ?? 0);
            if (w && h) res = `${w}x${h}`;
            if (typeof s.framesPerSecond === 'number') fps = s.framesPerSecond;
            const bytes = Number(s.bytesReceived ?? 0);
            if (bytes) kbps = kbpsFrom(`in:${rp.trackSid}`, bytes, now);
            frozen = Number(s.freezeCount ?? 0);
          }
        });
        rows.push({
          id: `in:${rp.trackSid}`,
          kind: 'in',
          label: participant.name || participant.identity,
          resolution: res,
          fps,
          kbps: kbps === null ? null : Math.round(kbps),
          note: frozen ? `freezes: ${frozen}` : '',
        });
      } catch {
        /* best-effort */
      }
    }
  }

  return rows;
}

export default function VideoDebug({ room }: { room: Room | null }) {
  const location = useLocation();
  const enabled = new URLSearchParams(location.search).get('debug') === 'video';
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!enabled || !room) return;
    let alive = true;
    const tick = async () => {
      const next = await collect(room);
      if (alive) setRows(next);
    };
    void tick();
    const timer = window.setInterval(tick, 1000);
    // Refresh immediately when someone joins/leaves so rows don't lag by a second.
    const onSub = () => void tick();
    room.on(RoomEvent.TrackSubscribed, onSub);
    room.on(RoomEvent.TrackUnsubscribed, onSub);
    room.on(RoomEvent.LocalTrackPublished, onSub);
    return () => {
      alive = false;
      window.clearInterval(timer);
      room.off(RoomEvent.TrackSubscribed, onSub);
      room.off(RoomEvent.TrackUnsubscribed, onSub);
      room.off(RoomEvent.LocalTrackPublished, onSub);
    };
  }, [enabled, room]);

  if (!enabled) return null;

  return (
    <div className="fixed bottom-2 left-2 z-50 max-w-[22rem] rounded-md border border-border bg-caption-bg p-2 font-mono text-[10px] leading-tight text-foreground backdrop-blur-sm">
      <div className="mb-1 font-semibold">video stats (?debug=video)</div>
      {rows.length === 0 && <div className="opacity-70">waiting for tracks…</div>}
      {rows.map((r) => (
        <div key={r.id} className="mb-1">
          <div className="truncate">
            {r.kind === 'out' ? '↑' : '↓'} {r.label}
          </div>
          <div className="opacity-80">
            {r.resolution} · {r.fps === null ? '—' : `${Math.round(r.fps)}fps`} ·{' '}
            {r.kbps === null ? '—' : `${r.kbps} kbps`}
          </div>
          {r.note && <div className="opacity-60">{r.note}</div>}
        </div>
      ))}
    </div>
  );
}
