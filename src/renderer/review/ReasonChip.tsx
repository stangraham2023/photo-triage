import type { Reason } from '../../core/types.ts';

const TONE: Record<string, string> = {
  blur: 'chip-blur',
  'eyes-closed': 'chip-eyes',
  exposure: 'chip-exposure',
  duplicate: 'chip-duplicate',
};

/**
 * Renders `reason.detail` verbatim. That string is already written for humans
 * by verdict.ts and carries the score and threshold; rewriting it here would
 * let the UI and the CSV report drift apart.
 */
export function ReasonChip({ reason }: { reason: Reason }) {
  return <span className={`chip ${TONE[reason.code] ?? ''}`}>{reason.detail}</span>;
}
