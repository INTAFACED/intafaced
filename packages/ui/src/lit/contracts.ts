/**
 * Lit glass: the frozen contracts every lane builds against.
 *
 * This file names things; it holds no values and no styling. Values live in `./tokens.ts`, components in
 * `./components/`, templates in `./templates/`, the 3D objects in `./fx/`. A name added here goes through the
 * kit's owner (the lit lead); removing or renaming one is a breaking change for every room built on it.
 *
 * The look is scoped: it only applies under `data-look="lit"` on the root element, and only the customer app
 * loads `@intafaced/ui/lit/lit.css`. The founder console (apps/admin) never imports anything under `lit/`
 * (`lit.test.ts` checks that). With the look switched off, the same role tokens resolve to today's skin, so a
 * room moved onto a template shows its new layout in the old colours, flat, never a mix of two skins.
 */

/** The `data-look` value that switches the skin on. */
export const LIT_LOOK = 'lit' as const;

/** `data-accent` on the root. Blue is the default (Nino, 26 Oct 2026); the others are a switch. */
export const accents = ['blue', 'ember', 'violet', 'emerald'] as const;
export type Accent = (typeof accents)[number];
export const defaultAccent: Accent = 'blue';

/**
 * `data-surfaces` on the root. `solid` replaces every glass and translucent surface with an opaque one and
 * turns blur off. It is the in-app switch for people who need it (Safari never exposes Reduce Transparency to
 * the web) and is also on whenever `prefers-contrast: more` or `forced-colors: active` matches.
 */
export const surfaceModes = ['glass', 'solid'] as const;
export type SurfaceMode = (typeof surfaceModes)[number];

/** `data-theme` on the root, as the app already uses it. Dark ships; light values exist and are tested. */
export const schemes = ['dark', 'light'] as const;
export type Scheme = (typeof schemes)[number];

/** Simple is the default for everyone; Pro is the switch that turns on the trading desk (OWNER 74.1). */
export const modes = ['simple', 'pro'] as const;
export type Mode = (typeof modes)[number];

/**
 * Role tokens, emitted as `--lit-<name>`. Every lit component and template reads only these (plus layout
 * values from them); a raw colour, size or shadow in a component is a lint error. Each entry says what the
 * role is for, which is the contract: a later look changes values, never meaning.
 */
