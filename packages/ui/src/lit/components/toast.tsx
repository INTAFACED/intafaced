/**
 * Toast: a short confirmation that something just happened ("Link copied", "Handle changed"), shown for a moment at the
 * top of the screen and announced politely, so it never interrupts what a screen reader is saying. Mount
 * `ToastProvider` once around the room (or the app); any part under it raises one with `useToast().add(...)`. The live
 * region is in the page before any toast arrives, so the first one is heard too. A toast is never the only place a
 * result is shown: money results go in the room's receipt. Words arrive as props.
 */
import * as React from 'react';

export interface ToastOptions {
  title: string;
  description?: string;
  /** Milliseconds before it closes. Default: the provider's; 0 keeps it until dismissed. */
  timeout?: number;
}

interface Shown extends ToastOptions {
  id: string;
}

interface ToastApi {
  add: (options: ToastOptions) => string;
  close: (id?: string) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

function ToastItem({ toast, closeLabel, onClose }: { toast: Shown; closeLabel: string; onClose: (id: string) => void }) {
  const { id, timeout } = toast;
  React.useEffect(() => {
    if (!timeout) return;
    const timer = setTimeout(() => onClose(id), timeout);
    return () => clearTimeout(timer);
  }, [id, timeout, onClose]);
  return (
    <div className="lit-toast" data-slot="toast">
      <div data-part="text">
        <p data-part="title">{toast.title}</p>
        {toast.description ? <p data-part="body">{toast.description}</p> : null}
      </div>
      <button type="button" data-part="close" aria-label={closeLabel} onClick={() => onClose(id)}>
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export type ToastProviderProps = {
  children?: React.ReactNode;
  /** The close key's name ("Dismiss"). */
  closeLabel: string;
  /** Milliseconds a toast stays when it does not say. Default 5000. */
  timeout?: number;
  /** Most toasts shown at once; the oldest goes first. Default 3. */
  limit?: number;
};

export function ToastProvider({ children, closeLabel, timeout = 5000, limit = 3 }: ToastProviderProps) {
  const [toasts, setToasts] = React.useState<readonly Shown[]>([]);
  const next = React.useRef(0);
  const close = React.useCallback((id?: string) => setToasts((now) => (id === undefined ? [] : now.filter((t) => t.id !== id))), []);
  const api = React.useMemo<ToastApi>(
    () => ({
      add: (options) => {
        next.current += 1;
        const id = `toast-${next.current}`;
        setToasts((now) => [...now, { timeout, ...options, id }].slice(-limit));
        return id;
      },
      close,
    }),
    [timeout, limit, close],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="lit-toasts" role="status" aria-live="polite" data-slot="toast-region">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} closeLabel={closeLabel} onClose={close} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast.add({ title: 'Link copied', timeout: 2000 })`, under a `ToastProvider`. */
export function useToast(): ToastApi {
  const api = React.useContext(ToastContext);
  if (!api) throw new Error('useToast needs a ToastProvider above it (@intafaced/ui/lit)');
  return api;
}
