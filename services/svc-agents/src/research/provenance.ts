/**
 * Research output provenance (RC-agents-09, TRD-0698): where a Navigator answer about a market got its facts.
 *
 * Enforced as a stage around the engine call, never left to the prompt, because a guardrail the model can skip is not
 * a guardrail:
 * 1. before the engine, `prepareResearch` finds the markets the ask names (`BTC/USDT`) and reads each one's last price
 *    from the trade plane itself. A blank uncertainty scale refuses `agents.uncertainty_scale_unset`; a named market the
 *    service cannot read refuses `agents.provenance_missing`. Both refuse before the run row and the engine: nothing
 *    runs and nothing is charged.
 * 2. the engine is handed those reads as numbered sources and asked to cite them as `[S1]`;
 * 3. after it answers, `buildProvenance` checks every sentence of the reply against the sources the service read: a
 *    sentence that cites none of them (or cites one that was never read) is listed under `unsupported`, verbatim, and the
 *    uncertainty level is read off the published scale from that share. The provenance is stored with the reply in the
 *    same write (runs/record.ts), so a reply is never kept as a finding without it.
 *
 * An ask that names no market is not research: it runs as before, with no provenance.
 */

import type { AppEnv } from '@intafaced/config';
import type { ResearchEnvironment, ResearchProvenance, ResearchSource } from '@intafaced/contracts/agents-research';
import { RESEARCH_ASSUMPTIONS } from '@intafaced/contracts/agents-research';
import { AgentError } from '../errors.js';
import type { NavigatorTradeDataPort } from '../navigator/trade-data-port.js';
import { readLiveNavigatorQuote } from '../navigator/trade-data-port.js';
import { symbolToNavigatorMarketId } from '../navigator/trade-data-http-port.js';

/** A market as a person writes it in an ask: base and quote in capitals with a slash, `BTC/USDT`. */
const MARKET_IN_TEXT = /(?<![A-Za-z0-9/])([A-Z][A-Z0-9]{1,9})\/([A-Z][A-Z0-9]{1,9})(?![A-Za-z0-9/])/g;

/** The most markets one ask may name: a research answer reads each one before the engine runs. */
export const RESEARCH_MAX_MARKETS = 5;

/** A citation in the reply: `[S1]`. */
const CITATION = /\[(S[1-9]\d{0,2})\]/g;

/** The markets `text` names, in the order it names them, each once, at most `RESEARCH_MAX_MARKETS`. */
export function namedMarkets(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(MARKET_IN_TEXT)) {
    const market = `${match[1]}/${match[2]}`;
    if (!seen.includes(market)) seen.push(market);
    if (seen.length === RESEARCH_MAX_MARKETS) break;
  }
  return seen;
}

/**
 * The owner's uncertainty scale, lowest first, from a comma-separated value. Blank is unset (null): a research answer
 * then refuses `agents.uncertainty_scale_unset`. A value with fewer than two labels, or a repeated one, is malformed and
 * stops the service at boot.
 */
export function parseUncertaintyScale(raw: string | undefined | null): readonly string[] | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const labels = raw.split(',').map((label) => label.trim());
  if (labels.length < 2 || labels.some((label) => label === '') || new Set(labels).size !== labels.length) {
    throw new Error('AGENTS_RESEARCH_UNCERTAINTY_SCALE needs at least two distinct comma-separated labels, lowest first');
  }
  return labels;
}

/** Where this deployment's market data is: the TEST stack (dev, test), a test network (staging), or live (prod). */
export function researchEnvironment(appEnv: AppEnv): ResearchEnvironment {
  if (appEnv === 'prod') return 'live';
  if (appEnv === 'staging') return 'testnet';
  return 'TEST';
}

export interface ResearchPlan {
  readonly sources: readonly ResearchSource[];
  readonly scale: readonly string[];
  readonly environment: ResearchEnvironment;
  /** The sources as the engine reads them, appended to its system text. */
  readonly system: string;
}

const missing = (market: string) =>
  new AgentError(
    `research answer has no source for ${market}: the market could not be read`,
    'agents.provenance_missing',
    'agents.refused.provenance_missing',
    { market },
  );

/**
 * Step 1: null when the ask names no market (not research). Otherwise every named market's last price, read by the
 * service, as numbered sources. Refuses before anything runs when the scale is blank or a market cannot be read.
 */
export async function prepareResearch(input: {
  readonly ask: string;
  readonly port: NavigatorTradeDataPort | undefined;
  readonly scale: readonly string[] | null;
  readonly environment: ResearchEnvironment;
}): Promise<ResearchPlan | null> {
  const markets = namedMarkets(input.ask);
  if (markets.length === 0) return null;
  if (input.scale === null) {
    throw new AgentError(
      'research answer refused: the uncertainty scale is unset',
      'agents.uncertainty_scale_unset',
      'agents.refused.uncertainty_scale_unset',
    );
  }
  const sources: ResearchSource[] = [];
  for (const market of markets) {
    const read = await readLiveNavigatorQuote(input.port, symbolToNavigatorMarketId(market));
    if (!read.ok) throw missing(market);
    const value = read.quote.last;
    const observedAt = new Date(read.quote.asOf);
    if (value === null || !/^\d+(\.\d+)?$/.test(value) || Number.isNaN(observedAt.getTime())) throw missing(market);
    sources.push({ id: `S${sources.length + 1}`, market, measure: 'last_price', value, observedAt: observedAt.toISOString() });
  }
  const system = [
    'Answer only from these sources, read by the platform just now. Cite each sentence with the id of the source it rests on, in brackets, like [S1]. A sentence with no citation is shown to the person as unsupported.',
    ...sources.map((s) => `[${s.id}] ${s.market} last traded price ${s.value}, observed at ${s.observedAt} (${input.environment} data).`),
  ].join('\n');
  return { sources, scale: input.scale, environment: input.environment, system };
}

/** The reply's sentences, each trimmed, in order. A line break ends a sentence too. */
export function splitClaims(reply: string): string[] {
  return reply
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/**
 * Step 3: the provenance of `reply`. A sentence is supported only when it cites a source the service read; the level
 * is the scale's label at the share of unsupported sentences (none unsupported is the lowest label, all is the
 * highest), and a reply with no sentence at all is the highest.
 */
export function buildProvenance(plan: ResearchPlan, reply: string): ResearchProvenance {
  const known = new Set(plan.sources.map((s) => s.id));
  const claims = splitClaims(reply);
  const unsupported = claims.filter((claim) => ![...claim.matchAll(CITATION)].some((m) => known.has(m[1]!)));
  const top = plan.scale.length - 1;
  const index = claims.length === 0 ? top : Math.ceil((unsupported.length * top) / claims.length);
  const observedAt = plan.sources.map((s) => s.observedAt).sort()[0]!;
  return {
    sources: [...plan.sources],
    observedAt,
    environment: plan.environment,
    assumptions: [...RESEARCH_ASSUMPTIONS],
    uncertainty: {
      level: plan.scale[index]!,
      scale: [...plan.scale],
      unsupportedCount: unsupported.length,
      claimCount: claims.length,
    },
    unsupported,
    notAdvice: true,
  };
}
