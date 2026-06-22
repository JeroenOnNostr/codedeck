import { describe, it, expect } from 'vitest';
import { sessionNeedsAttention } from '../utils/sessionNeedsAttention';

describe('sessionNeedsAttention', () => {
  it('flags sessions blocked on the user, regardless of unread', () => {
    expect(sessionNeedsAttention('waiting_permission', false)).toBe(true);
    expect(sessionNeedsAttention('waiting_question', false)).toBe(true);
  });

  it('flags unread sessions even when actively working', () => {
    expect(sessionNeedsAttention('running', true)).toBe(true);
    expect(sessionNeedsAttention('idle', true)).toBe(true);
  });

  it('does not flag a running or completed session with nothing unread', () => {
    expect(sessionNeedsAttention('running', false)).toBe(false);
    expect(sessionNeedsAttention('completed', false)).toBe(false);
    expect(sessionNeedsAttention('idle', false)).toBe(false);
  });

  it('does not flag an unknown/undefined state with nothing unread', () => {
    expect(sessionNeedsAttention(undefined, false)).toBe(false);
  });
});
