/**
 * Lit glass component sheet (B1). Every component reads only `--lit-*` roles through `components.css`; names and
 * meanings are in `../contracts.ts`. Components marked (B2) in the contracts are built by the templates lane in
 * their own files beside this one.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { doors as doorOrder, type Door, type Refusal } from '../contracts.js';

type Div = React.HTMLAttributes<HTMLDivElement>;

/** A panel. Glass only on the nav and sheet layers; the content layer is solid, and money sits there. */
export type SurfaceProps = Div & {
  flush?: boolean;
  lightFrom?: 'top' | 'bottom';
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
} & ({ layer?: 'content'; material?: 'solid' | 'raised' | 'corner' } | { layer: 'nav' | 'sheet'; material?: never });

const cornerXY = {
  'top-left': ['0%', '0%'],
  'top-right': ['100%', '0%'],
  'bottom-left': ['0%', '100%'],
  'bottom-right': ['100%', '100%'],
} as const;

export function Surface({
  layer = 'content',
  material,
  flush,
  lightFrom = 'top',
  corner = 'top-left',
  className,
  style,
  ...rest
}: SurfaceProps) {
  const [x, y] = cornerXY[corner];
  return (
    <div
      {...rest}
      className={clsx('lit-surface', className)}
      data-layer={layer}
      data-material={layer === 'content' ? (material ?? 'solid') : undefined}
      data-flush={flush || undefined}
      style={
        {
          '--lit-light-angle': lightFrom === 'top' ? '0deg' : '180deg',
          '--lit-corner-x': x,
          '--lit-corner-y': y,
          ...style,
        } as React.CSSProperties
      }
    />
  );
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary: the metal pill, one per view. secondary: the dark pill. quiet: text only. */
  tone?: 'primary' | 'secondary' | 'quiet';
  size?: 'md' | 'lg';
  block?: boolean;
};

export function Button({ tone = 'secondary', size = 'md', block, className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={clsx('lit-button', className)}
      data-tone={tone}
      data-size={size}
      data-block={block || undefined}
    />
  );
}

export type ActionKeyProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; label: string; lit?: boolean };

