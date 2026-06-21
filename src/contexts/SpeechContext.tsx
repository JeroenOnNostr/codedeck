/**
 * Shared Speech Context.
 *
 * Lifts the useSpeechRecognition hook to a shared provider so both
 * InputBar (manual dictation) and useVoiceMode (auto-listen for commands)
 * can share the same STT instance.
 *
 * Uses a dual-slot priority model:
 *   - voiceHandler (high priority) — set by useVoiceMode when expecting a command
 *   - inputHandler (low priority)  — set by InputBar for manual dictation
 * When voiceHandler is set, it receives all results. Otherwise inputHandler does.
 */

import { createContext, useContext, useRef, useCallback, type ReactNode } from 'react';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';

export interface SpeechContextValue {
  available: boolean;
  isListening: boolean;
  interimTranscript: string;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  recheckAvailability: () => Promise<void>;
  error: string | null;
  /** Set the voice command handler (high priority). Pass null to clear. */
  setVoiceHandler: (handler: ((transcript: string) => void) | null) => void;
  /** Set the input/dictation handler (low priority, used when voice handler is null). */
  setInputHandler: (handler: (transcript: string) => void) => void;
}

const SpeechContext = createContext<SpeechContextValue | null>(null);

export function SpeechProvider({ children }: { children: ReactNode }) {
  const voiceHandlerRef = useRef<((transcript: string) => void) | null>(null);
  const inputHandlerRef = useRef<((transcript: string) => void) | null>(null);

  const handleResult = useCallback((transcript: string) => {
    if (voiceHandlerRef.current) {
      voiceHandlerRef.current(transcript);
    } else if (inputHandlerRef.current) {
      inputHandlerRef.current(transcript);
    } else {
      console.warn('[SpeechContext] No STT handler registered, dropping transcript');
    }
  }, []);

  const stt = useSpeechRecognition(handleResult);

  const setVoiceHandler = useCallback((handler: ((transcript: string) => void) | null) => {
    voiceHandlerRef.current = handler;
  }, []);

  const setInputHandler = useCallback((handler: (transcript: string) => void) => {
    inputHandlerRef.current = handler;
  }, []);

  return (
    <SpeechContext.Provider value={{ ...stt, setVoiceHandler, setInputHandler }}>
      {children}
    </SpeechContext.Provider>
  );
}

export function useSpeechContext(): SpeechContextValue {
  const ctx = useContext(SpeechContext);
  if (!ctx) throw new Error('useSpeechContext must be used within SpeechProvider');
  return ctx;
}
