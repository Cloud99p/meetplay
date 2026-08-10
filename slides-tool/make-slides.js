const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// ---------- Theme ----------
const COLORS = {
  bgTop: '#12102b',        // deep indigo-black
  bgBottom: '#1b1440',     // purple-tinged
  card: '#241c52',
  cardBorder: '#3a2f6e',
  accent: '#7c5cff',       // bright indigo
  accent2: '#22d3ee',      // cyan for live/STT
  accent3: '#f59e0b',      // amber for games/attn
  pink: '#f472b6',
  green: '#34d399',
  text: '#f4f2ff',
  muted: '#a9a3cf',
  muted2: '#8b84b5',
  white: '#ffffff',
};
const W = 1280, H = 720;
const M = 70; // margin

// ---------- Helpers ----------
// Linear gradient background
function bg(doc) {
  doc.save();
  const g = doc.linearGradient(0, 0, 0, H);
  g.stop(0, COLORS.bgTop);
  g.stop(1, COLORS.bgBottom);
  doc.rect(0, 0, W, H).fill(g);
  doc.restore();
}
// horizontal accent band
function band(doc, y, h, c1, c2) {
  doc.save();
  const g = doc.linearGradient(0, 0, W, 0);
  g.stop(0, c1 || COLORS.accent);
  g.stop(1, c2 || COLORS.accent2);
  doc.rect(0, y, W, h).fill(g);
  doc.restore();
}

function footer(doc, num, total) {
  doc.font('Helvetica').fontSize(11).fillColor(COLORS.muted2);
  doc.text(`MeetPlay — lablab AI Factory · Native.builder Hackathon  ${num} / ${total}`, M, H - 30, { width: W - 2*M, align: 'right' });
}

function titleBadge(doc, label, color, y) {
  doc.roundedRect(M, y, 10, 34, 2).fill(color || COLORS.accent);
  doc.font('Helvetica-Bold').fontSize(30).fillColor(COLORS.text);
  doc.text(label, M + 26, y - 2, { width: W - 2*M - 26 });
}

function kicker(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.accent2).text(text.toUpperCase(), M, y, { characterSpacing: 2 });
}

// Card with title
function card(doc, x, y, w, h, title, titleColor, bodyLines) {
  doc.roundedRect(x, y, w, h, 10).fill(COLORS.card).strokeColor(COLORS.cardBorder).lineWidth(1).stroke();
  doc.roundedRect(x, y, 10, h, 4).fill(titleColor || COLORS.accent);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.white).text(title, x+16, y+12, { width: w-32 });
  let yy = y + 46;
  doc.font('Helvetica').fontSize(13.5).fillColor(COLORS.text);
  for (const line of bodyLines) {
    const parts = splitInline(line);
    yy = drawInline(doc, parts, x+16, yy, { width: w-32 });
    yy += 22;
  }
}

function splitInline(text) {
  // tokens like **bold** and `code`
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: 'n', s: text.slice(last, m.index) });
    parts.push(m[0].startsWith('**') ? { t: 'b', s: m[0].slice(2,-2) } : { t: 'c', s: m[0].slice(1,-1) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: 'n', s: text.slice(last) });
  return parts;
}
function drawInline(doc, parts, x, baseY, { width }) {
  let pen = x;
  for (const p of parts) {
    doc.font(p.t === 'b' ? 'Helvetica-Bold' : (p.t === 'c' ? 'Courier-Bold' : 'Helvetica'));
    doc.fillColor(p.t === 'c' ? COLORS.accent3 : COLORS.text);
    doc.fontSize(p.t === 'c' ? 12.5 : 13.5);
    const w = doc.widthOfString(p.s);
    if (pen + w > x + width) { pen = x; baseY += 21; }
    doc.text(p.s, pen, baseY, { width: w });
    pen += w;
  }
  return baseY;
}

