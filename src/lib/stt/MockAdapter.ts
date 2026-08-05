import type { STTAdapter, Utterance } from './STTAdapter';

const SCRIPT: Array<{ speakerId: string; text: string; delayMs: number }> = [
  { speakerId: 'mock-1', text: 'Good morning everyone, thanks for joining the standup today.', delayMs: 1000 },
  { speakerId: 'mock-2', text: 'Morning! I finished the API refactor yesterday, tests are passing.', delayMs: 4000 },
  { speakerId: 'mock-1', text: 'Great work on that. Any blockers from your side?', delayMs: 7000 },
  { speakerId: 'mock-3', text: 'I need some input on the new design system colors for the dashboard.', delayMs: 10000 },
  { speakerId: 'mock-2', text: 'I think we should go with the blue palette we discussed last week in the design review meeting.', delayMs: 13000 },
  { speakerId: 'mock-3', text: 'The blue palette looks good but we also need to check the contrast ratios for accessibility standards.', delayMs: 17000 },
  { speakerId: 'mock-1', text: 'Good point about accessibility. Let me share the contrast checker tool we used for the previous project.', delayMs: 21000 },
  { speakerId: 'mock-4', text: 'I have been working on the deployment pipeline and fixed the staging environment issues with the database connection.', delayMs: 25000 },
  { speakerId: 'mock-2', text: 'Speaking of deployment, we should finalise the roadmap for the next quarter release cycle.', delayMs: 29000 },
  { speakerId: 'mock-1', text: 'Absolutely, the roadmap priority should be performance improvements and the new onboarding flow for new users.', delayMs: 33000 },
  { speakerId: 'mock-3', text: 'I think the roadmap planning needs to include the mobile responsive design updates we have been putting off for too long now.', delayMs: 37000 },
  { speakerId: 'mock-4', text: 'The database optimisation project is almost complete and we should see much better query performance across all services.', delayMs: 41000 },
  { speakerId: 'mock-1', text: 'Excellent progress everyone. Let me check if there are any other updates before we wrap up the standup meeting.', delayMs: 45000 },
  { speakerId: 'mock-2', text: 'I think we should consider adding monitoring alerts for the new services we are deploying this quarter.', delayMs: 49000 },
  { speakerId: 'mock-3', text: 'Monitoring alerts would be very helpful for catching issues early in the development cycle before they reach production systems.', delayMs: 53000 },
  { speakerId: 'mock-4', text: 'I can set up the monitoring dashboard this afternoon if we decide on the metrics we want to track and measure.', delayMs: 57000 },
  { speakerId: 'mock-1', text: 'Perfect, let me assign that task and we can review the dashboard setup at our next meeting on Thursday.', delayMs: 61000 },
  { speakerId: 'mock-2', text: 'I agree that Thursday is a good day for the review meeting to discuss the monitoring dashboard progress and next steps.', delayMs: 65000 },
];

export class MockAdapter implements STTAdapter {
  onUtterance?: (utterance: Utterance) => void;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const line of SCRIPT) {
      const timer = setTimeout(() => {
        if (!this.running) return;
        this.onUtterance?.({
          speakerId: line.speakerId,
          text: line.text,
          timestamp: Date.now(),
          isFinal: true,
        });
      }, line.delayMs);
      this.timers.push(timer);
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}