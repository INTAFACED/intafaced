/**
 * InfoTip: a small (i) button that explains a figure or a label in a sentence. It opens on hover, on keyboard focus
 * and on a tap (a phone has no hover), and closes on Escape, on leaving and on a second tap. The text is also in the
 * page as the button's description, so a screen reader never depends on the bubble. Words arrive as props.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type InfoTipProps = {
  /** The explanation, one or two sentences. */
  text: string;
  /** The button's name ("About this number"). */
  label: string;
  /** Where the bubble opens: below the button (default), or at its end side so it never covers the figure beside it. */
  side?: 'below' | 'end';
  className?: string;
  'data-testid'?: string;
};

export function InfoTip({ text, label, side = 'below', className, 'data-testid': testId }: InfoTipProps) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  // A tap opens it and keeps it open; hover and focus open it until the pointer or focus leaves.
  const pinned = React.useRef(false);
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  return (
    <span className={clsx('lit-tip', className)} data-side={side} data-open={open || undefined}>
      <button
        type="button"
        className="lit-tip__button"
        data-testid={testId}
        aria-label={label}
        aria-describedby={`${id}-text`}
        aria-expanded={open}
        onClick={() => {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && !pinned.current && setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            close();
          }
        }}
      >
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
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
      {/* The bubble repeats the description for sighted readers; assistive tech reads the description once. */}
      {open ? (
        <span className="lit-tip__bubble" aria-hidden="true">
          {text}
        </span>
      ) : null}
      <span id={`${id}-text`} className="lit-sr">
        {text}
      </span>
    </span>
  );
}
