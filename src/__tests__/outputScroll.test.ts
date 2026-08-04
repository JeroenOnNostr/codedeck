import { describe, it, expect } from 'vitest';
import { isAtBottom, nextAutoScroll, BOTTOM_THRESHOLD } from '../components/outputScroll';

// A viewport 800px tall over 5000px of output. Bottom of the range is scrollTop 4200.
const VIEW = { scrollHeight: 5000, clientHeight: 800 };
const at = (scrollTop: number, over: Partial<typeof VIEW> = {}) => ({ ...VIEW, ...over, scrollTop });

describe('isAtBottom', () => {
  it('is true at the very bottom', () => {
    expect(isAtBottom(at(4200))).toBe(true);
  });

  it('is true just inside the threshold', () => {
    expect(isAtBottom(at(4200 - (BOTTOM_THRESHOLD - 1)))).toBe(true);
  });

  it('is false just outside the threshold', () => {
    expect(isAtBottom(at(4200 - BOTTOM_THRESHOLD))).toBe(false);
  });
});

describe('nextAutoScroll', () => {
  it('disarms as soon as the user scrolls away from the bottom', () => {
    expect(nextAutoScroll(at(1000), 4200, true)).toBe(false);
  });

  it('stays disarmed while the user reads old output', () => {
    expect(nextAutoScroll(at(900), 1000, false)).toBe(false);
  });

  it('re-arms when the user scrolls back down to the bottom', () => {
    expect(nextAutoScroll(at(4200), 3900, false)).toBe(true);
  });

  // The regression: react-window re-measures a row shorter, scrollHeight shrinks, and
  // the browser clamps scrollTop down. That made isAtBottom read true and switched
  // following back on, yanking the reader to the newest message.
  it('does not re-arm when shrinking content clamps scrollTop downward', () => {
    const shrunk = { scrollTop: 1000, scrollHeight: 1800, clientHeight: 800 };
    expect(isAtBottom(shrunk)).toBe(true);
    expect(nextAutoScroll(shrunk, 1200, false)).toBe(false);
  });

  it('does not re-arm on a rubber-band bounce back at the bottom', () => {
    expect(nextAutoScroll(at(4200), 4260, false)).toBe(false);
  });

  it('keeps following when already at the bottom and content grows below', () => {
    expect(nextAutoScroll(at(4300, { scrollHeight: 5100 }), 4200, true)).toBe(true);
  });
});