export const roles = {
  // Canvas
  page: 'Page background, the darkest tone',
  'page-2': 'Frame around the app slab on a computer; a step above page',
  field: 'The slow field of light behind content (gradient), never behind money text directly',

  // Text, on solid surfaces. Money figures use text-1 only.
  'text-1': 'Primary text and money figures',
  'text-2': 'Secondary text and labels',
  'text-3': 'Tertiary text; still 4.5:1 on solid surfaces',
  'text-disabled': 'Disabled text only; exempt from contrast',
  line: 'Hairline dividers',
  'line-strong': 'Outlines of fields and tables',

  // The light (accent). The accent is used as light, never as fill on large areas.
  accent: 'The light colour: glows, lit keys, active door, focus',
  'accent-hot': 'The hot centre of the light (highlights, sphere core)',
  'accent-deep': 'The deep end of the light (pools, shadows of lit things)',
  'accent-pair': 'The one complementary spark, at most once per screen',
  'accent-text': 'Accent used as text or icon on solid surfaces; meets 4.5:1',
  'on-accent': 'Text on a lit key or lit door',

  // Direction of money
  up: 'Gains: chart lines and fills',
  down: 'Losses: chart lines and fills',
  'up-text': 'Gains as text; meets 4.5:1',
  'down-text': 'Losses as text; meets 4.5:1',

  // Surfaces. Content-layer panels are solid; glass is only for the nav and sheet layers (plan v2 budgets).
  'solid-bg': 'Content-layer panel: opaque, money sits here',
  'solid-bg-raised': 'Raised panel inside a panel (rows, tiles)',
  'solid-bg-sunken': 'Sunken well inside a panel (inputs, tracks)',
  'solid-lip': 'Inset highlight along the top edge of a panel (box-shadow part)',
  'solid-rim': 'Rim gradient of a panel, brighter on the side the light comes from',
  'solid-wall': 'The visible wall under a panel (thickness)',
  'solid-shadow': 'Drop shadow stack under a panel',
  'corner-glow': 'Light pooling in the corner of a tile nearest the light',
  'glass-bg': 'Nav and sheet layers only: translucent body',
  'glass-blur': 'backdrop-filter value for nav and sheet; `none` in solid mode',
  'glass-rim': 'Rim gradient of a glass layer',
  'glass-shadow': 'Shadow stack of a glass layer',
  scrim: 'Behind a sheet or dialog',

  // Controls. One primary per view.
  'primary-bg': 'The one primary button (metal pill)',
  'primary-fg': 'Text on the primary button',
  'primary-shadow': 'Shadow stack of the primary button',
  'secondary-bg': 'Secondary button (dark pill)',
  'secondary-fg': 'Text on the secondary button',
  'secondary-shadow': 'Shadow stack of the secondary button',
  'key-bg': 'Action key (Add, Send, Buy...) at rest',
  'key-shadow': 'Shadow stack of an action key',
  'key-lit-bg': 'The one key that is the light',
  'key-lit-shadow': 'Glow and wall of the lit key',
  'control-bg': 'Input, select, segmented control body',
  'control-rim': 'Their outline at rest',
  'control-rim-active': 'Their outline when focused or selected (not the focus ring)',
  focus: 'Focus ring colour; never the same as a lit or selected state',

  // Fixed slots. Never brand colours, never faded (COBS 4.12A 38R).
  'legal-bg': 'Risk warning band: opaque, neutral',
  'legal-fg': 'Risk warning text',
  'legal-border': 'Risk warning band border',
  'refusal-bg': 'Refused or parked box: neutral, never accent-tinted',
  'refusal-fg': 'Refusal text',
  'refusal-border': 'Refusal border',
  'warn-text': 'A caution as text',
  'error-text': 'An error as text',
  'test-tag-bg': 'The TEST label on illustrative figures',
  'test-tag-fg': 'TEST label text',

  // Type
  'font-ui': 'Interface face',
  'font-mono': 'Fine print, codes, tick scales',
  'font-figure': 'Money figures (tabular numerals)',

  // Shape
  'radius-panel': 'Panels and cards',
  'radius-tile': 'Tiles and rows inside panels',
  'radius-key': 'Action keys',
  'radius-control': 'Inputs and segmented controls',

  // Motion
  ease: 'Default easing',
  'ease-spring': 'Lit things arriving',
  't-quick': 'Hover, press',
  't-base': 'Panels, tabs',
  't-slow': 'Light and glow changes',

  // Density (Simple vs Pro): Pro is denser, not only smaller.
  'gap-section': 'Between sections of a room',
  'gap-item': 'Between items in a list or grid',
  'pad-panel': 'Inside a panel',
  'row-h': 'List and table row height',
  'control-h': 'Control height',

  // Fixed bars, so focus scroll-padding and sticky offsets can read them
  'legal-band-min-h': 'Minimum height of the fixed risk band (it grows with text size; never clipped)',
  'topbar-h': 'Top bar height',
  'dock-h': 'Phone dock height including its float gap',
} as const;

export type Role = keyof typeof roles;
export const roleNames = Object.keys(roles) as Role[];
export const roleVar = (r: Role): string => `--lit-${r}`;

/** Type roles, emitted as `--lit-type-<name>-size|line|weight|tracking`. */
export const typeRoles = {
  hero: 'The one figure a room is about (total balance)',
  figure: 'Secondary money figures',
  title: 'Room title',
  heading: 'Section heading',
  body: 'Running text and list rows; the risk band is never smaller than this',
  label: 'Labels, key captions',
  micro: 'Fine print etched on glass: scales, codes, tags (mono). Never legal text.',
} as const;
export type TypeRole = keyof typeof typeRoles;

/** Every room is built from one of these (ROOM-INVENTORY.md, 26 Oct 2026). */
export const templates = {
  reading: 'Reading and status pages (help, status, docs, fees)',
  overview: 'Balance or business home (home, money, pay)',
  'record-list': 'Filters, table, export (activity, orders, payouts)',
  monitor: 'Key figures, status panels, charts over time',
  flow: 'One task: steps, review, receipt (send, buy, withdraw)',
  settings: 'Sections of switches, limits, keys',
  catalogue: 'Browse products, pick one',
  desk: 'Pro: chart, book, ticket, editor',
} as const;
export type TemplateId = keyof typeof templates;

/**
 * The states every template draws (ROOM-INVENTORY.md "States"). The warning band is not a state: it is the
 * fixed `legal` slot on every template. The first-buy warning is a risk moment (an overlay), not a state.
 */
export const templateStates = ['ready', 'loading', 'empty', 'refused', 'gated', 'money-status', 'confirm', 'receipt'] as const;
export type TemplateState = (typeof templateStates)[number];

