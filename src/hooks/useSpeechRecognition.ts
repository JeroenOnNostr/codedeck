import { useState, useCallback, useEffect, useRef } from 'react';
import { isTauri, invoke } from '../ipc/tauri';

interface RecognitionResult {
  text: string;
  isFinal: boolean;
}

interface RecognitionError {
  error: string;
  code?: number;
}

interface UseSpeechRecognitionReturn {
  available: boolean;
  isListening: boolean;
  interimTranscript: string;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  recheckAvailability: () => Promise<void>;
  error: string | null;
}

// Dev mode mock: simulates dictation with fake text after a delay
const MOCK_STT_ENABLED = !isTauri() && import.meta.env.DEV;

export function useSpeechRecognition(
  onFinalResult: (transcript: string) => void
): UseSpeechRecognitionReturn {
  const [available, setAvailable] = useState(MOCK_STT_ENABLED);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onFinalResultRef = useRef(onFinalResult);
  onFinalResultRef.current = onFinalResult;
  const mockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const finalDeliveredRef = useRef(false);
  const lastInterimRef = useRef('');
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True between stopListening() and the next terminal event — used to tell a
  // benign "no result" that followed our stop apart from one that arose mid-listen.
  const stopRequestedRef = useRef(false);
  // Mirror of interimTranscript readable from event-listener closures without
  // re-subscribing (the listeners are registered once, keyed on `available`).
  const interimTranscriptRef = useRef('');
  interimTranscriptRef.current = interimTranscript;

  // Re-query the native plugin for availability. Exposed so the UI can retry
  // (the recognizer can report unavailable transiently, e.g. while the speech
  // service updates), and called on mount + when the window regains focus.
  const recheckAvailability = useCallback(async () => {
    if (MOCK_STT_ENABLED || !isTauri()) return;
    try {
      const result = await invoke<{ available: boolean }>(
        'plugin:speech-recognizer|is_available'
      );
      if (result) setAvailable(result.available);
    } catch {
      // Plugin not available
    }
  }, []);

  // Check availability on mount and whenever the window regains focus.
  useEffect(() => {
    if (MOCK_STT_ENABLED || !isTauri()) return;
    void recheckAvailability();
    const onFocus = () => { void recheckAvailability(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [recheckAvailability]);

  // Set up plugin event listeners (Tauri mobile only)
  useEffect(() => {
    if (!available || MOCK_STT_ENABLED || !isTauri()) return;

    let mounted = true;

    (async () => {
      try {
        // Use addPluginListener for mobile plugin events
        const { addPluginListener } = await import('@tauri-apps/api/core');

        const resultListener = await addPluginListener(
          'speech-recognizer',
          'result',
          (data: RecognitionResult) => {
            if (!mounted) return;
            if (data.isFinal) {
              console.debug('[STT] Final result received:', data.text?.substring(0, 50));
              finalDeliveredRef.current = true;
              lastInterimRef.current = '';
              onFinalResultRef.current(data.text);
              setInterimTranscript('');
              setIsListening(false);
              if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
              }
            } else {
              setInterimTranscript(data.text);
            }
          }
        );
        cleanupRef.current.push(() => resultListener.unregister());

        const errorListener = await addPluginListener(
          'speech-recognizer',
          'error',
          (data: RecognitionError) => {
            if (!mounted) return;
            console.debug('[STT] Error received:', data.code, data.error);
            // Android SpeechRecognizer.ERROR_* codes. These three are benign
            // "no result" outcomes rather than failures:
            //   5 ERROR_CLIENT       — fires after a programmatic stop/cancel
            //   6 ERROR_SPEECH_TIMEOUT — user stopped without speaking
            //   7 ERROR_NO_MATCH     — speech ended but nothing was recognized
            // All other codes (audio/network/server/busy/permissions) are real
            // failures the user should see. We only swallow the benign codes
            // when WE initiated the stop (stopRequestedRef); a benign-looking
            // code that arrives mid-listen still surfaces as "didn't catch that".
            const isBenignCode = data.code === 5 || data.code === 6 || data.code === 7;
            if (isBenignCode && stopRequestedRef.current) {
              if (!finalDeliveredRef.current && lastInterimRef.current) {
                finalDeliveredRef.current = true;
                onFinalResultRef.current(lastInterimRef.current);
                lastInterimRef.current = '';
              }
            } else if (isBenignCode) {
              // Mid-listen no-match/timeout with nothing captured — gentle hint.
              if (!lastInterimRef.current && !interimTranscriptRef.current) {
                setError("Didn't catch that — try again.");
              } else if (!finalDeliveredRef.current) {
                // We had interim text; keep it rather than dropping silently.
                finalDeliveredRef.current = true;
                onFinalResultRef.current(
                  lastInterimRef.current || interimTranscriptRef.current
                );
                lastInterimRef.current = '';
              }
            } else {
              setError(data.error || 'Speech recognition error');
            }
            stopRequestedRef.current = false;
            setIsListening(false);
            setInterimTranscript('');
            if (stopTimeoutRef.current) {
              clearTimeout(stopTimeoutRef.current);
              stopTimeoutRef.current = null;
            }
          }
        );
        cleanupRef.current.push(() => errorListener.unregister());

        const stateListener = await addPluginListener(
          'speech-recognizer',
          'stateChange',
          (data: { state: string }) => {
            if (!mounted) return;
            if (data.state === 'listening') {
              setIsListening(true);
            } else if (data.state === 'idle') {
              setIsListening(false);
            }
          }
        );
        cleanupRef.current.push(() => stateListener.unregister());
      } catch (e) {
        console.warn('Failed to register speech-recognizer listeners:', e);
      }
    })();

    return () => {
      mounted = false;
      cleanupRef.current.forEach(fn => fn());
      cleanupRef.current = [];
      if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    };
  }, [available]);

  const startListening = useCallback(async () => {
    setError(null);
    setInterimTranscript('');
    stopRequestedRef.current = false;
    finalDeliveredRef.current = false;

    // Mock mode for dev/browser testing
    if (MOCK_STT_ENABLED) {
      setIsListening(true);
      const mockPhrases = [
        'This is a test dictation',
        'Hello world from mock speech recognition',
        'The quick brown fox jumps over the lazy dog',
      ];
      const phrase = mockPhrases[Math.floor(Math.random() * mockPhrases.length)];
      const words = phrase.split(' ');
      let i = 0;

      const tick = () => {
        i++;
        if (i < words.length) {
          setInterimTranscript(words.slice(0, i + 1).join(' '));
          mockTimerRef.current = setTimeout(tick, 300);
        } else {
          setInterimTranscript('');
          setIsListening(false);
          onFinalResultRef.current(phrase);
        }
      };
      setInterimTranscript(words[0]);
      mockTimerRef.current = setTimeout(tick, 300);
      return;
    }

    try {
      // request_permission now blocks until the user actually responds to the
      // OS dialog (resolved natively via the Tauri permission callback), so the
      // returned value is authoritative — no fixed-delay polling needed.
      const permResult = await invoke<{ granted: boolean }>(
        'plugin:speech-recognizer|request_permission'
      );

      if (permResult && !permResult.granted) {
        setError('Microphone permission denied. Enable it in Settings to dictate.');
        return;
      }

      await invoke('plugin:speech-recognizer|start_listening', { language: 'en-US' });
      setIsListening(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopListening = useCallback(async () => {
    // Mock mode cleanup
    if (MOCK_STT_ENABLED) {
      if (mockTimerRef.current) {
        clearTimeout(mockTimerRef.current);
        mockTimerRef.current = null;
      }
      // Commit whatever interim text exists as the final result
      if (interimTranscript) {
        onFinalResultRef.current(interimTranscript);
      }
      setIsListening(false);
      setInterimTranscript('');
      return;
    }

    // Snapshot interim text before clearing — used as fallback
    // if the native side never delivers a final result.
    lastInterimRef.current = interimTranscript;
    finalDeliveredRef.current = false;
    // Mark that the terminal event that follows is a side-effect of our stop,
    // so the error listener treats a benign no-match/timeout code as "done".
    stopRequestedRef.current = true;

    try {
      await invoke('plugin:speech-recognizer|stop_listening');
      console.debug('[STT] stopListening invoked, lastInterim:', lastInterimRef.current?.substring(0, 50));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }

    setIsListening(false);

    // Safety net: if no final result arrives within 2 seconds,
    // deliver the last interim text so it is never lost.
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    stopTimeoutRef.current = setTimeout(() => {
      if (!finalDeliveredRef.current && lastInterimRef.current) {
        console.debug('[STT] Timeout fallback delivering:', lastInterimRef.current?.substring(0, 50));
        finalDeliveredRef.current = true;
        onFinalResultRef.current(lastInterimRef.current);
        lastInterimRef.current = '';
      }
      setInterimTranscript('');
      stopTimeoutRef.current = null;
    }, 2000);
  }, [interimTranscript]);

  return {
    available,
    isListening,
    interimTranscript,
    startListening,
    stopListening,
    recheckAvailability,
    error,
  };
}
