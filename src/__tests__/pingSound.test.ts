import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * pingSound caches a single AudioContext in a module-level variable. To test it in
 * isolation we install a mock on window.AudioContext, then vi.resetModules() + dynamic
 * import so each test gets a fresh module whose cache starts empty and reads our mock.
 */

function makeMockAudioContext(state: 'running' | 'suspended' = 'running') {
  const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const ctx = {
    state,
    currentTime: 0,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(function createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(function connect() { return { connect: vi.fn() }; }),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn(function createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(function connect() { return { connect: vi.fn() }; }),
      };
    }),
  };
  return { ctx, oscillators };
}

async function loadPingSound() {
  vi.resetModules();
  return import('../services/pingSound');
}

describe('pingSound.playAttentionPing', () => {
  const originalAudioContext = (window as { AudioContext?: unknown }).AudioContext;
  const originalWebkit = (window as { webkitAudioContext?: unknown }).webkitAudioContext;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (window as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    (window as { webkitAudioContext?: unknown }).webkitAudioContext = originalWebkit;
  });

  it('schedules two oscillators when Web Audio is available', async () => {
    const { ctx, oscillators } = makeMockAudioContext();
    (window as { AudioContext?: unknown }).AudioContext = function AudioContext() { return ctx; };

    const { playAttentionPing } = await loadPingSound();
    playAttentionPing();

    expect(oscillators.length).toBe(2);
    expect(oscillators[0].start).toHaveBeenCalled();
    expect(oscillators[1].start).toHaveBeenCalled();
  });

  it('resumes a suspended context before scheduling', async () => {
    const { ctx } = makeMockAudioContext('suspended');
    (window as { AudioContext?: unknown }).AudioContext = function AudioContext() { return ctx; };

    const { playAttentionPing } = await loadPingSound();
    playAttentionPing();

    expect(ctx.resume).toHaveBeenCalled();
  });

  it('does not throw when Web Audio is unavailable', async () => {
    (window as { AudioContext?: unknown }).AudioContext = undefined;
    (window as { webkitAudioContext?: unknown }).webkitAudioContext = undefined;

    const { playAttentionPing } = await loadPingSound();
    expect(() => playAttentionPing()).not.toThrow();
  });

  it('does not throw when the AudioContext constructor throws', async () => {
    (window as { AudioContext?: unknown }).AudioContext = function AudioContext() { throw new Error('no audio'); };

    const { playAttentionPing } = await loadPingSound();
    expect(() => playAttentionPing()).not.toThrow();
  });
});
