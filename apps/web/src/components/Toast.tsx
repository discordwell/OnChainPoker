/**
 * Toast notification container — renders at the top-right of the viewport.
 */
import { useToast } from "../hooks/useToast";

const ICON: Record<string, string> = {
  success: "\u2713",
  error: "\u2717",
  info: "\u2139",
};

export function ToastContainer() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          onClick={() => dismiss(t.id)}
          role="alert"
        >
          <span className="toast__icon">{ICON[t.kind]}</span>
          <span className="toast__msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
