import { MoneyError, parseAmount, formatAmount } from '@intafaced/ledger-client';
import { FLEET_HARD_MONEY_WRITE_TOOLS, PRODUCT_AGENT_IDS } from '../fleet/guardrails.js';

/**
 * AGENTS A PERSON BUILDS (AG-builder-01).
 *
 * A person's own agent starts from a template and may only use tools from the
 * addable catalogue below: read tools the product agents already declare, each
 * with the module it reads. Tools that move money are listed too, so the
 * builder can offer them and say why they are refused, and are never stored on
 * a draft. A blank spend cap stays blank: it blocks publishing and refuses a
 * session, it is never filled in.
 */

/**
 * `module` is the module a tool reads, shown to the person; a money tool's is never granted. `shape` is the tool's
 * declared input and output (AG-tools-01), copied from the route that serves it, and `refusals` the reasons that route
 * can answer instead; null is a tool whose shape is not declared, which a person's agent cannot attach.
 */
export type OwnTool = {
  readonly name: string;
  readonly module: string;
  readonly movesMoney: boolean;
  readonly shape: { readonly input: Readonly<Record<string, string>>; readonly output: Readonly<Record<string, string>> } | null;
  readonly refusals: readonly string[];
};

/** Refusals every data tool route can answer, beside its own. */
const TIER_REFUSALS = ['tool_not_declared', 'tool_not_in_tier', 'tier_law_blank', 'tier_not_granted'] as const;

/** Each tool's shape from its route's input and output schema (router.ts and the module's data-tools.ts). */
const READ_TOOLS: readonly OwnTool[] = [
  {
    // router.ts support desk data tools; support-agent/data-tools.ts searchKb
    name: 'support.kb.search',
    module: 'support',
    movesMoney: false,
    shape: {
      input: { limit: 'whole number from 1 to 500, optional' },
      output: { articles: 'list of { articleKey, titleKey, bodyKey }' },
    },
    refusals: [
      'no_live_kb',
      'kb_empty',
      'empty_results',
      'incomplete_article',
      'kb_search_limit_unset',
      'missing_requester',
      'desk_plane_dark',
      ...TIER_REFUSALS,
    ],
  },
  {
    // support-agent/data-tools.ts readTicket
    name: 'support.ticket.read',
    module: 'support',
    movesMoney: false,
    shape: {
      input: { ticketId: 'text, up to 120 characters' },
      output: { ticket: '{ ticketId, ownerUserId, status, category }' },
    },
    refusals: ['missing_fixture', 'incomplete_ticket', 'not_ticket_owner', 'no_live_kb', 'missing_requester', 'tool_not_in_tier'],
  },
  {
    // support-agent/data-tools.ts readAccount: never a balance
    name: 'identity.account.read',
    module: 'identity',
    movesMoney: false,
    shape: {
      input: { userId: 'text' },
      output: { account: '{ userId, status: active, frozen or closed, kycTier }' },
    },
    refusals: [
      'no_live_kb',
      'account_plane_dark',
      'incomplete_account',
      'account_owner_mismatch',
      'missing_fixture',
      'balance_field_forbidden',
    ],
  },
  {
    // navigator/data-tools.ts quote
    name: 'trade.quote',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', last: 'decimal string', asOf: 'time' },
    },
    refusals: ['trade_plane_dark', 'money_write', 'missing_fixture', 'incomplete_quote', 'invalid_decimal', 'stale', ...TIER_REFUSALS],
  },
  {
    // navigator and scanner data-tools.ts listMarkets
    name: 'trade.markets.list',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { limit: 'whole number from 1 to 500, optional' },
      output: { markets: 'list of { marketId, symbol, status: open, halted or closed }' },
    },
    refusals: ['empty_markets', 'missing_fixture', 'markets_limit_unset', 'money_write', ...TIER_REFUSALS],
  },
  {
    // scanner/data-tools.ts ticker
    name: 'trade.ticker',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', last: 'decimal string', volume24h: 'decimal string', change24hBps: 'whole number', asOf: 'time' },
    },
    refusals: ['market_plane_dark', 'missing_fixture', 'incomplete_ticker', 'invalid_decimal', 'stale', 'money_write', ...TIER_REFUSALS],
  },
  {
    // scanner/data-tools.ts bookTop
    name: 'trade.book.top',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', bid: 'decimal string', ask: 'decimal string', asOf: 'time' },
    },
    refusals: ['market_plane_dark', 'missing_fixture', 'incomplete_book', 'invalid_decimal', 'stale', 'money_write', ...TIER_REFUSALS],
  },
  // An in-process runner tool of the merchant watch (merchant/session-run.ts), with no route and so no declared shape.
  {
    name: 'pay.metrics.read',
    module: 'pay',
    movesMoney: false,
    shape: null,
    refusals: ['pay_plane_dark', 'no_live_metrics', 'stale', 'no_metrics'],
  },
];

/** Offered so the refusal has a reason to show; `ledger.transfer` is how a person asks for one. */
const MONEY_TOOLS: readonly OwnTool[] = [
  { name: 'ledger.transfer', module: 'ledger', movesMoney: true, shape: null, refusals: [] },
  ...FLEET_HARD_MONEY_WRITE_TOOLS.map((name) => ({ name, module: name.split('.')[0]!, movesMoney: true, shape: null, refusals: [] })),
];

export const OWN_TOOLS: readonly OwnTool[] = [...READ_TOOLS, ...MONEY_TOOLS];

