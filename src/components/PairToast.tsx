import { useSessionStore } from '../stores/sessionStore';
import '../styles/sidebar.css';

/**
 * Pairing outcome banner.
 *
 * Failures matter as much as successes here: a pasted link whose pairing window
 * has expired produces no connection and, before this, no explanation either.
 */
export default function PairToast() {
  const pairToast = useSessionStore((s) => s.pairToast);
  const dismiss = useSessionStore((s) => s.dismissPairToast);

  if (!pairToast) return null;

  if (!pairToast.ok) {
    return (
      <div className="undo-toast pair-toast pair-toast-error" onClick={dismiss}>
        <span className="pair-toast-cross">✕</span>
        <span className="undo-toast-label">
          {pairToast.message ?? `Could not pair with ${pairToast.machine}`}
        </span>
      </div>
    );
  }

  return (
    <div className="undo-toast pair-toast" onClick={dismiss}>
      <span className="pair-toast-check">✓</span>
      <span className="undo-toast-label">Connected to {pairToast.machine}</span>
    </div>
  );
}
