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

/** `module` is the module a tool reads, shown to the person; a money tool's is never granted. */
export type OwnTool = { readonly name: string; readonly module: string; readonly movesMoney: boolean };

const READ_TOOLS: readonly OwnTool[] = [
  { name: 'support.kb.search', module: 'support', movesMoney: false },
  { name: 'support.ticket.read', module: 'support', movesMoney: false },
  { name: 'identity.account.read', module: 'identity', movesMoney: false },
  { name: 'trade.quote', module: 'trade', movesMoney: false },
  { name: 'trade.markets.list', module: 'trade', movesMoney: false },
  { name: 'trade.ticker', module: 'trade', movesMoney: false },
  { name: 'trade.book.top', module: 'trade', movesMoney: false },
  { name: 'pay.metrics.read', module: 'pay', movesMoney: false },
];

/** Offered so the refusal has a reason to show; `ledger.transfer` is how a person asks for one. */
const MONEY_TOOLS: readonly OwnTool[] = [
  { name: 'ledger.transfer', module: 'ledger', movesMoney: true },
  ...FLEET_HARD_MONEY_WRITE_TOOLS.map((name) => ({ name, module: name.split('.')[0]!, movesMoney: true })),
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
