'use client';

import { useState } from 'react';

/** Copies an id to the clipboard. Falls back quietly: the id is always shown as text next to it. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="mp-btn mp-btn--small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 2000);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed, select the text' : label}
      <span className="mp-visually-hidden" role="status" aria-live="polite">
        {state === 'copied' ? ' to clipboard' : ''}
      </span>
    </button>
  );
}
