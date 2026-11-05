import type { OwnAgentAssistant, OwnAgentProposal } from '@intafaced/contracts';
import { INSTRUCTIONS_MAX, NAME_MAX, OWN_TOOLS, OwnAgentRefusal, validateDraft } from './catalog.js';

/**
 * Drafting an agent with the assistant (AG-builder-03; J-agents-03 #6). The assistant drafts on the model the owner
 * chose (`AGENTS_OWN_ASSISTANT_MODEL`). Blank: the owner has not chosen, and drafting refuses `owner.decision` while the
 * rest of the builder works. `test-engine` (a test deployment only) is the TEST engine: it drafts by rule from the
 * person's words and calls no model. Any other model has no drafting adapter yet and refuses
 * `agents.assistant.engine_unavailable`, drafting nothing. Every tool a draft offers has passed the validator a save
 * meets; the ones it refused are listed with their codes. A draft is never saved here.
 */

/** The model value that selects the TEST engine. */
export const ASSISTANT_TEST_ENGINE = 'test-engine';

export function assistantEngine(model: string | null | undefined): OwnAgentAssistant['engine'] {
  const value = model?.trim() ?? '';
  if (!value) return null;
  return value === ASSISTANT_TEST_ENGINE ? 'test' : 'live';
}

/** The owner's choice of model is the owner's to make: blank refuses with the owner-decision code. */
export class OwnerDecisionPending extends Error {
  readonly code = 'owner.decision';
  constructor() {
    super('owner.decision');
    this.name = 'OwnerDecisionPending';
  }
}

/** Words that lead the TEST engine to a tool. A money tool is here so the validator's refusal of it shows. */
const TOOL_WORDS: ReadonlyArray<readonly [tool: string, words: readonly string[]]> = [
  ['support.kb.search', ['question', 'questions', 'answer', 'answers', 'help', 'faq', 'article', 'articles']],
  ['support.ticket.read', ['ticket', 'tickets', 'support', 'case', 'cases']],
  ['support.ticket.comment', ['comment', 'reply', 'respond']],
  ['identity.account.read', ['account', 'profile', 'verification', 'kyc']],
  ['trade.markets.list', ['order', 'orders', 'market', 'markets', 'trade', 'trades', 'trading']],
  ['trade.ticker', ['price', 'prices', 'ticker']],
  ['trade.quote', ['quote', 'quotes']],
  ['trade.book.top', ['book', 'depth', 'spread']],
  ['pay.metrics.read', ['payment', 'payments', 'sales', 'merchant', 'revenue']],
  ['ledger.transfer', ['transfer', 'withdraw', 'withdrawal', 'send']],
];

/** The TEST engine: a draft by rule from the person's words. No model is called and nothing is saved. */
export function testEngineDraft(description: string): OwnAgentProposal {
  const text = description.trim();
  if (!text) throw new OwnAgentRefusal('agents.assistant.description_blank');
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  const considered = TOOL_WORDS.filter(([, cues]) => cues.some((cue) => words.has(cue))).map(([tool]) => tool);
  const tools: string[] = [];
  const leftOut: { tool: string; code: string }[] = [];
  for (const tool of considered) {
    if (!OWN_TOOLS.some((entry) => entry.name === tool)) continue;
    try {
      // The same validator a save meets, one tool at a time, so one refused tool does not take the others with it.
      validateDraft({ name: '', instructions: '', tools: [tool], perSessionCap: null });
      tools.push(tool);
    } catch (err) {
      if (!(err instanceof OwnAgentRefusal)) throw err;
      leftOut.push({ tool, code: err.code });
    }
  }
  const full = `TEST draft: ${text.replace(/^TEST:\s*/i, '')}`;
  // A name past the limit is cut at the last whole word that fits.
  const name =
    full.length <= NAME_MAX
      ? full
      : full
          .slice(0, NAME_MAX + 1)
          .replace(/\s+\S*$/, '')
          .trim();
  const instructions = `TEST draft from your description. ${text}`.slice(0, INSTRUCTIONS_MAX);
  // The whole draft passes the validator too, as a save of it would.
  const checked = validateDraft({ name, instructions, tools, perSessionCap: null });
  return { name: checked.name, instructions: checked.instructions, tools: checked.tools, leftOut, engine: 'test' };
}

/** A draft from the person's description on the owner's chosen engine. */
export function draftAgent(engine: OwnAgentAssistant['engine'], description: string): OwnAgentProposal {
  if (engine === null) throw new OwnerDecisionPending();
  if (engine === 'live') throw new OwnAgentRefusal('agents.assistant.engine_unavailable');
  return testEngineDraft(description);
}
