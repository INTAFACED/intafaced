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

/** `data-accent` on the root. Blue is the default (owner decision, 26 Oct 2026); the others are a switch. */
export const accents = ['blue', 'ember', 'violet', 'emerald'] as const;
export type Accent = (typeof accents)[number];
export const defaultAccent: Accent = 'blue';

/**
 * `data-surfaces` on the root. `solid` replaces every glass and translucent surface with an opaque one and
 * turns blur off. It is the in-app switch for people who need it (Safari never exposes Reduce Transparency to
 * the web) and is also on whenever `prefers-contrast: more`, `forced-colors: active` or `prefers-reduced-transparency: reduce`
 * matches.
 */
export const surfaceModes = ['glass', 'solid'] as const;
export type SurfaceMode = (typeof surfaceModes)[number];

/** `data-theme` on the root, as the app already uses it. Dark ships; light values exist and are tested. */
export const schemes = ['dark', 'light'] as const;
export type Scheme = (typeof schemes)[number];

/** Simple is the default for everyone; Pro is the switch that turns on the trading desk. */
export const modes = ['simple', 'pro'] as const;
export type Mode = (typeof modes)[number];

/**
 * Image roles (`field`, `glass-bg`, `primary-bg`, `secondary-bg`, `key-bg`, `key-lit-bg`) hold a colour in the
 * flat skin and a gradient in the lit skin, so they are only ever used with the `background` shorthand. Every
 * other colour role is a plain colour in every skin. Shadow roles are `box-shadow` values.
 *
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
  'accent-fill': 'Fill of a lit door or selected segment: the light, deep enough to carry text (top of its gradient)',
  'accent-fill-2': 'Bottom of the lit fill gradient',
  'on-accent': "Text on accent-fill; meets 4.5:1 at the fill's lightest point",

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
  'solid-rim': 'Rim colour on the side the light comes from (components draw the gradient toward solid-rim-dim)',
  'solid-rim-dim': 'Rim colour on the side away from the light',
  'solid-wall': 'The visible wall under a panel (thickness)',
  'solid-shadow': 'Drop shadow stack under a panel',
  sheen: 'Top highlight laid over a solid panel (a background layer)',
  'fill-shadow': 'Highlight, drop and glow of a lit fill (selected segment, current door)',
  'corner-glow': 'Colour of the light pooling in a tile corner (components place it; `transparent` when flat)',
  'glass-bg': 'Nav and sheet layers only: translucent body',
  'glass-blur': 'backdrop-filter value for nav and sheet; `none` in solid mode',
  'glass-rim': 'Rim colour of a glass layer on the lit side',
  'glass-rim-dim': 'Rim colour of a glass layer away from the light',
  'glass-shadow': 'Shadow stack of a glass layer',
  scrim: 'Behind a sheet or dialog',
  veil: 'Dims what sits behind a sheet or dialog; a gated room is never veiled, its withheld bodies keep their space and show nothing',

  // Controls. One primary per view.
  'primary-bg': 'The one primary button (metal pill). Image role: use with the `background` shorthand only',
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
  'status-pending': 'Money pending, as text or icon; meets 4.5:1',
  'status-failed': 'Money failed, as text or icon; meets 4.5:1',
  'status-done': 'Money done, as text or icon; meets 4.5:1',
  'status-unknown': 'Money status unknown ("We are checking"), as text or icon; meets 4.5:1',
  'status-stale': 'A figure older than its freshness limit, as text; meets 4.5:1',

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

/** Every room is built from one of these (the room inventory, 26 Oct 2026). */
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
 * The states every template draws (the room inventory's states). The warning band is not a state: it is the
 * fixed `legal` slot on every template. The first-buy warning is a risk moment (an overlay), not a state.
 */
export const templateStates = ['ready', 'loading', 'empty', 'refused', 'gated', 'money-status', 'confirm', 'receipt'] as const;
export type TemplateState = (typeof templateStates)[number];

/** Money status, with the ledger as the source of truth. */
export type MoneyStatus = 'pending' | 'failed' | 'done' | 'unknown';

/** Who a room is gated on. The gated state keeps the room's layout visible behind the gate. */
export type GateReason = 'signed-out' | 'not-verified' | 'no-business-account' | 'region';

/**
 * A refusal, in the app's own shape (`refusalCopy()` in apps/customer/src/data/refusals.ts), so a room passes it
 * straight in: the blocker in words, the typed code only as a small reference. The variant decides the design:
 * an account hold (svc-identity) and a platform-wide posting pause (svc-ledger) are worded and drawn apart.
 */
export type RefusalVariant = 'parked' | 'refused' | 'unreachable' | 'account-hold' | 'platform-pause';
export interface Refusal {
  variant: RefusalVariant;
  title: string;
  body: string;
  /** The typed code, shown small. */
  reference?: string;
  /** One next step, when there is one ("Try again" for unreachable). */
  action?: { label: string; href: string };
}

/** Jurisdictions a legal slot can serve. Which ones the product serves is an open owner question. */
export type Jurisdiction = 'uk' | 'eu' | 'unset';

/**
 * Legal slot types (the legal and trust rules' slot types). What a slot is for is its `moment`
 * (for example `crypto-risk-band`, `first-buy`, `scam-stop`, `payee-check`, `cooling-off`, `credit-band`,
 * `mica-marketing`, `withdrawal-button`, `talk-to-a-person`, `regulated-status`); the registry in
 * `./templates/` holds the exact texts. Text comes only from the registry, never from a room.
 */
export type LegalSlotType =
  'risk-band' | 'popup' | 'disclosure' | 'legal-link' | 'equal-choice' | 'timer' | 'gate' | 'consent' | 'result' | 'button';

export interface LegalSlotProps {
  type: LegalSlotType;
  moment: string;
  /** `unset` while the market is an open owner question: market-dependent slots render the designed "wording missing" refusal. */
  jurisdiction: Jurisdiction;
  /** Registry key for the exact text. A slot whose text isn't settled for the market renders a designed refusal. */
  textId: string;
}

/** Slots each template exposes. `legal` is on every template and always renders first, above everything. */
/** `notices` (account hold, platform pause, incident) and `in-flight` (the shared receipt lane) are on every template. */
export const templateSlots = {
  reading: ['legal', 'notices', 'header', 'toc', 'body', 'aside', 'contact', 'in-flight'],
  overview: ['legal', 'notices', 'header', 'hero', 'actions', 'needs-you', 'rooms', 'sections', 'in-flight'],
  'record-list': ['legal', 'notices', 'header', 'filters', 'summary', 'table', 'detail', 'export', 'in-flight'],
  monitor: ['legal', 'notices', 'header', 'figures', 'panels', 'charts', 'explain', 'in-flight'],
  flow: ['legal', 'notices', 'header', 'steps', 'form', 'summary', 'review', 'scam-warning', 'actions', 'receipt', 'in-flight'],
  settings: ['legal', 'notices', 'header', 'index', 'sections', 'explain', 'in-flight'],
  catalogue: ['legal', 'notices', 'header', 'featured', 'filters', 'grid', 'item', 'in-flight'],
  desk: ['legal', 'notices', 'instrument', 'pairs', 'chart', 'book', 'tape', 'ticket', 'orders', 'positions', 'in-flight'],
} as const satisfies Record<TemplateId, readonly string[]>;
export type TemplateSlot<T extends TemplateId> = (typeof templateSlots)[T][number];

/** Props every template takes besides its slots. */
export interface TemplateBase {
  state: TemplateState;
  refusal?: Refusal;
  gate?: GateReason;
  moneyStatus?: MoneyStatus;
  /** Prices or balances older than their freshness limit: shown, marked stale with their age, never hidden. */
  stale?: { asOf: string };
  /** Part of the data is missing (for example crypto prices down): totals never include an unknown part. */
  partial?: { missing: Refusal };
  mode?: Mode;
  legal?: readonly LegalSlotProps[];
}

/**
 * Templates lay out by their own width (container queries), not the viewport. Below `compact` is a phone
 * column; from `expanded` the computer layout. Container queries can't read custom properties, so these are
 * constants, not tokens.
 */
export const containerWidths = { compact: 600, expanded: 1024 } as const;

/**
 * Component names the kit exports from `@intafaced/ui/lit` (APIs in `./components/`). Builders: B1 owns the
 * sheet; B2 builds the ones marked (B2) in `./components/` files it owns, because templates need them first.
 */
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
  Gate: "The gated state: the gate card in the flow at the top, then the room's layout, inert, with names and disabled controls readable and withheld bodies (data-withheld) kept blank",
  RefusalBox: 'Refused or parked, naming the blocker',
  EmptyState: 'Empty with one next step',
  Dock: 'Phone navigation: floating pill, five doors, always fully visible',
  Rail: 'Computer navigation: five doors on the slab',
  Logo: 'Mark, wordmark or lockup from one vector path; the brand kit swaps the path',
  Stage: 'Host for a 3D object (from ./fx), with poster first and a flat tier; never on confirm or review',
  EqualChoice: '(B2) Two or more choices of equal weight: cooling-off, payee check, scam stop',
  Table: '(B2) Table with a phone row form (rows become stacked cards under compact)',
  Sheet: '(B2) Bottom sheet on phone, side sheet on computer; a glass layer',
  Stepper: '(B2) Steps of a flow',
  Skeleton: '(B2) Loading placeholder shaped like the content, never a flash of "no records"',
  KeyValue: '(B2) Label and value rows (review, receipt, details)',
  StatusChip: '(B2) Money status: pending, failed, done, unknown, with words not colour alone',
  Tabs: "(B2) A door's room row",
  LineChart: '(B2) Price or value over time',
  AreaChart: '(B2) Value over time with a lit fill',
  Bars: '(B2) Bars (volume, monthly totals)',
  Parts: '(B2) Parts of a whole that reconcile to the total, with a list fallback',
} as const;
export type ComponentName = keyof typeof components;

/** The five doors, in order. */
export const doors = ['home', 'money', 'trade', 'pay', 'more'] as const;
export type Door = (typeof doors)[number];
