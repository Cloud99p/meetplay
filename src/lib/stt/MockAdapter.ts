import type { STTAdapter, Utterance } from './STTAdapter';

// Deterministic fake STT for the buildathon demo.
//
// The script deliberately exercises all three games:
//  - Quotable lines -> Who Said That (e.g. the beta/wishlist/align lines)
//  - Repeated target words -> Word Count Bet ('roadmap'/'roadmaps'/'roadmapping',
//    'deadline', 'sync')
//  - A variety of common words -> Scrabble pool
//
// The script loops with small variations so rounds keep generating content.
// Speaker identities: the local participant's own id is used for the first
// speaker, plus synthetic ids for the rest (so the UI shows multiple people).

interface ScriptLine {
  text: string;
  delayMs: number;
}

const BASE_SCRIPT: ScriptLine[] = [
  { text: 'Good morning everyone, thanks for joining the standup today.', delayMs: 1000 },
  { text: 'Morning! I finished the API refactor yesterday, tests are passing.', delayMs: 4000 },
  { text: 'Great work on that. Any blockers from your side?', delayMs: 7000 },
  { text: 'I need some input on the new design system colors for the dashboard.', delayMs: 10000 },
  { text: 'I think we should ship the beta by Friday.', delayMs: 13000 },
  { text: 'The roadmap is not a wishlist, it is a commitment.', delayMs: 17000 },
  { text: 'Let us align on the deliverables before we scale the roadmap.', delayMs: 21000 },
  { text: 'The blue palette looks good but we also need to check the contrast ratios for accessibility standards.', delayMs: 25000 },
  { text: 'I have been working on the deployment pipeline and fixed the staging environment issues with the database connection.', delayMs: 29000 },
  { text: 'Speaking of deployment, we should finalise the roadmap for the next quarter release cycle.', delayMs: 33000 },
  { text: 'Absolutely, the roadmap priority should be performance improvements and the new onboarding flow for new users.', delayMs: 37000 },
  { text: 'I think the roadmap planning needs to include the mobile responsive design updates we have been putting off for too long now.', delayMs: 41000 },
  { text: 'The database optimisation project is almost complete and we should see much better query performance across all services.', delayMs: 45000 },
  { text: 'We have a hard deadline next Tuesday, so please keep the sync short today.', delayMs: 49000 },
  { text: 'I can set up the monitoring dashboard this afternoon if we decide on the metrics we want to track and measure.', delayMs: 53000 },
  { text: 'Perfect, let me assign that task and we can review the dashboard setup at our next meeting on Thursday.', delayMs: 57000 },
  { text: 'I agree that Thursday is a good day for the review meeting to discuss the monitoring dashboard progress and next steps.', delayMs: 61000 },
  { text: 'Let me send the roadmapping document around so everyone can comment on the quarter plan.', delayMs: 65000 },
];

// Small variations appended on each loop so content keeps evolving.
const LOOP_VARIANTS: string[][] = [
  ['Any updates on the roadmaps we reviewed last sprint?', 'The sync with marketing went well.', 'I think the deadline is achievable if we focus.', 'Let us wrap up and I will share the notes.'],
  ['Can we revisit the roadmap priorities after lunch?', 'I will schedule a sync for tomorrow morning.', 'The beta launch date is the main deadline now.', 'Thanks everyone, great meeting.'],
  ['The roadmap still needs the accessibility items added.', 'Our roadmaps overlap with the platform team.', 'I will update the deadline tracker after this.', 'Good discussion, let us action these items.'],
];

const MOCK_SPEAKERS = ['mock-2', 'mock-3', 'mock-4'];

export class MockAdapter implements STTAdapter {
  onUtterance?: (utterance: Utterance) => void;
  /** Local participant id — used as the first speaker so captions feel personal. */
  localSpeakerId: string;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private loop = 0;

  constructor(localSpeakerId?: string) {
    this.localSpeakerId = localSpeakerId ?? 'mock-1';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleLoop();
  }

  private scheduleLoop(): void {
    if (!this.running) return;
    const script = [...BASE_SCRIPT];
    const variant = LOOP_VARIANTS[this.loop % LOOP_VARIANTS.length];
    // Interleave variant lines through the base script on later loops
    if (this.loop > 0) {
      variant.forEach((text, i) => {
        const insertAt = Math.min(script.length - 1, 4 + i * 4);
        script.splice(insertAt, 0, { text, delayMs: 1000 + i * 1500 });
      });
    }
    this.loop++;

    // Speaker rotation: local id first, then synthetic ids
    script.forEach((line, index) => {
      const speakerId = index === 0 ? this.localSpeakerId : MOCK_SPEAKERS[(index - 1) % MOCK_SPEAKERS.length];
      const timer = setTimeout(() => {
        if (!this.running) return;
        this.onUtterance?.({
          speakerId,
          text: line.text,
          timestamp: Date.now(),
          isFinal: true,
        });
      }, line.delayMs);
      this.timers.push(timer);
    });

    // Schedule the next loop after the base script finishes (~70s), with jitter
    const nextLoopDelay = 70000 + Math.floor(Math.random() * 5000);
    const loopTimer = setTimeout(() => this.scheduleLoop(), nextLoopDelay);
    this.timers.push(loopTimer);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
