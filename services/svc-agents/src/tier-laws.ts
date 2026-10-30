import { z } from 'zod';
import type { NavigatorTierLaw } from './navigator/tier-gate.js';
import type { ScannerTierLaw } from './scanner/tier-gate.js';
import type { SupportTierLaw } from './support-agent/tier-gate.js';

/**
 * The published tier law of the scanner, navigator and support doors (AG-sessions-01 security fix).
 *
 * The tier a door gates on is the signed principal's (`ctx.principal.tier`), and the law is this stored, published
 * configuration: neither is ever read from a request body, so a caller can no longer name its own tier or supply its
 * own matrix. The law comes from `AGENTS_TIER_LAWS`, one JSON object with an optional entry per agent. A blank variable
 * or a missing entry is an unpublished law, and that door refuses `tier_law_blank`: no grant is invented. A malformed
 * value refuses boot rather than opening or closing a door by accident.
 */

const toolList = z.array(z.string().min(1).max(120)).max(100);
const unpublished = z.object({ published: z.literal(false) }).strict();

const scannerLaw = z.union([
  unpublished,
  z
    .object({
      published: z.literal(true),
      matrix: z.record(z.string(), z.object({ maxSignals: z.number().int().min(0).max(100), tools: toolList }).strict()),
    })
    .strict(),
]);
const toolLaw = z.union([unpublished, z.object({ published: z.literal(true), matrix: z.record(z.string(), toolList) }).strict()]);

const tierLawsSchema = z.object({ scanner: scannerLaw.optional(), navigator: toolLaw.optional(), support: toolLaw.optional() }).strict();

export interface TierLaws {
  readonly scanner: ScannerTierLaw | null;
  readonly navigator: NavigatorTierLaw | null;
  readonly support: SupportTierLaw | null;
}

/** No law published for any door: every tier-gated door refuses `tier_law_blank`. */
export const NO_TIER_LAWS: TierLaws = { scanner: null, navigator: null, support: null };

export class TierLawsInvalidError extends Error {
  readonly code = 'agents.tier_laws_invalid';
  constructor(detail: string) {
    super(`AGENTS_TIER_LAWS is not a valid tier law: ${detail}`);
    this.name = 'TierLawsInvalidError';
  }
}

export function parseTierLaws(raw: string | undefined): TierLaws {
  if (raw === undefined || raw.trim() === '') return NO_TIER_LAWS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TierLawsInvalidError((err as Error).message);
  }
  const result = tierLawsSchema.safeParse(parsed);
  if (!result.success) throw new TierLawsInvalidError(result.error.issues.map((issue) => issue.message).join('; '));
  return {
    scanner: result.data.scanner ?? null,
    navigator: result.data.navigator ?? null,
    support: result.data.support ?? null,
  };
}

export function envTierLaws(env: NodeJS.ProcessEnv = process.env): TierLaws {
  return parseTierLaws(env.AGENTS_TIER_LAWS);
}
