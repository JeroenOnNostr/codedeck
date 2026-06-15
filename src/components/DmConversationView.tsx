import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useDmStore } from '../stores/dmStore';
import { useUIStore } from '../stores/uiStore';
import { getPubkeyHex } from '../services/nostrService';
import { useSpeechContext } from '../contexts/SpeechContext';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { processImageFile } from '../utils/imageUtils';
import { uploadToBlossom, DEFAULT_BLOSSOM_SERVER } from '../utils/blossomUpload';
import Avatar from './Avatar';
import type { DmMessage } from '../types';
import '../styles/dm.css';
import '../styles/input.css';
import '../styles/header.css';

const EMPTY_MESSAGES: DmMessage[] = [];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

interface PendingImage {
  base64: string;
  filename: string;
  mimeType: string;
  previewUrl: string;   // blob: URL (lightweight, not a base64 copy)
  sizeBytes: number;
}

export default function DmConversationView({ conversationId, isWide }: { conversationId: string; isWide: boolean }) {
  const conversation = useDmStore((s) => s.conversations.find(c => c.id === conversationId));
  const messages = useDmStore((s) => s.messages[conversationId] ?? EMPTY_MESSAGES);
  const sendDm = useDmStore((s) => s.sendDm);
  const nostrConfig = useDmStore((s) => s.nostrConfig);
  const resolveProfile = useDmStore((s) => s.resolveProfile);
  const refreshProfile = useDmStore((s) => s.refreshProfile);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const [text, setText] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendPop, setSendPop] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isTouchDevice = useMediaQuery('(pointer: coarse)');

  // Revoke blob URL on cleanup or when image changes
  useEffect(() => {
    return () => {
      if (pendingImage?.previewUrl) {
        URL.revokeObjectURL(pendingImage.previewUrl);
      }
    };
  }, [pendingImage]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const previewUrl = URL.createObjectURL(file);
      const processed = await processImageFile(file);
      if (pendingImage?.previewUrl) {
        URL.revokeObjectURL(pendingImage.previewUrl);
      }
      setPendingImage({
        base64: processed.base64,
        filename: processed.filename,
        mimeType: processed.mimeType,
        previewUrl,
        sizeBytes: processed.sizeBytes,
      });
    } catch (err) {
      console.error('Failed to process image:', err);
    }
    e.target.value = '';
  };

  const removePendingImage = () => {
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    setPendingImage(null);
  };

  const handleDictationResult = useCallback((transcript: string) => {
    setText(prev => {
      const separator = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
      return prev + separator + transcript;
    });
  }, []);

  const {
    available: sttAvailable,
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    setInputHandler,
  } = useSpeechContext();

  // Register DM dictation handler (low priority — voice mode overrides when active)
  useEffect(() => {
    setInputHandler(handleDictationResult);
  }, [setInputHandler, handleDictationResult]);

  const displayValue = interimTranscript
    ? text + (text && !text.endsWith(' ') ? ' ' : '') + interimTranscript
    : text;

  // Auto-expand textarea upward as content grows
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '68px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 144) + 'px';
    }
  }, [text, interimTranscript]);

  const ownPubkey = useMemo(() => {
    if (nostrConfig.private_key_hex) {
      try {
        return getPubkeyHex(hexToBytes(nostrConfig.private_key_hex));
      } catch { /* fallback */ }
    }
    return '0'.repeat(64);
  }, [nostrConfig.private_key_hex]);

  const isSent = (msg: { sender_pubkey: string }) => msg.sender_pubkey === ownPubkey;

  // The other participant whose profile drives the header avatar/name.
  const recipientPubkey = conversation?.participants.find((p) => p !== ownPubkey)
    ?? conversation?.participants[0];
  const profile = useDmStore((s) => (recipientPubkey ? s.profiles[recipientPubkey] : undefined));
  const profileStatus = useDmStore((s) => (recipientPubkey ? s.profileStatus[recipientPubkey] : undefined));

  // Resolve (or refresh stale) profile when the conversation opens.
  useEffect(() => {
    if (recipientPubkey) resolveProfile(recipientPubkey);
  }, [recipientPubkey, resolveProfile]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length]);

  // Auto-scroll on container resize (keyboard open/close) if near bottom
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const nearBottom = scrollHeight - scrollTop - clientHeight < 150;
      if (nearBottom) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const canSend = (text.trim() || pendingImage) && !sending;

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;
    if (sending || !conversation) return;

    const recipientPubkey = conversation.participants.find(p => p !== ownPubkey);
    if (!recipientPubkey) return;

    setSending(true);
    try {
      let finalContent = trimmed;

      if (pendingImage && nostrConfig.private_key_hex) {
        const skBytes = hexToBytes(nostrConfig.private_key_hex);
        const server = nostrConfig.blossomServer || DEFAULT_BLOSSOM_SERVER;
        const result = await uploadToBlossom(pendingImage.base64, skBytes, server);
        const imageRef = `${result.url} key=${result.key} iv=${result.iv}`;
        finalContent = finalContent ? `${finalContent}\n${imageRef}` : imageRef;
      }

      if (!finalContent) return;

      await sendDm(recipientPubkey, finalContent);
      setText('');
      removePendingImage();
      setSendPop(true);
      setTimeout(() => setSendPop(false), 250);
    } catch (err) {
      console.error('Failed to send DM:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleDictation = async () => {
    if (isListening) {
      await stopListening();
    } else {
      textareaRef.current?.blur();
      await startListening();
    }
  };

  if (!conversation) {
    return (
      <div className="dm-view">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
          Conversation not found
        </div>
      </div>
    );
  }

  return (
    <div className="dm-view">
      <div className="session-header">
        {!isWide && (
          <button className="header-btn header-hamburger" onClick={() => setSidebarOpen(true)}>
            &#9776;
          </button>
        )}
        <button className="header-btn header-settings" onClick={() => setSettingsOpen(true)}>
          &#9881;
        </button>
        {recipientPubkey && (
          <Avatar
            pubkey={recipientPubkey}
            picture={profile?.picture}
            name={profile?.displayName || profile?.name}
            size={32}
          />
        )}
        <div className="header-info">
          <div className={`header-title${profileStatus === 'loading' ? ' dm-tile-name--loading' : ''}`}>
            {profile?.displayName || profile?.name || conversation.display_name}
          </div>
          {profileStatus === 'error' && (
            <button
              className="dm-profile-retry-text"
              onClick={() => recipientPubkey && refreshProfile(recipientPubkey)}
              type="button"
            >
              couldn't load profile — retry
            </button>
          )}
        </div>
      </div>

      <div className="dm-messages" ref={messagesContainerRef}>
        {messages.map((msg) => {
          const recipientPubkey = conversation.participants.find(p => p !== ownPubkey);
          const handleRetry = () => {
            if (msg.status === 'failed' && recipientPubkey) {
              sendDm(recipientPubkey, msg.content);
            }
          };
          return (
            <div key={msg.id} className={`dm-bubble-wrapper ${isSent(msg) ? 'sent' : 'received'}`}>
              <div
                className={`dm-bubble ${isSent(msg) ? 'sent' : 'received'}${msg.status === 'failed' ? ' failed' : ''}`}
              >
                <div className="dm-bubble-content">{msg.content}</div>
                <div className="dm-bubble-time">
                  {formatTime(msg.timestamp)}
                  {msg.status === 'failed' && <span className="dm-send-failed"> — send failed</span>}
                </div>
              </div>
              {msg.status === 'failed' && (
                <button className="dm-retry-btn" onClick={handleRetry} type="button">
                  Retry
                </button>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-bar-wrapper">
        {pendingImage && (
          <div className="image-preview-strip">
            <img
              src={pendingImage.previewUrl}
              alt="Attachment preview"
              className="image-preview-thumb"
            />
            <span className="image-preview-info">
              {pendingImage.filename} ({Math.round(pendingImage.sizeBytes / 1024)}KB)
              {sending && ' — Sending...'}
            </span>
            <button
              className="image-preview-remove"
              onClick={removePendingImage}
              aria-label="Remove image"
              type="button"
              disabled={sending}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
        )}

        <div className="input-bar">
          <button
            className="attach-btn dm-attach-btn"
            onPointerDown={e => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach image"
            type="button"
            disabled={sending}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />

          <textarea
            ref={textareaRef}
            className="input-textarea"
            value={isListening ? displayValue : text}
            onChange={(e) => { if (!isListening) setText(e.target.value); }}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? 'Listening...' : 'Message...'}
            rows={1}
            readOnly={isListening || sending}
          />

          <div className="right-controls">
            {sttAvailable && (
              <button
                className={`mic-btn ${isListening ? 'mic-active' : ''}`}
                onClick={toggleDictation}
                onPointerDown={e => e.preventDefault()}
                aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
                type="button"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                </svg>
              </button>
            )}
            <button
              className={`send-btn${canSend ? ' send-btn-active' : ''}${sendPop ? ' send-pop' : ''}`}
              onClick={handleSend}
              onPointerDown={e => e.preventDefault()}
              disabled={!canSend}
            >
              {sending ? 'SENDING' : 'SEND'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