/** Icon key with its caption (Add, Send, Buy). `lit` marks the one key that is the light. */
export function ActionKey({ icon, label, lit, className, type = 'button', ...rest }: ActionKeyProps) {
  return (
    <button {...rest} type={type} className={clsx('lit-key', className)} data-lit={lit || undefined}>
      <span className="lit-key__face" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

export type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
};

export function Switch({ checked, onChange, label, className, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={clsx('lit-switch', className)}
      onClick={() => onChange(!checked)}
    />
  );
}

export type SegmentedProps<T extends string> = {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
};

export function Segmented<T extends string>({ options, value, onChange, label, className }: SegmentedProps<T>) {
  return (
    <div className={clsx('lit-segmented', className)} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string };

export function Field({ label, hint, error, id, className, ...rest }: FieldProps) {
  const auto = React.useId();
  const inputId = id ?? auto;
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('lit-field-control', className)}>
      <label htmlFor={inputId}>{label}</label>
      <input {...rest} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint && (
        <span id={`${inputId}-hint`} data-part="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${inputId}-error`} data-part="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export type FigureProps = {
  /** Already formatted by packages/i18n from a decimal string, e.g. "12,480.36". Never a number. */
  text: string;
  /** Currency symbol or unit, shown small before the figure. */
  unit?: string;
  /** Decimal separator in `text`, so the minor part can be drawn quieter. */
  decimal?: string;
  size?: 'hero' | 'figure' | 'body';
  /** Illustrative figure: shows the TEST label. */
  test?: boolean;
  /** Older than its freshness limit: shows its age in words, never hidden. */
  stale?: string;
  className?: string;
  'aria-label'?: string;
};

export function Figure({ text, unit, decimal = '.', size = 'figure', test, stale, className, ...rest }: FigureProps) {
  const at = text.lastIndexOf(decimal);
  const major = at >= 0 ? text.slice(0, at) : text;
  const minor = at >= 0 ? text.slice(at) : '';
  return (
    <span className={clsx('lit-figure', className)} data-size={size} aria-label={rest['aria-label'] ?? `${unit ?? ''}${text}`}>
      {unit && (
        <span className="lit-figure__unit" aria-hidden="true">
          {unit}
        </span>
      )}
      <span aria-hidden="true">{major}</span>
      {minor && (
        <span className="lit-figure__minor" aria-hidden="true">
          {minor}
        </span>
      )}
      {(test || stale) && (
        <span className="lit-figure__marks">
          {test && <span className="lit-test">TEST</span>}
          {stale && (
            <span className="lit-tag" data-tone="neutral">
              {stale}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export type ChangeProps = { text: string; dir: 'up' | 'down' | 'flat'; className?: string };

/** Up or down as words and an arrow, never colour alone. */
export function Change({ text, dir, className }: ChangeProps) {
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  const word = dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'no change';
  return (
    <span className={clsx('lit-change', className)} data-dir={dir}>
      {arrow && <span aria-hidden="true">{arrow} </span>}
      <span className="sr-only" style={srOnly}>
        {word}{' '}
      </span>
      {text}
    </span>
  );
}

const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

/** Mono fine print for codes and scales. Never legal text. */
export const FinePrint = ({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span {...rest} className={clsx('lit-fine', className)} />
);

export const Tag = ({
  tone,
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: 'accent' | 'up' | 'down' | 'neutral' }) => (
  <span {...rest} className={clsx('lit-tag', className)} data-tone={tone} />
);

export const Brackets = ({ className, ...rest }: Div) => <div {...rest} className={clsx('lit-brackets', className)} />;

export const Scale = ({ className, ...rest }: Div) => <div {...rest} aria-hidden="true" className={clsx('lit-scale', className)} />;

export type Holding = { id: string; name: string; detail?: string; value: React.ReactNode; share: string };

/** The holdings list: always present, the text equivalent of the sphere. Shares must reconcile to the total. */
export function Holdings({ items, label, className }: { items: readonly Holding[]; label: string; className?: string }) {
  return (
    <ul className={clsx('lit-holdings', className)} aria-label={label}>
      {items.map((h) => (
        <li key={h.id}>
          <span data-part="name">
            {h.name}
            {h.detail && <FinePrint style={{ display: 'block' }}>{h.detail}</FinePrint>}
          </span>
          <span data-part="share">{h.share}</span>
          <span>{h.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** A refusal: the blocker in words, the code small, one next step. Neutral, never accent-tinted. */
export function RefusalBox({ refusal, className }: { refusal: Refusal; className?: string }) {
  return (
    <div className={clsx('lit-refusal', className)} data-variant={refusal.variant} role="status">
      <div>
        <div data-part="title">{refusal.title}</div>
        <div data-part="body">{refusal.body}</div>
        {refusal.reference && (
          <FinePrint data-part="reference" style={{ display: 'block' }}>
            {refusal.reference}
          </FinePrint>
        )}
        {refusal.action && (
          <a className="lit-button" data-tone="quiet" href={refusal.action.href}>
            {refusal.action.label}
          </a>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('lit-empty', className)}>
      <div data-part="title">{title}</div>
      {body && <div>{body}</div>}
      {action}
    </div>
  );
}

export type DoorLink = { door: Door; label: string; href: string; icon: React.ReactNode };

/** Five doors in contract order; any door missing from `links` is a programming error, not hidden. */
function orderedDoors(links: readonly DoorLink[]): DoorLink[] {
  return doorOrder.map((d) => {
    const l = links.find((x) => x.door === d);
    if (!l) throw new Error(`navigation is missing the ${d} door`);
    return l;
  });
}

export function Dock({ links, current, label = 'Main' }: { links: readonly DoorLink[]; current: Door; label?: string }) {
  return (
    <nav aria-label={label}>
      <Surface layer="nav" className="lit-dock">
        {orderedDoors(links).map((l) => (
          <a key={l.door} className="lit-door" href={l.href} aria-current={l.door === current ? 'page' : undefined}>
            <span aria-hidden="true">{l.icon}</span>
            {l.label}
          </a>
        ))}
      </Surface>
    </nav>
  );
}

export function Rail({
  links,
  current,
  brand,
  footer,
  label = 'Main',
}: {
  links: readonly DoorLink[];
  current: Door;
  brand?: React.ReactNode;
  footer?: React.ReactNode;
  label?: string;
}) {
  return (
    <Surface layer="nav" className="lit-rail">
      {brand}
      <nav aria-label={label} style={{ display: 'contents' }}>
        {orderedDoors(links).map((l) => (
          <a key={l.door} className="lit-door" href={l.href} aria-current={l.door === current ? 'page' : undefined}>
            <span aria-hidden="true">{l.icon}</span>
            {l.label}
          </a>
        ))}
      </nav>
      {footer}
    </Surface>
  );
}

/**
 * The stand-in mark (three slanted panes, take four's `FX.markPath()`) until the brand kit arrives; the kit swaps
 * this one path. The 3D logo (`./fx`) extrudes the same path. viewBox -1 -1 2 2.
 */
export const MARK_PATH =
  'M-0.560,0.500L-0.340,0.500L-0.321,0.498L-0.305,0.494L-0.291,0.486L-0.279,0.474L-0.270,0.460L-0.263,0.443L0.003,-0.443L0.006,-0.460L0.006,-0.474L0.001,-0.486L-0.009,-0.494L-0.022,-0.498L-0.040,-0.500L-0.260,-0.500L-0.279,-0.498L-0.295,-0.494L-0.309,-0.486L-0.321,-0.474L-0.330,-0.460L-0.337,-0.443L-0.603,0.443L-0.606,0.460L-0.606,0.474L-0.601,0.486L-0.591,0.494L-0.578,0.498L-0.560,0.500ZM-0.100,0.500L0.120,0.500L0.139,0.498L0.155,0.494L0.169,0.486L0.181,0.474L0.190,0.460L0.197,0.442L0.373,-0.162L0.377,-0.180L0.376,-0.194L0.371,-0.206L0.361,-0.214L0.348,-0.218L0.330,-0.220L0.110,-0.220L0.091,-0.218L0.075,-0.214L0.061,-0.206L0.049,-0.194L0.040,-0.180L0.033,-0.162L-0.143,0.442L-0.147,0.460L-0.146,0.474L-0.141,0.486L-0.131,0.494L-0.118,0.498L-0.100,0.500ZM0.360,0.500L0.580,0.500L0.599,0.498L0.615,0.494L0.629,0.486L0.641,0.475L0.651,0.460L0.658,0.443L0.752,0.137L0.756,0.120L0.755,0.105L0.751,0.094L0.741,0.086L0.728,0.082L0.710,0.080L0.490,0.080L0.471,0.082L0.455,0.086L0.441,0.094L0.429,0.105L0.419,0.120L0.412,0.137L0.318,0.443L0.314,0.460L0.315,0.475L0.319,0.486L0.329,0.494L0.342,0.498L0.360,0.500Z';

export function Logo({
  variant = 'lockup',
  lit,
  size = 22,
  className,
}: {
  variant?: 'mark' | 'wordmark' | 'lockup';
  lit?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span className={clsx('lit-logo', className)} data-lit={lit || undefined}>
      {variant !== 'wordmark' && (
        <svg
          width={size}
          height={size}
          viewBox="-1 -1 2 2"
          aria-hidden={variant === 'lockup' ? true : undefined}
          role={variant === 'mark' ? 'img' : undefined}
          aria-label={variant === 'mark' ? 'INTAFACED' : undefined}
        >
          <path d={MARK_PATH} />
        </svg>
      )}
      {variant !== 'mark' && <span>INTAFACED</span>}
    </span>
  );
}

/**
 * Host for a 3D object: the poster renders first and stays as the fallback and the flat tier. The fx lane
 * (`./fx`) mounts the object over it. Never use it on a confirm or review step.
 */
export function Stage({
  poster,
  alt,
  children,
  className,
  style,
}: {
  poster: string;
  alt: string;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={clsx('lit-stage', className)} style={style}>
      <img src={poster} alt={alt} />
      {children}
    </div>
  );
}
