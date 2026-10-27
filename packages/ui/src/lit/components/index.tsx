/**
 * Lit glass component sheet (B1). Every component reads only `--lit-*` roles through `components.css`; names and
 * meanings are in `../contracts.ts`. Components marked (B2) in the contracts are built by the templates lane in
 * their own files beside this one.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { BrandLockup, BrandMark, BrandWordmark } from '../../brand/brand.js';
import { doors as doorOrder, type Door, type GateReason, type LegalSlotProps, type Refusal } from '../contracts.js';

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
      data-slot="button"
      data-variant={tone === 'quiet' ? 'ghost' : tone}
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

export function Switch({ checked, onChange, label, className, onClick, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={rest['aria-label'] ?? label}
      className={clsx('lit-switch', className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onChange(!checked);
      }}
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
  const describedBy =
    [rest['aria-describedby'], hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('lit-field-control', className)}>
      <label htmlFor={inputId}>{label}</label>
      <input {...rest} id={inputId} aria-invalid={error ? true : rest['aria-invalid']} aria-describedby={describedBy} />
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

/** A typed part of a formatted number (packages/i18n `formatMoneyToParts` and friends return these). */
export type FigurePart = { readonly type: string; readonly value: string };

export type FigureProps = {
  /** From packages/i18n's *ToParts formatters, from a decimal string; never a number. Locale order is kept. */
  parts: readonly FigurePart[];
  size?: 'hero' | 'figure' | 'body';
  /** Illustrative figure: shows the TEST label. */
  test?: boolean;
  /** Older than its freshness limit: shows its age in words, never hidden. */
  stale?: string;
  className?: string;
};

const partClass = (t: string) =>
  t === 'currency' || t === 'unit' ? 'lit-figure__unit' : t === 'decimal' || t === 'fraction' ? 'lit-figure__minor' : undefined;

