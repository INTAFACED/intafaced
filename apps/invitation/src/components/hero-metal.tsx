import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { MetalButton } from './metal-button';

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
          <span className="primary-caption-current">{label}</span>
        </span>
        <span className="cta-arrow" aria-hidden="true">
          {children || '→'}
        </span>
      </MetalButton>
    </span>
  );
}