/** Money status, with the ledger as the source of truth. */
export type MoneyStatus = 'pending' | 'failed' | 'done';

/** Who a room is gated on. The gated state keeps the room's layout visible behind the gate. */
export type GateReason = 'signed-out' | 'not-verified' | 'no-business-account' | 'region';

/** A refusal: the blocker in words, with the typed code as a small reference (never the code alone). */
export interface Refusal {
  code: string;
  message: string;
  /** One next step, when there is one. */
  action?: { label: string; href: string };
}

/** Jurisdictions a legal slot can serve. Which ones the product serves is an open owner question. */
export type Jurisdiction = 'uk' | 'eu';

/** Legal slot kinds (RULES-AND-TRUST.md section A). Text comes only from the registry, never from a room. */
export type LegalSlotKind =
  | 'crypto-risk-band' // COBS 4.12A: fixed text, top, own border, bold and underlined as marked
  | 'first-buy-warning' // risk moment overlay with equal-weight choices
  | 'scam-stop' // APP scam warning before a payment
  | 'payee-check' // Confirmation of Payee / VoP: match, close match, no match, unavailable
  | 'leverage-warning' // leveraged products
  | 'fee-disclosure';

export interface LegalSlotProps {
  kind: LegalSlotKind;
  jurisdiction: Jurisdiction;
  /** Registry key for the exact text. A slot whose text isn't settled for the market renders a designed refusal. */
  textId: string;
}

/** Slots each template exposes. `legal` is on every template and always renders first, above everything. */
export const templateSlots = {
  reading: ['legal', 'header', 'body', 'aside'],
  overview: ['legal', 'header', 'hero', 'actions', 'sections'],
  'record-list': ['legal', 'header', 'filters', 'summary', 'table', 'export'],
  monitor: ['legal', 'header', 'figures', 'panels', 'charts'],
  flow: ['legal', 'header', 'steps', 'form', 'review', 'receipt'],
  settings: ['legal', 'header', 'sections'],
  catalogue: ['legal', 'header', 'featured', 'filters', 'grid'],
  desk: ['legal', 'instrument', 'chart', 'book', 'ticket', 'positions'],
} as const satisfies Record<TemplateId, readonly string[]>;
export type TemplateSlot<T extends TemplateId> = (typeof templateSlots)[T][number];

/** Props every template takes besides its slots. */
export interface TemplateBase {
  state: TemplateState;
  refusal?: Refusal;
  gate?: GateReason;
  moneyStatus?: MoneyStatus;
  /** Prices or balances older than their freshness limit: shown, marked stale, never hidden. */
  stale?: boolean;
  mode?: Mode;
  legal?: readonly LegalSlotProps[];
}

/** Component names the kit exports from `@intafaced/ui/lit` (APIs in `./components/`). */
export const components = {
  Surface: 'A panel. material solid | raised | corner on the content layer; glass only with layer nav | sheet',
  Button: 'tone primary (metal, one per view) | secondary (dark pill) | quiet',
  ActionKey: 'Icon key with caption (Add, Send, Buy); `lit` for the one key that is the light',
  Switch: 'Glass disc knob toggle',
  Segmented: 'Ranges, Buy/Sell, Simple/Pro',
  Field: 'Input with label, hint and typed error',
  Figure: 'A money figure from a decimal string (never a number), with TEST and stale marks',
  Change: 'Up or down change as text, with sign and arrow, never colour alone',
  FinePrint: 'Mono micro text for codes and scales (never legal text)',
  Tag: 'Chamfered tag',
  Brackets: 'HUD corner brackets around a figure or chart',
  Scale: 'Tick scale',
  Holdings: 'Holdings list: the text equivalent of the sphere, always present',
  LegalSlot: 'Renders a legal slot from the registry',
  RiskMoment: 'First-buy warning overlay, equal-weight choices',
  RefusalBox: 'Refused or parked, naming the blocker',
  EmptyState: 'Empty with one next step',
  Dock: 'Phone navigation: floating pill, five doors, always fully visible',
  Rail: 'Computer navigation: five doors on the slab',
  Logo: 'Mark, wordmark or lockup from one vector path; the brand kit swaps the path',
  Stage: 'Host for a 3D object (from ./fx), with poster first and a flat tier; never on confirm or review',
} as const;
export type ComponentName = keyof typeof components;

/** The five doors, in order (OWNER 74.4). */
export const doors = ['home', 'money', 'trade', 'pay', 'more'] as const;
export type Door = (typeof doors)[number];
