import type { OwnAgentOrderDraft } from '@intafaced/contracts/agents-own';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { OwnAgentRefusal } from './catalog.js';

/**
 * THE ORDER A PERSON ASKS THEIR OWN AGENT FOR, IN THEIR OWN WORDS (J-agents-08 #3 #5; RC-agents-06).
 *
 * The test engine is the deterministic stand-in (no model): it reads one order from the person's words, "buy 0.0001
 * BTC at market" or "sell 0.5 ETH at 3100", and drafts it. It drafts only; it sends nothing, holds nothing and signs
 * nothing. svc-trade previews the draft against the agent's allowance and the venue, and places it only on the person's
 * approval (services/svc-trade/src/venue/own-agent-trading.ts). Words that are not one order refuse
 * `agents.order_not_understood`: the agent never guesses a size, a side or an asset.
 */
const ORDER_WORDS = /^\s*(buy|sell)\s+([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9]{1,15})\s+at\s+(market|[0-9]+(?:\.[0-9]+)?)\s*[.!]?\s*$/i;

export function draftOrder(ask: string): OwnAgentOrderDraft {
  const found = ORDER_WORDS.exec(ask);
  if (!found) throw new OwnAgentRefusal('agents.order_not_understood');
  const positive = (text: string): string => {
    const units = parseAmount(text);
    if (units <= 0n) throw new OwnAgentRefusal('agents.order_not_understood');
    return formatAmount(units);
  };
  const market = found[4]!.toLowerCase() === 'market';
  return {
    side: found[1]!.toLowerCase() as 'buy' | 'sell',
    size: positive(found[2]!),
    base: found[3]!.toUpperCase(),
    type: market ? 'market' : 'limit',
    price: market ? null : positive(found[4]!),
    label: 'TEST',
  };
}
