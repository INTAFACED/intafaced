import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { MetalButton } from './metal-button';

/** One original Cult/MetalFx treatment; the actual inner button owns all form semantics. */
export function PrimaryMetal({
  label,
  busyLabel = 'Saving…',
  busy = false,
  className = '',
  disabled,
  children,
  onPointerEnter,
  onFocus,
  ...props
}: ComponentPropsWithoutRef<'button'> & {
  label: string;
  busy?: boolean;
  busyLabel?: string;
}) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [active, setActive] = useState(true);
  const feedbackTimer = useRef<number | undefined>(undefined);
  const feedback = () => {
    window.clearTimeout(feedbackTimer.current);
    setActive(true);
    feedbackTimer.current = window.setTimeout(() => setActive(false), 700);
  };
  useEffect(() => {
    feedback();
    return () => window.clearTimeout(feedbackTimer.current);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReducedMotion(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return (
    <MetalButton
      {...props}
      className={`outreach-primary ${className}`}
      metalFxClassName="invitation-metal"
      preset="silver"
      theme="dark"
      strength={0.35}
      borderRadius={10}
      disableGlow
      paused={reducedMotion || busy || disabled || !active}
      onPointerEnter={(event) => {
        feedback();
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        feedback();
        onFocus?.(event);
      }}
      disabled={busy || disabled}
    >
      <span className="primary-caption">
        <span className="primary-caption-reserve" aria-hidden="true">
          {label}
        </span>
        <span className="primary-caption-reserve" aria-hidden="true">
          {busyLabel}
        </span>
        <span className="primary-caption-current">{busy ? busyLabel : label}</span>
      </span>
      <span aria-hidden="true">{children || '→'}</span>
    </MetalButton>
  );
}
