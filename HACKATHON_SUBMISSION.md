# MeetPlay — AI Factory / Native.builder Hackathon Submission

## Project Title
**MeetPlay — Meetings That Play Back** (alt: "MeetPlay: Live Meeting Intelligence + Attention Games")

## The Problem
Remote meetings are passive. Attendees multitask, retention drops, and by the next day
nobody remembers what was actually said. Recording tools capture the meeting but do
nothing to keep people engaged *during* it — and extracting anything useful afterward
still means scrubbing through a video.

## The Target User
Teams that run recurring video meetings and care about participation + recall:
startups, agencies, classrooms, and facilitation-heavy groups. The host gets engagement,
the team gets accountability, and everyone gets a usable record of what happened.

## The Solution
MeetPlay is a functional, deployed video-meeting app that turns the live transcript
into the game layer and the recap:

- **Video conferencing** powered by LiveKit Cloud (real-time media, screen share,
  recording).
- **Live speech-to-text** via Deepgram Flux (nova-3 generation, streaming over a
  server-side proxy — the API key never ships to the browser), with per-turn
  confidence scoring and low-confidence captions flagged/dimmed.
- **Six games generated live from what people actually say:**
  - Who Said That? — quote from the meeting, guess the speaker
  - Letter Tiles — Boggle-style: spell real meeting words from scrambled letters
  - Word Count Bet + Flash WCB — bet on how many times a word gets said
  - Member Word Bets — anyone can open a bet mid-meeting
  - Buzzword Bingo — mark your card as buzzwords get said
- **Player-chosen games** — no random popups: members pick what to play; only Flash
  WCB is automatic, so nobody juggles four timers at once.
- **Meeting Intelligence recap** (Omnilearn graph): auto-generated recap quiz,
  leaderboard, speaker stats, full searchable transcript with one-click **download
  as a text document**.

## How Native.builder Was Used
The application was **started on native.builder**: the conductor agent scaffolded the
initial product — project structure, frontend shell, core meeting flow, and the first
working build (native.builder `conductor-sync` commits, August 5, visible in the
project's git history). From there we refined and iterated the product.

As MeetPlay grew past the scaffold we hit platform limits for this workload — custom
backend services, live WebSocket STT proxying, containerized deployment — so, with
hackathon support confirming external hosting was acceptable (support ticket, Aug 6),
we continued the build in a standard stack deployed on Railway. The native.builder
scaffold remains the foundation the product grew from; the result is the same
AI-native product the builder workflow was used to start.

## External APIs / Tools Used
- **native.builder** — initial application scaffold + conductor agent workflow
- **LiveKit Cloud** — WebRTC video conferencing
- **Deepgram (Flux / nova-3)** — streaming speech-to-text
- **Omnilearn** — LLM meeting-intelligence graph (recap quiz, quotes, recall)
- **Railway** — hosting / deployment (public URL)
- **Fastify + Vite + React** — backend / frontend stack

## Demo Video Script (≤ 3 min)
1. **0:00–0:25** — Open MeetPlay, create a room, share the join link. State the
   problem: passive meetings, no memory.
2. **0:25–1:00** — Talk normally; show live captions appearing with confidence,
   Watch the Word Count Bet market open and Flash WCB pop up. Place a bet.
3. **1:00–1:45** — Start a game from the menu: **Letter Tiles** — spell words from
   the tiles while the timer runs; submit.
4. **1:45–2:15** — End the meeting.
5. **2:15–2:45** — Recap page: recap quiz (generated from what was said), leaderboard,
   full transcript, **Download .txt** — the whole meeting as a document.
6. **2:45–3:00** — Close with the takeaway: engagement during the call, recall after.

## Required Links
- **App URL (public):** https://meetplay-production.up.railway.app
- **Native.builder project URL:** <PASTE NATIVE.BUILDER PROJECT URL>  <!-- TODO: fill native.builder project URL before submission -->
- **Source:** github.com/Cloud99p/meetplay
