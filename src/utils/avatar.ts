/**
 * Deterministic fallback-avatar helpers (no dependency).
 *
 * When a profile has no usable `picture`, we render a colored circle with the
 * contact's initials. Both the color and the initials are derived from the
 * pubkey so the same contact always looks the same.
 */

/** Deterministic HSL background color derived from the pubkey hex. */
export function avatarColor(pubkeyHex: string): string {
  // Use the leading hex bytes as a hue seed; fixed S/L for a consistent palette
  // that reads on the app's dark background.
  const seed = parseInt(pubkeyHex.slice(0, 6) || '0', 16);
  const hue = seed % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/** Initials for the fallback chip: from the name if present, else pubkey hex. */
export function avatarInitials(name: string | undefined, pubkeyHex: string): string {
  const trimmed = name?.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  }
  return pubkeyHex.slice(0, 2).toUpperCase();
}
