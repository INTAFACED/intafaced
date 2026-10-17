import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { ArrowRight } from './icons';
import { MetalButton } from './metal-button';

/**
 * The label crossfades when it changes (a saved enquiry found after the page has already started). Both labels sit in one
 * grid cell for 300ms, the old one fading out and the new one fading in, so the button never jumps or flashes. A first
 * render, and reduced motion (outreach.css), show the new label at once.
 */
function CrossfadeLabel({ text }: { text: string }) {
  // Derived during render, so the very first frame with the new text already carries the old one: no flash.
  const [state, setState] = useState<{ shown: string; previous: string | null }>({ shown: text, previous: null });
  if (state.shown !== text) setState({ shown: text, previous: state.shown });
  useEffect(() => {
    if (state.previous === null) return;
    const timer = window.setTimeout(() => setState((now) => ({ ...now, previous: null })), 320);
    return () => window.clearTimeout(timer);
  }, [state.previous, state.shown]);
  return (
    <span className="label-crossfade" data-swapping={state.previous !== null || undefined}>
      {state.previous !== null && (
        <span className="label-out" aria-hidden="true">
          {state.previous}
        </span>
      )}
      <span className="label-in" key={text}>
        {text}
      </span>
    </span>
  );
}

/**
 * Welcome-only hero action: the same original Cult/MetalFx treatment as PrimaryMetal, larger
 * (radius 14), inside a soft lime rim and glow that outrank every other control. The inner
 * button owns all semantics; the rim, glow and arrow motion live in outreach.css (`.hero-cta`).
 */
export function HeroMetal({
  label,
  className = '',
  children,
  onPointerEnter,
  onFocus,
  ...props
}: ComponentPropsWithoutRef<'button'> & { label: string }) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [active, setActive] = useState(true);
  const feedbackTimer = useRef<number | undefined>(undefined);
  const feedback = () => {
    window.clearTimeout(feedbackTimer.current);
    setActive(true);
    feedbackTimer.current = window.setTimeout(() => setActive(false), 900);
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
    <span className="hero-cta">
      <MetalButton
        {...props}
        className={`outreach-primary welcome-cta ${className}`}
        metalFxClassName="invitation-metal hero-metal"
        preset="silver"
        theme="dark"
        strength={0.5}
        borderRadius={14}
        disableGlow
        paused={reducedMotion || !active}
        onPointerEnter={(event) => {
          feedback();
          onPointerEnter?.(event);
        }}
        onFocus={(event) => {
          feedback();
          onFocus?.(event);
        }}
      >
        <span className="primary-caption">
          <span className="primary-caption-current">
            <CrossfadeLabel text={label} />
          </span>
        </span>
        <span className="cta-arrow" aria-hidden="true">
          {children || <ArrowRight />}
        </span>
      </MetalButton>
    </span>
  );
}
