import { useState } from 'react';
import { avatarColor, avatarInitials } from '../utils/avatar';

/**
 * Profile avatar. Renders the profile `picture` when available, degrading to a
 * deterministic colored initials chip on a missing or dead image URL.
 */
export default function Avatar({
  pubkey,
  picture,
  name,
  size = 36,
}: {
  pubkey: string;
  picture?: string;
  name?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);

  const dimension = { width: size, height: size };

  if (picture && !errored) {
    return (
      <img
        className="dm-avatar dm-avatar-img"
        style={dimension}
        src={picture}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setErrored(true)}
      />
    );
  }

  return (
    <div
      className="dm-avatar dm-avatar-fallback"
      style={{ ...dimension, background: avatarColor(pubkey), fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {avatarInitials(name, pubkey)}
    </div>
  );
}