export const OWN_TEMPLATES = {
  'service-starter': { tools: ['support.kb.search', 'support.ticket.read', 'identity.account.read'] },
  blank: { tools: [] },
} as const satisfies Record<string, { tools: readonly string[] }>;
export type OwnTemplate = keyof typeof OWN_TEMPLATES;
export const OWN_TEMPLATE_IDS = Object.keys(OWN_TEMPLATES) as OwnTemplate[];

/**
 * The templates offered to a person, from `AGENTS_OWN_TEMPLATES` (AG-catalogue-02): a comma-separated list of template
 * ids. Unset or blank offers every built-in template. `blank` is always offered, so "Start blank" is never taken away and a list
 * of just `blank` offers nothing else. An id that is not a template stops the service at boot, never at a call.
 */
export function parseOwnTemplates(value: string | undefined): readonly OwnTemplate[] {
  const ids = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return OWN_TEMPLATE_IDS;
  for (const id of ids) {
    if (!OWN_TEMPLATE_IDS.includes(id as OwnTemplate)) throw new Error(`AGENTS_OWN_TEMPLATES names an unknown template: ${id}`);
  }
  return OWN_TEMPLATE_IDS.filter((id) => id === 'blank' || ids.includes(id));
}

/** Words the Agents room uses in its own addresses, and the product agents' ids, are not names a person may take. */
export const RESERVED_NAMES: readonly string[] = [
  'new',
  'sessions',
  'catalogue',
  'activity',
  'coach',
  'campaigns',
  'limits',
  'usage',
  ...PRODUCT_AGENT_IDS,
];

export const NAME_MAX = 64;
export const INSTRUCTIONS_MAX = 4000;
/** How many agents one person may keep; a create past it refuses rather than filling the table. */
export const OWN_AGENTS_MAX = 50;
/** Postgres cannot store a NUL in text, so it refuses here with its reason instead of failing the write. */
const NUL = /\u0000/;

export type OwnRefusalCode =
  | 'agents.own.money_tool'
  | 'agents.tool_shape_missing'
  | 'agents.own.tool_unknown'
  | 'agents.own.reserved_name'
  | 'agents.own.name_too_long'
  | 'agents.own.instructions_too_long'
  | 'agents.own.cap_invalid'
  | 'agents.own.template_unknown'
  | 'agents.own.not_found'
  | 'agents.own.text_invalid'
  | 'agents.own.too_many'
  | 'agents.spend.cap_unset'
  | 'agents.spend.above_agent_cap'
  | 'agents.spend.per_call_above_session'
  | 'agents.usage.limit_invalid'
  | 'agents.usage.alert_above_limit';

export class OwnAgentRefusal extends Error {
  constructor(
    readonly code: OwnRefusalCode,
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = 'OwnAgentRefusal';
  }
}

export type DraftInput = {
  readonly name: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  /** Blank or absent is unset, never zero and never a default. */
  readonly perSessionCap: string | null | undefined;
};
export type DraftFields = { name: string; instructions: string; tools: string[]; perSessionCap: string | null };

/** Checks a draft as the person wrote it; refuses the first thing it cannot store, with its reason. */
export function validateDraft(input: DraftInput): DraftFields {
  if (NUL.test(input.name) || NUL.test(input.instructions)) throw new OwnAgentRefusal('agents.own.text_invalid');
  const name = input.name.trim();
  if (name.length > NAME_MAX) throw new OwnAgentRefusal('agents.own.name_too_long', { limit: String(NAME_MAX) });
  if (RESERVED_NAMES.includes(name.toLowerCase())) throw new OwnAgentRefusal('agents.own.reserved_name', { name });
  if (input.instructions.length > INSTRUCTIONS_MAX)
    throw new OwnAgentRefusal('agents.own.instructions_too_long', { limit: String(INSTRUCTIONS_MAX) });
  const tools: string[] = [];
  for (const raw of input.tools) {
    const tool = OWN_TOOLS.find((entry) => entry.name === raw.trim());
    if (!tool) throw new OwnAgentRefusal('agents.own.tool_unknown', { tool: raw });
    if (tool.movesMoney) throw new OwnAgentRefusal('agents.own.money_tool', { tool: tool.name });
    // A tool with no declared shape is never attached on a guess (AG-tools-01).
    if (!tool.shape) throw new OwnAgentRefusal('agents.tool_shape_missing', { tool: tool.name });
    if (!tools.includes(tool.name)) tools.push(tool.name);
  }
  return { name, instructions: input.instructions, tools, perSessionCap: parseCap(input.perSessionCap) };
}

function parseCap(cap: string | null | undefined): string | null {
  const text = cap?.trim() ?? '';
  if (!text) return null;
  try {
    const amount = parseAmount(text);
    if (amount <= 0n) throw new OwnAgentRefusal('agents.own.cap_invalid');
    return formatAmount(amount);
  } catch (err) {
    if (err instanceof MoneyError) throw new OwnAgentRefusal('agents.own.cap_invalid');
    throw err;
  }
}

export type Finding = { readonly code: 'agents.spend.cap_unset' | 'agents.own.name_unset'; readonly blocksPublishing: boolean };

/** What stops this draft being published. A blank cap is the person's to set; nothing fills it in. */
export function protectionFindings(fields: Pick<DraftFields, 'name' | 'perSessionCap'>): Finding[] {
  const findings: Finding[] = [];
  if (fields.perSessionCap === null) findings.push({ code: 'agents.spend.cap_unset', blocksPublishing: true });
  if (!fields.name) findings.push({ code: 'agents.own.name_unset', blocksPublishing: true });
  return findings;
}
