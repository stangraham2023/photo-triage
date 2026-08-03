import { describe, it, expect } from 'vitest';
import { CHANNELS } from '../../src/shared/contract.ts';

describe('IPC contract', () => {
  it('namespaces every channel so they cannot collide with face worker channels', () => {
    for (const name of Object.values(CHANNELS)) {
      expect(name.startsWith('triage:')).toBe(true);
    }
  });

  it('exposes exactly the four channels the renderer needs', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual(['cancelRun', 'pickFolder', 'progress', 'startRun']);
  });
});
