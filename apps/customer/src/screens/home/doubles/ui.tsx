// TODO(B1): remove double. Stand-ins for the packages/ui components named in UI-SPEC §4.1.
// Props here are this screen's assumption; adjust deps.ts when B1's real props land.
import type { ReactNode } from 'react';
import './ui.css';
import { InfoIcon } from './icons';
import type { Direction } from './format';

export { Sparkline } from './sparkline';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 28 | 32 | 40 | 48;
  /** Renders a link (the app navigates with plain anchors). */
  href?: string;
  onClick?: () => void;
  children: ReactNode;
  'aria-label'?: string;
}
export function Button({ variant = 'secondary', size = 40, href, onClick, children, ...rest }: ButtonProps) {
  const className = `if-btn if-btn--${variant} if-btn--${size}`;
  return href ? (
    <a className={className} href={href} {...rest}>
      {children}
    </a>
  ) : (
    <button type="button" className={className} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/** Real version: NumberFlow fed this pre-rounded string; static under reduced motion. */
export function HeroNumber({ text, suffix }: { text: string; suffix?: string }) {
  return (
    <span className="if-hero" data-hidden={text.startsWith('\u2022') || undefined}>
      <span data-money>{text}</span>
      {suffix ? <span className="if-hero__suffix">{` ${suffix}`}</span> : null}
    </span>
  );
}

/** A figure with `data-money`; shows "••••" when balances are hidden. */
export function Money({ text, hidden, className }: { text: string; hidden?: boolean; className?: string }) {
  return (
    <span className={className} data-money>
      {hidden ? '••••' : text}
    </span>
  );
}

const glyph: Record<Direction, string> = { up: '▲', down: '▼', flat: '' };

/** Percent with a direction glyph; sign is never only colour. */
export function Pct({ text, direction, className }: { text: string; direction: Direction; className?: string }) {
  return (
    <span className={`if-delta if-delta--${direction}${className ? ` ${className}` : ''}`}>
      {glyph[direction] ? <span aria-hidden="true">{glyph[direction]}</span> : null}
      <span data-money>{text}</span>
    </span>
  );
}

/** "▲ +$134.46 (+4.02%)": amount hides with balances, percent stays. */
export function ChangeText({
  amountText,
  pctText,
  direction,
  hideAmount,
}: {
  amountText: string;
  pctText: string;
  direction: Direction;
  hideAmount?: boolean;
}) {
  return (
    <span className={`if-delta if-delta--${direction}`}>
      {glyph[direction] ? <span aria-hidden="true">{glyph[direction]}</span> : null}
      <Money text={amountText} hidden={hideAmount} />
      <span>
        (<span data-money>{pctText}</span>)
      </span>
    </span>
  );
}

/** Round lettered fallback, as B1's CoinIcon falls back for assets without a drawing. */
export function CoinIcon({ asset, size = 28 }: { asset: string; size?: number }) {
  return (
    <span className="if-coin" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {asset.slice(0, 1)}
    </span>
  );
}

export function Skeleton({
  width,
  height,
  radius,
  className,
}: {
  width: number | string;
  height: number;
  radius?: number;
  className?: string;
}) {
  return (
    <span className={`if-skel${className ? ` ${className}` : ''}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />
  );
}

export interface StateBlockProps {
  title: string;
  body?: string;
  /** Support code, shown small. */
  code?: string;
  action?: { label: string; onClick?: () => void; href?: string };
}
export function StateBlock({ title, body, code, action }: StateBlockProps) {
  return (
    <div className="if-state" role="status">
      <p className="if-state__title">{title}</p>
      {body ? <p className="if-state__body">{body}</p> : null}
      {code ? <p className="if-state__code">{code}</p> : null}
      {action ? (
        <Button variant="secondary" size={32} href={action.href} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Hover tooltip. The text is always in the DOM for assistive tech. The trigger is deliberately not a
 * tab stop so the keyboard order stays eye -> actions -> rows (UI-SPEC §5.1 Acceptance).
 */
export function InfoTip({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
  return (
    <span className="if-tip" data-tip-text={text}>
      {children ?? <InfoIcon width={16} height={16} />}
      <span className="if-sr">
        {label}: {text}
      </span>
      <span className="if-tip__bubble" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
