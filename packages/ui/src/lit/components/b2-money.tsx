/**
 * Parts the money rooms share that the kit lacked (volt/flow batch money · flow, #9570): a copy button and a QR
 * code. They read only `--lit-*` roles (styles in `../templates/templates.css`) and take every word as a prop, so a
 * room never draws its own.
 */
import * as React from 'react';
import { Button } from './index.js';

/**
 * Copies `value` to the clipboard and says so for two seconds, in a status line a screen reader hears. The value is
 * shown by the caller, never changed here. `words` are the room's: the button's word, the word once copied, and the
 * word when the browser refused.
 */
export function CopyButton({
  value,
  label,
  words,
}: {
  value: string;
  /** The button's accessible name ("Copy account number"). */
  label: string;
  words: { copy: string; copied: string; failed: string };
}) {
  const [state, setState] = React.useState<'idle' | 'done' | 'failed'>('idle');
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }
  return (
    <>
      <Button tone="secondary" aria-label={label} onClick={() => void copy()}>
        {state === 'done' ? words.copied : words.copy}
      </Button>
      <span className="lt-sr" role="status">
        {state === 'done' ? words.copied : state === 'failed' ? words.failed : ''}
      </span>
    </>
  );
}

/**
 * A QR code drawn from a path the caller encoded (`d` in a `size` square of modules). The modules take the page's
 * colour on a tile of the primary text's, the strongest contrast the roles hold (dark on light in the dark beta); the
 * tile has its quiet zone. `d` null: the value could not be encoded, and `failed` says so instead.
 */
export function QrCode({
  d,
  size,
  label,
  failed,
  ...rest
}: { d: string | null; size: number; label: string; failed: string } & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'children' | 'className' | 'style'
>) {
  if (d === null) return <p role="status">{failed}</p>;
  return (
    <div {...rest} className="lt-qr">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <path d={d} />
      </svg>
    </div>
  );
}
