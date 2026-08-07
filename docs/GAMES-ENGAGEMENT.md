# Games & Engagement — Research & Design

Date: 2026-08-07
Status: Design proposal (no code changed yet)

---

## 1. When does the first game currently start?

Today games are **utterance-triggered**, not time-triggered:

| Rule | Value |
|------|-------|
| Minimum utterances in buffer before any round | 8 (`MIN_UTTERANCES_FOR_ROUND`) |
| Cooldown after a round ends | 15s (`ROUND_COOLDOWN_MS`) |
| Round order (cycles) | `who_said_that` → `scrabble` → `word_count_bet` → repeat |
| Round lengths | WST 30s · Scrabble 45s · WCB 60s |
| First round is always | **Who Said That?** (roundCount 0 % 3 = 0) |

**Practical answer:** the first game starts roughly **1–3 minutes into a normal call** (after ~8 transcribed utterances, whichever comes later vs. the 15s cooldown). Word Count Bet doesn't appear until the **3rd round** — so ~4–7 minutes in, and only as a short 60s window. There is no game at all until people talk enough.

This is exactly the gap the redesign fixes: the user's instinct ("Word Count Bet should start at the start of the call") points to a **two-layer game architecture**:

- **Layer A — Always-on passive markets** (start at call start, run the whole call): Word Count Bet v2, Buzzword Bingo, filler-word counter, share-of-voice meter.
- **Layer B — Rotating quick rounds** (fire on a trigger when there's a lull): the existing Who Said That? and Scrabble.

---

## 2. Word Count Bet v2 — "Call-long prediction market"

### Goal
The market opens **as early as possible in the call** and stays open until the meeting ends. The live count ticks up as the word is spoken, and the **odds for every bet shift in real time** as (a) more people place bets and (b) the live count moves.

### Flow
1. **Seeding (call start → ~first minute).** Engine collects utterances. Once a qualifying target word is found (first non-stopword ≥3 chars with ≥2 occurrences — falls back to `selectTargetWord`), the market **opens permanently**. If the room was created with a title, we seed from it for an instant open. (If no word yet, show "Market opening… listening".)
2. **Betting (whole call).** Anyone can place/update a bet anytime. Each bet locks the *current odds* at bet time.
3. **Live odds.** Recompute on every new bet *and* every utterance that contains the word. Broadcast as a lightweight `game:market:update` (throttled to ~1/sec max).
4. **Resolution (room ends / host ends).** Final count = exact total for the whole call (keep an incrementing per-word counter in the engine — don't rely on the 200-item buffer for long calls). Closest guess wins; payout uses the locked odds.

### Odds math (prediction-market style)
- Live count `c(t)`, bets `B = {g₁…gₙ}`.
- Closeness weight per bet: `wᵢ = 1 / (1 + |gᵢ − c(t)|)` (optional softer variant: `exp(−λ·|gᵢ − c(t)|)`, λ ≈ 0.15).
- Implied probability `pᵢ = wᵢ / Σwⱼ` → displayed odds `= 1/pᵢ` (e.g. **×3.2**).
- A new vote on a number pushes that number's odds down (crowd effect); the live count ticking makes nearby guesses more likely and distant ones drift — exactly the "odds change in real time" drama.

### Payout (reward contrarian accuracy, like a real market)
- `score = calculateBetScore(guess, finalCount) × oddsLockedAtBetTime`, capped (e.g. ×1.0–×5.0 effective multiplier).
- Early correct long-shots pay more than late crowd-followers — creates the "bet early" hook without needing fake money.

### Edge cases
- Nobody bets → no payout, market just dies quietly at room end.
- One participant → still works (their bet vs. live count; odds = 1.0).
- Late joiners → can still bet; par-bet fallback at resolution only for members who joined after the market opened and never bet (reuse existing `assignParBets` logic).
- Host re-open: host can "re-roll" the target word mid-call (closes current market, opens a new one).

---

## 3. Research — engagement games that don't distract

Sources: high5test.com (19 online meeting activities), teambuilding.com (26 virtual meeting games), sessionlab.com (20 games that won't annoy your team), buzzwordbingo.us / buzzwordbingo.net (real-time auto-detecting bingo), bingwow.com 2026 team-building report (gamification effect size g=0.822 for learning), prediction-market mechanics (OddsJam converter, Polymarket pricing model).

**Key finding:** the format that's proven to engage *without* demanding attention is **passive/auto-scored** — the game runs off data already being captured (our STT transcript), the player just glances at a card/counter. External tools (buzzwordbingo.us) have to route audio through the speaker+mic and detect imperfectly; MeetPlay's per-speaker STT transcript is a **structural advantage** — detection is exact, zero audio plumbing.

### Tier 1 — Passive (zero distraction; run in background, glance-only) ✅ recommended
| Game | How it works | Why it fits |
|------|--------------|-------------|
| **Buzzword Bingo** | Each player gets a 5×5 card of common meeting words ("synergy", "action item", "circle back", "Q3", "scope", "asap"…). STT auto-marks squares as words are spoken. First line = win. | Proven format (buzzwordbingo.us/net/app all exist). We auto-detect from clean transcript — better than their mic-echo approach. 1 game per meeting, per-call cards. |
| **Word Count Bet v2** | Section 2 above. | The flagship. |
| **Filler-word counter ("Um-O-Meter")** | Live per-speaker count of "um/uh/like/you know/so". Award: "Most polished speaker" at end. | 100% passive, funny, zero setup. Deepgram diarization gives us per-speaker. |
| **Share-of-voice meter** | Live pie/bar showing % of talk time per speaker. "Balancing award" to the quietest participant who still contributed. | Anti-dominance, gently nudges participation. Pure transcript stats. |
| **End-time market ("Will we finish on time?")** | One-tap bet at call start: meeting ends before/after X minutes. Resolves on room end. | Zero distraction — one click at start, reveal at end. |

### Tier 2 — Glance (light interaction, still transcript-driven)
| Game | How it works |
|------|--------------|
| **Interruption counter** | Detect overlapping speech (two speakers' utterances within ~1s). "Interruption king/queen" award — good-natured. |
| **Sentiment/vibe meter** | Live room sentiment from transcript (positive/neutral/negative). A collective mood ring, not per-player — fuels "the room feels X" moments. |

### Tier 3 — Active (short, opt-in, between agenda items) — already partially built
| Game | How it works | Status |
|------|--------------|--------|
| Who Said That? | 30s quote→speaker quiz from live transcript | ✅ exists |
| Meeting Scrabble | 45s word-building from transcript vocab | ✅ exists |
| **Recap-page quiz** ("did you actually listen?") | Auto-generate 5 questions from the transcript; taken on the recap page after the call | 🔲 new — engagement loop without *any* in-call distraction |

### Distraction-avoidance design principles (adopted)
1. **No popups, no sounds, no forced timers** for Tier 1 games — only a subtle badge that updates in the side panel ("🔔 Bingo: 2 words away!").
2. **Quiet mode already exists** (screen-share = notifications suspended) — keep it; extend to any presenting state.
3. **Answers are 1-tap** (Tier 3) and rounds auto-lock after 30–45s so nobody waits.
4. **One glance = one decision.** Any game needing more than a second of attention goes in the side panel or the recap page, never over the video.
5. **Leaderboard stays in the panel**, never overlaid on shared content.
6. All Tier 1 games are **opt-in to view** — they track in the background even if the panel is closed, so nobody is forced to play.

---

## 4. Suggested build order

1. **Word Count Bet v2** (Layer A market: open-at-start, live odds, odds-locked payout) — the requested feature, biggest engagement lift.
2. **Buzzword Bingo** (auto-marked from transcript) — proven format, easy with the same utterance pipeline.
3. **Um-O-Meter + share-of-voice** — trivial stats layer, one panel.
4. **Recap quiz** — closes the loop, zero in-call cost.
5. Tier 2/3 extras when the pipeline is proven.
