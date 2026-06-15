import { useMemo } from 'react';
import { useDmStore } from '../stores/dmStore';
import { useUIStore } from '../stores/uiStore';
import { getPubkeyHex } from '../services/nostrService';
import { relativeTime } from '../utils/relativeTime';
import Avatar from './Avatar';
import type { DmConversation } from '../types';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export default function DmTile({ conversation, isSelected }: { conversation: DmConversation; isSelected: boolean }) {
  const setActiveConversation = useDmStore((s) => s.setActiveConversation);
  const privateKeyHex = useDmStore((s) => s.nostrConfig.private_key_hex);
  const refreshProfile = useDmStore((s) => s.refreshProfile);
  const setPanelMode = useUIStore((s) => s.setPanelMode);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const ownPubkey = useMemo(() => {
    if (privateKeyHex) {
      try { return getPubkeyHex(hexToBytes(privateKeyHex)); } catch { /* fallback */ }
    }
    return '';
  }, [privateKeyHex]);

  const other = conversation.participants.find((p) => p !== ownPubkey) ?? conversation.participants[0] ?? '';
  const profile = useDmStore((s) => s.profiles[other]);
  const status = useDmStore((s) => s.profileStatus[other]);

  const handleClick = () => {
    setActiveConversation(conversation.id);
    setPanelMode('dm');
    setSidebarOpen(false);
  };

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (other) refreshProfile(other);
  };

  const name = profile?.displayName || profile?.name || conversation.display_name;

  return (
    <div
      className={`dm-tile${isSelected ? ' selected' : ''}`}
      onClick={handleClick}
    >
      <Avatar pubkey={other} picture={profile?.picture} name={profile?.displayName || profile?.name} size={36} />
      <div className="dm-tile-info">
        <div className={`dm-tile-name${status === 'loading' ? ' dm-tile-name--loading' : ''}`}>{name}</div>
        <div className="dm-tile-time">{relativeTime(conversation.last_message_at)}</div>
      </div>
      {status === 'error' && (
        <button className="dm-profile-retry" onClick={handleRetry} title="Couldn't load profile — retry" type="button">
          ↻
        </button>
      )}
      {conversation.unread_count > 0 && (
        <div className="dm-tile-unread">{conversation.unread_count}</div>
      )}
    </div>
  );
}
