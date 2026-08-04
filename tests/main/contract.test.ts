import { describe, it, expect } from 'vitest';
import { CHANNELS } from '../../src/shared/contract.ts';

describe('IPC contract', () => {
  it('namespaces every channel so they cannot collide with face worker channels', () => {
    for (const name of Object.values(CHANNELS)) {
      expect(name.startsWith('triage:')).toBe(true);
    }
  });

  it('exposes exactly the channels the renderer needs', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual([
      'applyDecisions', 'cancelRun', 'pickFolder', 'progress', 'startAnalysis',
    ]);
  });

  it('keeps analysis and apply as separate channels', () => {
    // If these ever merged, analysis would regain the authority to write, and
    // the review gate would be decorative.
    expect(CHANNELS.startAnalysis).not.toBe(CHANNELS.applyDecisions);
  });
});
