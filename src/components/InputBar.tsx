import { useState, useRef, useEffect, useCallback } from 'react';
import { AgentMode, EffortLevel } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { useSpeechContext } from '../contexts/SpeechContext';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { processImageFile } from '../utils/imageUtils';
import { cycleIndex } from '../utils/cycleIndex';
import QuickPromptBar from './QuickPromptBar';
import '../styles/input.css';

interface PendingImage {
  base64: string;
  filename: string;
  mimeType: string;
  previewUrl: string;   // blob: URL (lightweight, not a base64 copy)
  sizeBytes: number;
}

export default function InputBar({ sessionId, mode, effort }: { sessionId: string; mode?: AgentMode; effort?: EffortLevel }) {
  const [text, setText] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendPop, setSendPop] = useState(false);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const setMode = useSessionStore((s) => s.setMode);
  const setEffort = useSessionStore((s) => s.setEffort);
  // Which setting (if any) is awaiting a bridge *-confirmed for this session — drives the
  // "pending" pulse on the mode/effort buttons so a slow/failed round-trip is visible.
  const pendingSettingKind = useSessionStore((s) => s.remoteSettingPending[sessionId]?.kind ?? null);
  const pendingRevision = useSessionStore((s) => s.pendingRevisionSession === sessionId);
  const clearPendingRevision = useSessionStore((s) => s.setPendingRevision);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isTouchDevice = useMediaQuery('(pointer: coarse)');
  const cancelAgent = useSessionStore((s) => s.cancelAgent);
  const isRemote = useSessionStore((s) => {
    for (const sessions of Object.values(s.remoteSessions)) {
      if (sessions?.some(rs => rs.id === sessionId)) return true;
    }
    return false;
  });
  const sessionState = useSessionStore((s) => {
    const local = s.sessions.find(sess => sess.id === sessionId);
    return local?.state ?? null;
  });
  const showStopButton = isRemote || sessionState === 'running' || sessionState === 'waiting_permission';

  // Auto-focus textarea when plan revision is requested
  useEffect(() => {
    if (pendingRevision && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [pendingRevision]);

  // Check if the remote session has no terminal (bridge reported hasTerminal=false).
  // The selector returns a primitive boolean, so zustand skips re-renders when the value is stable.
  const noTerminal = useSessionStore((s) => {
    for (const sessions of Object.values(s.remoteSessions)) {
      for (const sess of sessions) {
        if (sess.id === sessionId) return sess.hasTerminal === false;
      }
    }
    return false;
  });

  // Check if the bridge machine owning this session is disconnected.
  const bridgeOffline = useSessionStore((s) => s.isBridgeOffline(sessionId));

  // Revoke blob URL on cleanup or when image changes
  useEffect(() => {
    return () => {
      if (pendingImage?.previewUrl) {
        URL.revokeObjectURL(pendingImage.previewUrl);
      }
    };
  }, [pendingImage]);

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
    error: sttError,
    setInputHandler,
  } = useSpeechContext();

  // Register InputBar's dictation handler (low priority — voice mode overrides when active)
  useEffect(() => {
    setInputHandler(handleDictationResult);
  }, [setInputHandler, handleDictationResult]);

  const displayValue = interimTranscript
    ? text + (text && !text.endsWith(' ') ? ' ' : '') + interimTranscript
    : text;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '68px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 144) + 'px';
    }
  }, [text, interimTranscript]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Create lightweight blob URL for preview (not a base64 duplicate)
      const previewUrl = URL.createObjectURL(file);
      const processed = await processImageFile(file);
      // Revoke old preview if replacing
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
    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  const removePendingImage = () => {
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    setPendingImage(null);
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;
    if (sending) return;

    setSending(true);
    try {
      if (pendingImage) {
        await sendMessage(sessionId, trimmed, {
          base64: pendingImage.base64,
          filename: pendingImage.filename,
          mimeType: pendingImage.mimeType,
        });
      } else {
        await sendMessage(sessionId, trimmed);
      }
      setText('');
      removePendingImage();
      if (pendingRevision) clearPendingRevision(null);
      setSendPop(true);
      setTimeout(() => setSendPop(false), 250);
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

  const MODE_CYCLE: AgentMode[] = ['plan', 'default', 'acceptEdits'];
  const MODE_LABELS: Record<AgentMode, string> = {
    plan: 'PLAN',
    default: 'YOLO (default)',
    acceptEdits: 'EDITS',
  };

  const EFFORT_CYCLE: EffortLevel[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
  const EFFORT_LABELS: Record<EffortLevel, string> = {
    auto: 'AUTO',
    low: 'LOW',
    medium: 'MED',
    high: 'HIGH',
    xhigh: 'XHI',
    max: 'MAX',
  };

  const [modeCooldown, setModeCooldown] = useState(false);
  const [effortCooldown, setEffortCooldown] = useState(false);
  // Tracks whether the user just asked for 'max' mid-session, so we can explain the xhigh downgrade.
  const [requestedMax, setRequestedMax] = useState(false);
  const [maxHint, setMaxHint] = useState(false);

  const cycleMode = () => {
    if (modeCooldown) return;
    const current = mode ?? 'plan';
    const idx = MODE_CYCLE.indexOf(current);
    const next = MODE_CYCLE[cycleIndex(idx, MODE_CYCLE.length, 1)];
    setMode(sessionId, next);
    setModeCooldown(true);
    setTimeout(() => setModeCooldown(false), 600);
  };

  const cycleEffort = () => {
    if (effortCooldown || !effort) return;
    const idx = EFFORT_CYCLE.indexOf(effort);
    const next = EFFORT_CYCLE[cycleIndex(idx, EFFORT_CYCLE.length, 1)];
    setRequestedMax(next === 'max'); // remember intent so we can explain a downgrade
    setEffort(sessionId, next);
    setEffortCooldown(true);
    setTimeout(() => setEffortCooldown(false), 600);
  };

  // Mid-session 'max' is applied as 'xhigh' (the SDK can't set 'max' mid-session — it needs a
  // fresh session). When the user asked for max but the confirmed level comes back xhigh, show a
  // brief, honest hint instead of silently relabeling to XHI.
  useEffect(() => {
    if (requestedMax && effort === 'xhigh') {
      setMaxHint(true);
      setRequestedMax(false);
      const t = setTimeout(() => setMaxHint(false), 5000);
      return () => clearTimeout(t);
    }
    if (requestedMax && effort === 'max') {
      // Honored (e.g. confirmed as max) — clear intent, no hint.
      setRequestedMax(false);
    }
  }, [requestedMax, effort]);

  const canSend = (text.trim() || pendingImage) && !sending && !bridgeOffline;

  return (
    <div className="input-bar-wrapper">
      <QuickPromptBar sessionId={sessionId} disabled={sending || bridgeOffline} />
      {bridgeOffline && (
        <div className="input-no-terminal-notice">
          Bridge offline — waiting for reconnection
        </div>
      )}
      {!bridgeOffline && noTerminal && (
        <div className="input-no-terminal-notice">
          Terminal offline — will auto-relaunch on send
        </div>
      )}
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

      {maxHint && (
        <div className="effort-max-hint">
          Running at <strong>XHIGH</strong> — true MAX effort applies only to a newly created session.
        </div>
      )}

      {sttError && !isListening && (
        <div className="stt-error-hint" role="status">
          <span>{sttError}</span>
        </div>
      )}

      <div className="input-bar">
        <div className="left-controls">
          <button
            className="attach-btn"
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
          <button className={`mode-btn active${modeCooldown ? ' mode-cooldown' : ''}${pendingSettingKind === 'mode' ? ' setting-pending' : ''}`} onPointerDown={e => e.preventDefault()} onClick={cycleMode} title={pendingSettingKind === 'mode' ? 'Applying…' : undefined}>
            {MODE_LABELS[mode ?? 'default']}
          </button>
          {effort !== undefined && (
            <button
              className={`effort-btn active${effortCooldown ? ' effort-cooldown' : ''}${pendingSettingKind === 'effort' ? ' setting-pending' : ''}`}
              onPointerDown={e => e.preventDefault()}
              onClick={cycleEffort}
              title={pendingSettingKind === 'effort' ? 'Applying…' : effort === 'xhigh' ? 'XHIGH — for true MAX, start a new session' : `Effort: ${EFFORT_LABELS[effort]}`}
            >
              {EFFORT_LABELS[effort]}
            </button>
          )}
        </div>

        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={isListening ? displayValue : text}
          onChange={(e) => { if (!isListening) setText(e.target.value); }}
          onKeyDown={handleKeyDown}
          placeholder={bridgeOffline ? 'Bridge offline...' : isListening ? 'Listening...' : pendingRevision ? 'Type your plan revision...' : 'Ask anything...'}
          rows={1}
          readOnly={isListening || sending || bridgeOffline}
        />

        <div className="right-controls">
          {showStopButton && (
            <button
              className="stop-btn"
              onClick={() => cancelAgent(sessionId)}
              aria-label={isRemote ? 'Interrupt session' : 'Cancel agent'}
              title={isRemote ? 'Interrupt session' : 'Cancel agent'}
              type="button"
            >
              &#x25A0;
            </button>
          )}
          {sttAvailable && (
            <button
              className={`mic-btn ${isListening ? 'mic-active' : ''}`}
              onClick={toggleDictation}
              aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
              type="button"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
            </button>
          )}
          <button className={`send-btn${canSend ? ' send-btn-active' : ''}${sendPop ? ' send-pop' : ''}`} onClick={handleSend} disabled={!canSend}>
            {sending ? 'SENDING' : 'SEND'}
          </button>
        </div>
      </div>
    </div>
  );
}
