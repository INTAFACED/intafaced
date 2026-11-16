/**
 * WHERE A RESEARCH ANSWER'S FACTS CAME FROM (RC-agents-09, TRD-0698): the provenance svc-agents attaches to a Navigator
 * answer about a market, and stores with the run in the same write as its reply. Browser-safe: zod only.
 *
 * svc-agents builds it as an output stage, never from the model's say-so: the sources are the market reads the service
 * made itself before the engine was called, each with the venue's own observation time; a sentence of the answer that
 * cites none of them is listed under `unsupported`. An answer with no source and no observation time is refused
 * `agents.provenance_missing` before the engine runs, and a blank uncertainty scale refuses
 * `agents.uncertainty_scale_unset`; neither is charged. Prices are decimal strings, never a `number`.
 */

import { z } from 'zod';

/** The refusals of a research answer, as the message of their typed error. */
export const RESEARCH_REFUSALS = ['agents.provenance_missing', 'agents.uncertainty_scale_unset'] as const;
export type ResearchRefusal = (typeof RESEARCH_REFUSALS)[number];

/** Where the data was read: a live market, a test network, or the TEST stack. */
export const RESEARCH_ENVIRONMENTS = ['live', 'testnet', 'TEST'] as const;
export type ResearchEnvironment = (typeof RESEARCH_ENVIRONMENTS)[number];

/** A reference a claim cites: `[S1]`, `[S2]`, in the order the sources were read. */
export const researchSourceIdSchema = z.string().regex(/^S[1-9]\d{0,2}$/);

/** What a source measured. Only what the service itself reads: today a market's last traded price. */
export const RESEARCH_MEASURES = ['last_price'] as const;

/**
 * What every research answer takes as given, as codes the surface words: each price is the venue's last trade at its
 * observation time and may have moved since; only the markets the question names were read.
 */
export const RESEARCH_ASSUMPTIONS = ['last_trade_at_observation', 'named_markets_only'] as const;

export const researchSourceSchema = z.object({
  id: researchSourceIdSchema,
  /** The market read, as the venue names it: `BTC/USDT`. */
  market: z.string().regex(/^[A-Z][A-Z0-9]{1,9}\/[A-Z][A-Z0-9]{1,9}$/),
  measure: z.enum(RESEARCH_MEASURES),
  /** The figure the source gave, a decimal string. */
  value: z.string().regex(/^\d+(\.\d+)?$/),
  /** When the venue observed it (its own timestamp, ISO 8601). */
  observedAt: z.string().datetime({ offset: true }),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchProvenanceSchema = z.object({
  sources: z.array(researchSourceSchema).min(1),
  /** The oldest observation among the sources: the answer is no fresher than this. */
  observedAt: z.string().datetime({ offset: true }),
  environment: z.enum(RESEARCH_ENVIRONMENTS),
  /** What the answer takes as given. Present even when empty. */
  assumptions: z.array(z.enum(RESEARCH_ASSUMPTIONS)),
  uncertainty: z.object({
    /** A label from the published uncertainty scale (an owner value), lowest first. */
    level: z.string().min(1),
    /** The whole scale, lowest first, so a reader sees where the level sits. */
    scale: z.array(z.string().min(1)).min(2),
    /** The level's basis: how many of the answer's sentences cite no source, of how many. */
    unsupportedCount: z.number().int().min(0),
    claimCount: z.number().int().min(0),
  }),
  /** Every sentence of the answer that cites no source, verbatim: not a finding, and never shown as one. */
  unsupported: z.array(z.string().min(1)),
  /** Fixed true: the answer is the agent's reading of its sources, not an exchange record and not advice. */
  notAdvice: z.literal(true),
});
export type ResearchProvenance = z.infer<typeof researchProvenanceSchema>;
