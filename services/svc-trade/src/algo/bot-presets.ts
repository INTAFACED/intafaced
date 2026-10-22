import { z } from 'zod';

/**
 * Bot strategy presets (copy-bots-otc-bots-003). Presets come only from the owner-published backtest source on
 * `TRADE_BOTS_PRESETS_BACKTEST` (JSON). Blank reads `not_set` with no presets and no APR. A set value must parse
 * exactly; anything else throws at boot so the service never starts on a half-read source. No backtest figure is
 * ever invented here: every APR shown is the owner's decimal string, verbatim.
 */
export const TRADE_BOTS_PRESETS_BACKTEST_ENV = 'TRADE_BOTS_PRESETS_BACKTEST';

export const BOT_PRESET_HORIZONS = ['7d', '30d', '90d'] as const;
export const BOT_PRESET_AGGRESSIVENESS = ['conservative', 'moderate', 'aggressive'] as const;

/** Signed decimal string percent, e.g. "12.5" or "-3.25". Never a JSON number. */
const aprString = z.string().regex(/^-?(0|[1-9]\d{0,5})(\.\d{1,4})?$/, 'aprEstimate must be a decimal string percent');

const presetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    strategy: z.enum(['grid', 'dca', 'twap']),
    marketId: z.string().min(1).max(64),
    aggressiveness: z.enum(BOT_PRESET_AGGRESSIVENESS),
    horizon: z.enum(BOT_PRESET_HORIZONS),
    aprEstimate: aprString,
  })
  .strict();

const sourceSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    backtestedAt: z.string().datetime(),
    presets: z.array(presetSchema).min(1).max(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    for (const p of v.presets) {
      if (ids.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate preset id ${p.id}` });
      ids.add(p.id);
    }
  });

export type BotPreset = z.infer<typeof presetSchema>;

export type BotPresetsView =
  | { readonly state: 'not_set'; readonly presets: readonly never[] }
  | { readonly state: 'published'; readonly version: string; readonly backtestedAt: string; readonly presets: readonly BotPreset[] };

export const BOT_PRESETS_NOT_SET: BotPresetsView = Object.freeze({ state: 'not_set', presets: [] as never[] });

export class BotPresetsSourceError extends Error {
  readonly code = 'trade.bots_presets_source_invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BotPresetsSourceError';
  }
}

/** Boot parse. Blank → not_set. Invalid JSON or shape → throws (service must not boot). */
export function parseBotPresetsSource(raw: string | null | undefined): BotPresetsView {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return BOT_PRESETS_NOT_SET;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new BotPresetsSourceError(`${TRADE_BOTS_PRESETS_BACKTEST_ENV} is not valid JSON`);
  }
  const result = sourceSchema.safeParse(parsed);
  if (!result.success) {
    throw new BotPresetsSourceError(
      `${TRADE_BOTS_PRESETS_BACKTEST_ENV} is invalid: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
    );
  }
  return Object.freeze({
    state: 'published' as const,
    version: result.data.version,
    backtestedAt: result.data.backtestedAt,
    presets: Object.freeze(result.data.presets.map((p) => Object.freeze({ ...p }))),
  });
}
