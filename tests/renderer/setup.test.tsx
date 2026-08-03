import { describe, it, expect } from 'vitest';
import { canStart } from '../../src/renderer/screens/Setup.tsx';

/**
 * The screens themselves are verified by running the app. Only the validation
 * logic is extracted and tested here — adding jsdom and Testing Library for two
 * simple forms is not worth it yet. The review screen will justify that
 * tooling; this one does not.
 */
describe('canStart', () => {
  it('requires all three folders', () => {
    expect(canStart({ source: '/a', staging: '/b', review: '/c' })).toBe(true);
    expect(canStart({ source: '/a', staging: '/b' })).toBe(false);
    expect(canStart({})).toBe(false);
  });

  it('rejects a staging folder identical to the source', () => {
    expect(canStart({ source: '/a', staging: '/a', review: '/c' })).toBe(false);
  });

  it('rejects a review folder identical to the source', () => {
    expect(canStart({ source: '/a', staging: '/b', review: '/a' })).toBe(false);
  });

  it('rejects staging and review pointing at the same place', () => {
    expect(canStart({ source: '/a', staging: '/b', review: '/b' })).toBe(false);
  });
});
