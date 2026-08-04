// Follow-the-stream ("stick to bottom") decision logic for the output view.
// Kept pure and DOM-free so it can be unit-tested — jsdom has no layout, so the
// real scroll geometry can only be exercised here.

export interface ScrollSample {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How close to the bottom still counts as "following the stream". */
export const BOTTOM_THRESHOLD = 150;

export function isAtBottom({ scrollTop, scrollHeight, clientHeight }: ScrollSample): boolean {
  return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
}

/**
 * Next value of the auto-scroll flag after a scroll event.
 *
 * Leaving the bottom always disarms. Re-arming requires the viewport to have moved
 * *toward* the bottom: a row being re-measured shorter shrinks scrollHeight, which
 * makes `isAtBottom` read true (and clamps scrollTop downward) while the user is
 * parked in old output. Re-arming on that alone is what let auto-scroll switch itself
 * back on and yank the view to the newest message mid-read.
 */
export function nextAutoScroll(
  sample: ScrollSample,
  prevScrollTop: number,
  current: boolean,
): boolean {
  if (!isAtBottom(sample)) return false;
  if (sample.scrollTop > prevScrollTop) return true;
  return current;
}