// Chip
function chip(doc, x, y, text, bg, fg) {
  const f = doc.font('Helvetica-Bold').fontSize(12);
  const w = f.widthOfString(text) + 22;
  doc.roundedRect(x, y, w, 26, 13).fill(bg || COLORS.accent);
  doc.fillColor(fg || '#fff').font('Helvetica-Bold').fontSize(12).text(text, x+11, y+7, { width: w-22, align: 'center' });
  return w;
}

function blockTitle(doc, text, y, color) {
  doc.font('Helvetica-Bold').fontSize(22).fillColor(color || COLORS.text);
  doc.text(text, M, y);
}

// ---------- Build ----------
function build() {
  const doc = new PDFDocument({ size: [W, H], margins: { top: 0, left: 0, right: 0, bottom: 0 }, autoFirstPage: false, compress: typeof process.env.NO_COMPRESS !== 'undefined' ? false : true });
  const outPath = path.join(__dirname, '..', 'MeetPlay-Submission-Slides.pdf');
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const slides = [];

  // ========== SLIDE 1 — TITLE ==========
  slides.push((num, total) => {
    bg(doc);
    band(doc, 190, 6);
    band(doc, 214, 6);

    doc.font('Helvetica-Bold').fontSize(26).fillColor(COLORS.accent2).text('lablab AI Factory · Native.builder Hackathon', M, 120, { align: 'center', width: W-2*M });
    doc.font('Helvetica-Bold').fontSize(88).fillColor(COLORS.white).text('MeetPlay', M, 250, { align: 'center', width: W-2*M });
    doc.font('Helvetica-BoldOblique').fontSize(34).fillColor(COLORS.pink).text('Meetings That Play Back', M, 370, { align: 'center', width: W-2*M });
    doc.font('Helvetica-Oblique').fontSize(21).fillColor(COLORS.muted).text(
      'AI engagement for video calls that people actually stay awake for.',
      M, 440, { align: 'center', width: W-2*M });

    // chips row
    let cx = 180;
    const chips = ['Live video', 'Live transcript → live games', 'AI recap'];
    for (const c of chips) { cx += chip(doc, cx, 500, c, COLORS.accent) + 14; }

    doc.font('Helvetica').fontSize(18).fillColor(COLORS.text).text('Cloud99p · hackathon submission', M, 610, { align: 'center', width: W-2*M });
    footer(doc, num, total);
  });

  // ========== SLIDE 2 — PROBLEM ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'The problem', 60);
    blockTitle(doc, 'Remote meetings are passive.', 90);
    doc.font('Helvetica').fontSize(17).fillColor(COLORS.text)
      .text('Attendees multitask, retention drops, and by the next day nobody remembers what was actually said. Recording tools capture the call — but do nothing to keep people engaged during it.', M, 150, { width: W-2*M, lineGap: 8 });

    const stats = [
      { n: 'multitask', t: 'People multitask during video calls — screens lose the fight for attention.' },
      { n: 'no recall', t: 'By the next day, most meeting details are gone.' },
      { n: 'scrubbing', t: '"Summarizing" a recording still means scrubbing a video.' },
    ];
    let y = 280;
    stats.forEach((s, i) => {
      const color = [COLORS.accent3, COLORS.pink, COLORS.accent2][i];
      doc.roundedRect(M, y, 30, 30, 6).fill(color);
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#fff').text(String(i+1), M+12, y+7, { width: 8, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(19).fillColor(COLORS.white).text(s.n, M+46, y-2);
      doc.font('Helvetica').fontSize(14.5).fillColor(COLORS.muted).text(s.t, M+46, y+28, { width: W-2*M-46 });
      y += 96;
    });
    footer(doc, num, total);
  });

  // ========== SLIDE 3 — SOLUTION ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'The solution', 60);
    blockTitle(doc, 'Games born from the live transcript — in real time.', 90);
    doc.font('Helvetica').fontSize(17).fillColor(COLORS.text)
      .text('MeetPlay is a functional, deployed video-meeting app. As people talk, it turns their words into opt-in attention games and an AI recap. Play = pay attention.', M, 160, { width: W-2*M, lineGap: 8 });

    const cols = [
      { t: 'Engage during', c: COLORS.accent, b: 'Opt-in games that are a natural byproduct of listening — never a distraction.' },
      { t: 'Recall after', c: COLORS.pink, b: 'AI recap quiz, speaker stats, leaderboard, and a full searchable transcript.' },
      { t: 'Privacy first', c: COLORS.green, b: 'Transcription is opt-in per meeting; transcripts are deleted when it ends.' },
    ];
    const cw = (W - 2*M) / 3, gap = 16;
    cols.forEach((c, i) => {
      const x = M + i*(cw+gap);
      card(doc, x, 290, cw-gap, 300, c.t, c.c, [c.b]);
    });
    footer(doc, num, total);
  });

  // ========== SLIDE 4 — THE GAMES ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'The games', 60);
    blockTitle(doc, 'Six attention games + stats + recap', 90);
    const games = [
      ['Who Said That?', 'Quote from the meeting — guess the speaker', COLORS.pink],
      ['Meeting Scrabble', 'Spell words you actually said from scrambled tiles', COLORS.accent],
      ['Word Count Bet', '+ Flash — bet how many times a word gets said', COLORS.accent3],
      ['Member Word Bets', 'Anyone opens a bet mid-meeting', COLORS.accent2],
      ['Buzzword Bingo', 'Mark your card as buzzwords get said', COLORS.green],
      ['Recap + Stats', 'Leaderboard, speaker stats, recap quiz', COLORS.accent],
    ];
    const perRow = 2, cw = (W - 2*M - 20) / 2, chh = 180;
    games.forEach((g, i) => {
      const r = Math.floor(i/perRow), c = i%perRow;
      const x = M + c*(cw+20), y = 165 + r*(chh+20);
      doc.roundedRect(x, y, cw, chh, 12).fill(COLORS.card).strokeColor(COLORS.cardBorder).lineWidth(1).stroke();
      doc.roundedRect(x, y, 8, chh, 4).fill(g[2]);
      doc.font('Helvetica-Bold').fontSize(23).fillColor(COLORS.white).text(g[0], x+28, y+22, { width: cw-56 });
      doc.font('Helvetica').fontSize(14.5).fillColor(COLORS.muted).text(g[1], x+28, y+60, { width: cw-56 });
    });
    doc.font('Helvetica-Oblique').fontSize(13).fillColor(COLORS.muted2)
      .text('Player-chosen games — no random popups. Only Flash WCB is automatic, so nobody juggles four timers at once.', M, 648, { width: W-2*M });
    footer(doc, num, total);
  });

  // ========== SLIDE 5 — HOW IT WORKS (architecture) ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'How it works', 60);
    blockTitle(doc, 'Spoken word → live games → recap', 90);

    // Pipeline boxes
    const stages = [
      ['Browser mic', 'captures your voice', COLORS.accent],
      ['STT adapter', 'Deepgram · WebSpeech · Mock', COLORS.accent2],
      ['WebSocket captions', 'transcript events', COLORS.pink],
      ['Game engine', 'market · bingo · stats · quiz', COLORS.accent3],
      ['Recap', 'quiz + leaderboard + download', COLORS.green],
    ];
    const bw = 200, bgap = 14;
    stages.forEach((s, i) => {
      const x = M + i*(bw+bgap);
      doc.roundedRect(x, 155, bw, 106, 12).fill(COLORS.card).strokeColor(COLORS.cardBorder).lineWidth(1).stroke();
      doc.roundedRect(x, 155, bw, 6, 3).fill(s[2]);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.white).text(s[0], x+14, 178, { width: bw-28, align: 'center' });
      doc.font('Helvetica').fontSize(11.5).fillColor(COLORS.muted).text(s[1], x+14, 212, { width: bw-28, align: 'center' });
      if (i < stages.length-1) {
        doc.font('Helvetica-Bold').fontSize(26).fillColor(COLORS.accent).text('→', x+bw-4, 174, { width: 24, align: 'center' });
      }
    });

    // Two support cards
    const cw = (W - 2*M - 20)/2;
    card(doc, M, 330, cw, 240, 'Omnilearn knowledge graph', COLORS.pink, [
      'One knowledge layer, many products.',
      'Stores quotes + meeting intelligence for',
      'Who-Said-That and the recap quiz.',
      'Batched, idempotent, fire-and-forget; falls',
      'back to an in-memory buffer if unreachable.',
      'Privacy-purged when the meeting ends.',
    ]);
    card(doc, M+cw+20, 330, cw, 240, 'LiveKit Cloud media', COLORS.accent2, [
      'Open-source SFU (Selective Forwarding Unit)',
      'scales to 20–50+ participants.',
      'Real-time audio/video + screen share.',
      'LiveKit handles media only — games run',
      'over the same WebSocket as chat + captions.',
      'Degrades to text mode if media is down.',
    ]);
    footer(doc, num, total);
  });

  // ========== SLIDE 6 — TECH STACK ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'Tech stack', 60);
    blockTitle(doc, 'A pragmatic, real-time web stack', 90);
    const stack = [
      ['Frontend', 'Vite + React + React Router', COLORS.accent],
      ['Backend', 'Fastify (serves SPA + REST)', COLORS.accent2],
      ['Realtime', 'WebSocket hub for chat, captions, games', COLORS.pink],
      ['Media', 'LiveKit Cloud (WebRTC SFU)', COLORS.accent3],
      ['Speech-to-text', 'Deepgram (nova-2 / flux) via server proxy', COLORS.green],
      ['Meeting intelligence', 'Omnilearn knowledge-graph SDK', COLORS.green],
      ['Hosting', 'Railway — meetplay-production.up.railway.app', COLORS.accent3],
      ['Data', 'Postgres / in-memory DB (dev default)', COLORS.accent2],
    ];
    const perRow = 2, cw = (W - 2*M - 28)/2, chh = 122;
    stack.forEach((s, i) => {
      const r = Math.floor(i/perRow), c = i%perRow;
      const x = M + c*(cw+28), y = 165 + r*(chh+18);
      doc.roundedRect(x, y, cw, chh, 12).fill(COLORS.card).strokeColor(COLORS.cardBorder).lineWidth(1).stroke();
      if (r === 0) doc.roundedRect(x, y+4, cw, 3, 1).fill(s[2]);
      doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.white).text(s[0], x+20, y+16, { width: cw-40 });
      doc.font('Helvetica').fontSize(14).fillColor(COLORS.muted).text(s[1], x+20, y+52, { width: cw-40 });
      // dot
      doc.circle(x+22, y+46, 5).fill(s[2]);
    });
    footer(doc, num, total);
  });

  // ========== SLIDE 7 — LIVE TRANSCRIPT PIPELINE ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'Live transcript pipeline', 60);
    blockTitle(doc, 'One STTAdapter contract, three backends', 90);
    doc.font('Helvetica').fontSize(15.5).fillColor(COLORS.muted)
      .text('Every adapter emits the same shape — { speakerId, text, isFinal, timestamp, confidence } — so captions and games work identically in every mode. The key never ships to the browser.', M, 140, { width: W-2*M, lineGap: 8 });

    const rows = [
      ['MockAdapter', 'zero config, deterministic script, synthetic speakers', 'Demos · zero-config local dev', COLORS.accent],
      ['WebSpeechAdapter', 'free browser-native STT, single speaker', 'Free captions (no diarization)', COLORS.accent2],
      ['DeepgramAdapter', 'streaming + diarized via /api/stt server proxy; nova-2 = diarized multi-speaker (Who-Said-That), flux = ultra-low-latency turn-based', 'Production · powers all games', COLORS.green],
    ];
    let y = 210;
    rows.forEach((r) => {
      doc.roundedRect(M, y, 10, 74, 3).fill(r[3]);
      doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.white).text(r[0], M+26, y+10);
      doc.font('Helvetica').fontSize(13).fillColor(COLORS.muted).text(r[1], M+26, y+40, { width: 860 });
      doc.font('Helvetica-Bold').fontSize(12.5).fillColor(r[3]).text(r[2], 990, y+10, { width: 210, align: 'right' });
      y += 92;
    });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.accent3).text(
      'Server-side proxy: browser mic → your server → Deepgram. The API key stays on the server.', M, 520, { width: W-2*M });
    doc.font('Helvetica').fontSize(13.5).fillColor(COLORS.muted2)
      .text('Deepgram cold start can take ~13s on a fresh session — the server buffers audio until the upstream opens, so real calls self-heal.', M, 556, { width: W-2*M });
    footer(doc, num, total);
  });

  // ========== SLIDE 8 — OMNILEARN ==========
  slides.push((num, total) => {
    bg(doc);
    band(doc, 0, 8, COLORS.accent, COLORS.pink);
    kicker(doc, 'Meeting intelligence', 70);
    blockTitle(doc, 'Omnilearn knowledge graph', 100);
    doc.font('Helvetica').fontSize(17).fillColor(COLORS.text)
      .text('Omnilearn is one knowledge layer that powers many products. MeetPlay records each utterance into the graph and reads it back for Who-Said-That quotes and the recap quiz.', M, 170, { width: W-2*M, lineGap: 8 });

    const items = [
      ['One graph, many products', 'The same meeting intelligence layer is reused across the whole Cloud99p ecosystem.'],
      ['Quotes stored, answers served', 'Speakers, content words, and timing feed Who-Said-That and the auto-generated recap quiz.'],
      ['Privacy purge on meeting end', 'Transcripts and quotes are removed when the meeting ends — opt-in consent, private by default.'],
      ['Published SDK', 'Delivered as @cloud99p/omnilearn-sdk for clean, reusable integration.'],
    ];
    let y = 300;
    items.forEach((it) => {
      doc.roundedRect(M, y, 10, 70, 3).fill(COLORS.pink);
      doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.white).text(it[0], M+26, y+6);
      doc.font('Helvetica').fontSize(13.5).fillColor(COLORS.muted).text(it[1], M+26, y+36, { width: W-2*M-40 });
      y += 92;
    });
    footer(doc, num, total);
  });

  // ========== SLIDE 9 — RESILIENCE & PROD ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'Resilience & production-readiness', 60);
    blockTitle(doc, 'Built to survive real calls', 90);
    const fault = [
      ['STT keepalives + watchdog + auto-reconnect', 'Idle sessions stay alive; dead / half-open connections are detected and restarted with backoff.', COLORS.accent2],
      ['LiveKit retry / reconnect', 'IPv4-aware TCP probe reports availability; the app degrades to text mode (chat + games) if media is down.', COLORS.accent],
      ['Security audit', '5 vulns found & fixed: recap/messages auth, password lockout (5 → 15-min block), production JWT guard, locked-down CORS, 24h cleanup job.', COLORS.pink],
      ['Production key guard', 'No secrets in the repo; the server refuses to boot in production without JWT_SECRET; STT key stays server-side.', COLORS.green],
      ['1080p recording simulcast', 'LiveKit Egress MP4 the user can’t see internally — a hidden robustness layer.', COLORS.accent3],
    ];
    let y = 168;
    fault.forEach((f) => {
      doc.roundedRect(M, y, 8, 62, 3).fill(f[2]);
      doc.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.white).text(f[0], M+24, y+6);
      doc.font('Helvetica').fontSize(13).fillColor(COLORS.muted).text(f[1], M+24, y+32, { width: W-2*M-48 });
      y += 80;
    });
    footer(doc, num, total);
  });

  // ========== SLIDE 10 — LIVE DEMO ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, 'Live demo', 60);
    blockTitle(doc, 'Try it right now', 90);
    // URL card
    doc.roundedRect(M, 170, W-2*M, 90, 14).fill(COLORS.accent).fillOpacity(0.12).strokeColor(COLORS.accent).lineWidth(1.5).stroke();
    doc.fillOpacity(1);
    doc.font('Helvetica-Bold').fontSize(34).fillColor(COLORS.accent2).text('https://meetplay-production.up.railway.app', 0, 196, { align: 'center', width: W });

    const steps = [
      ['Create a room', 'Share the join link.'],
      ['Enable captions & games', 'Consent banner → live captions stream.'],
      ['Just talk', 'Watch bet markets open and Flash WCB pop up.'],
      ['Pick a game', 'Who Said That, Scrabble, Bingo from the menu.'],
      ['End the meeting', 'Recap quiz, leaderboard, full transcript.'],
      ['Download .txt', 'The whole meeting as a document.'],
    ];
    let y = 320;
    steps.forEach((s, i) => {
      const color = [COLORS.accent,COLORS.accent2,COLORS.pink,COLORS.accent3,COLORS.green,COLORS.accent][i];
      doc.circle(M+20, y+18, 14).fill(color);
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#fff').text(String(i+1), M+15, y+12, { width: 10, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.white).text(s[0], M+48, y);
      doc.font('Helvetica').fontSize(13.5).fillColor(COLORS.muted).text(s[1], 500, y+2, { width: 660 });
      y += 52;
    });
    footer(doc, num, total);
  });

  // ========== SLIDE 11 — ROADMAP ==========
  slides.push((num, total) => {
    bg(doc);
    kicker(doc, "What's next", 60);
    blockTitle(doc, 'Roadmap', 90);
    const now = [
      ['SSE live feed', 'Real-time updates without a WebSocket handshake for lighter clients.'],
      ['TF-IDF word suggestion', 'Smarter word-choice for Word Count bets from the transcript.'],
      ['Omnilearn on Railway', 'Deploy the knowledge graph alongside MeetPlay for a fully managed stack.'],
      ['More game types', 'New attention games on top of the same live-transcript engine.'],
    ];
    doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.accent2).text('NEAR-TERM', M, 150);
    let y = 178;
    now.forEach((it) => {
      doc.roundedRect(M, y, W-2*M, 62, 10).fill(COLORS.card).strokeColor(COLORS.cardBorder).lineWidth(1).stroke();
      doc.circle(M+24, y+31, 6).fill(COLORS.accent);
      doc.font('Helvetica-Bold').fontSize(16.5).fillColor(COLORS.white).text(it[0], M+46, y+8);
      doc.font('Helvetica').fontSize(13).fillColor(COLORS.muted).text(it[1], M+46, y+32, { width: W-2*M-70 });
      y += 76;
    });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.pink).text('STRETCH', M, y+6);
    doc.font('Helvetica').fontSize(14).fillColor(COLORS.muted).text(
      'In-app playback player · team / SSO accounts · engagement analytics · PWA · monetization tiers', M, y+34, { width: W-2*M });
    footer(doc, num, total);
  });

  // ========== SLIDE 12 — THANK YOU ==========
  slides.push((num, total) => {
    bg(doc);
    band(doc, 250, 6);
    band(doc, 274, 6, COLORS.pink, COLORS.accent3);

    doc.font('Helvetica-Bold').fontSize(72).fillColor(COLORS.white).text('Thank you', M, 310, { align: 'center', width: W-2*M });
    doc.font('Helvetica').fontSize(22).fillColor(COLORS.muted).text(
      'MeetPlay — engagement during the call, recall after.', M, 420, { align: 'center', width: W-2*M });
    doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.accent2).text(
      'github.com/Cloud99p/meetplay', M, 480, { align: 'center', width: W-2*M });
    doc.font('Helvetica').fontSize(16).fillColor(COLORS.muted).text(
      'Cloud99p · lablab AI Factory — Native.builder Hackathon', M, 530, { align: 'center', width: W-2*M });
    footer(doc, num, total);
  });

  const total = slides.length;
  slides.forEach((fn, i) => {
    doc.addPage();
    fn(i+1, total);
  });

  doc.end();
  stream.on('finish', () => console.log('PDF written:', outPath, fs.statSync(outPath).size, 'bytes'));
  stream.on('error', (e) => { console.error('write error', e); process.exit(1); });
}

build();