/** A money figure: the unit and the minor part drawn quieter, read aloud as one value. The number is always left to right, also on a right-to-left page; its marks follow the page. */
export function Figure({ parts, size = 'figure', test, stale, className }: FigureProps) {
  return (
    <span className={clsx('lit-figure', className)} data-slot="money" data-size={size}>
      <span className="lit-sr" dir="ltr" data-ltr="">
        {parts.map((p) => p.value).join('')}
      </span>
      <span aria-hidden="true" dir="ltr" data-ltr="">
        {parts.map((p, i) => (
          <span key={i} className={partClass(p.type)}>
            {p.value}
          </span>
        ))}
      </span>
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

export type ChangeProps = {
  text: string;
  dir: 'up' | 'down' | 'flat';
  /** The direction in the reader's language ("up", "down", "no change"), from the i18n catalogue. */
  spoken: string;
  className?: string;
};

/** Up or down as words and an arrow, never colour alone. The figures are left to right on any page. */
export function Change({ text, dir, spoken, className }: ChangeProps) {
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  return (
    <span className={clsx('lit-change', className)} data-dir={dir}>
      {arrow && <span aria-hidden="true">{arrow} </span>}
      <span className="lit-sr">{spoken} </span>
      <span dir="ltr" data-ltr="">
        {text}
      </span>
    </span>
  );
}

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
          <a className="lit-button" data-slot="button" data-variant="ghost" data-tone="quiet" href={refusal.action.href}>
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

function DoorLinks({ links, current }: { links: readonly DoorLink[]; current: Door }) {
  return orderedDoors(links).map((l) => (
    <a key={l.door} className="lit-door" href={l.href} aria-current={l.door === current ? 'page' : undefined}>
      <span aria-hidden="true">{l.icon}</span>
      {l.label}
    </a>
  ));
}

export function Dock({ links, current, label }: { links: readonly DoorLink[]; current: Door; label: string }) {
  return (
    <nav aria-label={label}>
      <Surface layer="nav" className="lit-dock">
        <DoorLinks links={links} current={current} />
      </Surface>
    </nav>
  );
}

export function Rail({
  links,
  current,
  brand,
  footer,
  label,
}: {
  links: readonly DoorLink[];
  current: Door;
  brand?: React.ReactNode;
  footer?: React.ReactNode;
  label: string;
}) {
  return (
    <nav aria-label={label}>
      <Surface layer="nav" className="lit-rail">
        {brand}
        <DoorLinks links={links} current={current} />
        {footer}
      </Surface>
    </nav>
  );
}

/**
 * The brand in the new look: the mark, the wordmark or the horizontal lockup, drawn by the one brand set
 * (`../../brand/brand.tsx`, from the kit's files). `size` is the mark's height in pixels; it picks the kit's optical
 * drawing. `lit` adds the accent glow.
 */
export function Logo({
  variant = 'lockup',
  lit,
  size = 24,
  className,
}: {
  variant?: 'mark' | 'wordmark' | 'lockup';
  lit?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span className={clsx('lit-logo', className)} data-lit={lit || undefined}>
      {variant === 'mark' ? (
        <BrandMark size={size} title="INTAFACED" />
      ) : variant === 'wordmark' ? (
        <BrandWordmark width={Math.max(150, size * 6.25)} title="INTAFACED" />
      ) : (
        <BrandLockup size={size} title="INTAFACED" />
      )}
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

/** The page root for lit rooms: type, colour and the focus ring. Pair it with data-look="lit" on :root. */
export const Root = ({ className, ...rest }: Div) => <div {...rest} className={clsx('lit-root', className)} />;

/**
 * One legal slot. The kit holds no copy: the caller resolves `textId` from the legal text registry for the
 * reader's language and passes `text`, `label` and, when the text is unset, `missing` (a designed refusal in
 * words). The id stays in a data attribute, never on screen.
 */
export function LegalSlot({
  type,
  moment,
  jurisdiction,
  textId,
  text,
  label,
  missing,
  learnMore,
  bold,
  lang,
  dir,
  className,
}: LegalSlotProps & {
  text: string | null;
  /** The rule sets the warning in bold (the risk band). */
  bold?: boolean;
  /** Language and direction of the fixed text and its link, set on the whole band, so English kept in a right-to-left page keeps its punctuation and its start edge. */
  lang?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  /** Accessible name of the region, for example "Risk warning". */
  label: string;
  /** Shown when `text` is null: the refusal in words. */
  missing: string;
  learnMore?: { label: string; onOpen: () => void };
  className?: string;
}) {
  return (
    <div
      className={clsx('lit-legal', className)}
      data-type={type}
      data-moment={moment}
      data-jurisdiction={jurisdiction}
      data-text-id={textId}
      data-missing={text ? undefined : true}
      data-bold={bold || undefined}
      lang={text ? lang : undefined}
      dir={text ? dir : undefined}
      role="region"
      aria-label={label}
    >
      {text ? <span data-part="text">{text}</span> : missing}
      {text && learnMore && (
        <>
          {' '}
          <button type="button" className="lit-legal__more" onClick={learnMore.onOpen}>
            {learnMore.label}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * First-buy risk moment: an overlay whose two choices carry equal weight. No 3D, no glow on either. Focus moving
 * in and staying inside, and Escape, belong to the host (templates lane) until the kit has a dialog primitive.
 */
export function RiskMoment({
  title,
  children,
  proceed,
  leave,
  className,
}: {
  title: string;
  children: React.ReactNode;
  proceed: { label: string; onChoose: () => void };
  leave: { label: string; onChoose: () => void };
  className?: string;
}) {
  const titleId = React.useId();
  return (
    <div className="lit-moment-scrim">
      <Surface layer="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} className={clsx('lit-moment', className)}>
        <div id={titleId} data-part="title">
          {title}
        </div>
        <div>{children}</div>
        <div data-part="choices">
          <Button tone="secondary" onClick={leave.onChoose}>
            {leave.label}
          </Button>
          <Button tone="secondary" onClick={proceed.onChoose}>
            {proceed.label}
          </Button>
        </div>
      </Surface>
    </div>
  );
}

/**
 * The gated state. Not a skeleton: the room's real layout stays visible under the veil and inert, and the gate
 * card (an opaque panel, so its text never sits on the room) says who it is gated on and the one next step. The
 * room, veil and card share one grid cell, so a short room grows to fit the card.
 */
export function Gate({
  reason,
  title,
  body,
  action,
  children,
  className,
}: {
  reason: GateReason;
  title: string;
  body: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const titleId = React.useId();
  return (
    <div className={clsx('lit-gate', className)} data-gate={reason}>
      <Surface className="lit-gate__card" role="region" aria-labelledby={titleId}>
        <div id={titleId} data-part="title">
          {title}
        </div>
        <div data-part="body">{body}</div>
        {action}
      </Surface>
      <div className="lit-gate__room" inert>
        {children}
      </div>
    </div>
  );
}
