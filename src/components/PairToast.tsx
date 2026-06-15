import { useSessionStore } from '../stores/sessionStore';
import '../styles/sidebar.css';

/** Brief confirmation shown when a phone auto-pairs with a bridge. */
export default function PairToast() {
  const pairToast = useSessionStore((s) => s.pairToast);
  const dismiss = useSessionStore((s) => s.dismissPairToast);

  if (!pairToast) return null;

  return (
    <div className="undo-toast pair-toast" onClick={dismiss}>
      <span className="pair-toast-check">✓</span>
      <span className="undo-toast-label">Connected to {pairToast.machine}</span>
    </div>
  );
}
