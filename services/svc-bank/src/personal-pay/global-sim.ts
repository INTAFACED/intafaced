import { formatAmount, mul, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';
import { emptyGlobalPorts, type GlobalPorts } from './ports.js';

/**
 * THE GLOBAL-SEND STAND-IN, AND IT IS A TEST FIXTURE.
 *
 * `BANK_GLOBAL_PARTNER` picks who answers a global send. `none` (the default) is the honest answer for every deployment
 * that has no partner: each port is unset and every send refuses by name. `global-sim` is a stand-in for the local test
 * stack and the journey tests: it answers from a catalogue someone typed (`BANK_GLOBAL_SIM_JSON`, labelled TEST in the
 * bank's test profile), calls no network, holds no credentials and pays nobody. What it lets run end to end is the bank's
 * own half: the corridor check, the quote check, the one forward posting to the stand-in's rail boundary in the real book,
 * and the tracker. It is a local-test stand-in like the trade tape: chosen in a process whose raw `APP_ENV` is not exactly
 * `dev` or `test` (an unset one included, see `@intafaced/config` app-env), or with `NODE_ENV=production`, the service
 * refuses to start, and so it does over a blank or unreadable catalogue, so a misconfigured stand-in is never silent.
 * Its ports carry the catalogue's TEST label (`standIn`), which every screen and the ops summary show beside its numbers.
 *
 * Screening: a send of an asset at or over the catalogue's TEST `reviewFrom` amount for it is put on hold before anything
 * is posted (`GlobalHoldService.screen`), so the compliance queue, the information request, the proof upload and the
 * release can be proved on the stack. Absent, or no entry for the asset, nothing is screened.
 *
 * Numbers: corridors, bounds, rates, quote validity and delivery time come only from the typed catalogue. The fee is
 * zero because a global send posts the amount alone: a fee shown here would never be charged.
 */
export const GLOBAL_PARTNER_SETTINGS = ['none', 'global-sim'] as const;
export type GlobalPartnerSetting = (typeof GLOBAL_PARTNER_SETTINGS)[number];

/** The ledger rail boundary the stand-in's forward postings land on. Never a partner's name. */
export const GLOBAL_SIM_RAIL = 'global-sim';

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

const catalogueShape = z
  .object({
    label: z.string().regex(/^TEST\b/),
    corridors: z
      .array(
        z
          .object({
            country: z.string().regex(/^[A-Z]{2}$/),
            currency: z.string().regex(/^[A-Z]{3,8}$/),
            deliveryMethods: z.array(z.string().trim().min(1).max(64)).min(1),
            minAmount: decimal.nullable(),
            maxAmount: decimal.nullable(),
            cutOffTime: z.string().trim().min(1).max(80).nullable(),
          })
          .strict(),
      )
      .min(1),
    rates: z
      .array(
        z.object({ asset: z.string().regex(/^[A-Z0-9]{2,16}$/), toCurrency: z.string().regex(/^[A-Z]{3,8}$/), rate: decimal }).strict(),
      )
      .min(1),
    // TEST: a send of an asset at or over its amount here is put on hold before anything is posted. Absent: none is.
    reviewFrom: z.array(z.object({ asset: z.string().regex(/^[A-Z0-9]{2,16}$/), amount: decimal }).strict()).optional(),
    quoteValidSeconds: z.number().int().min(1).max(3600),
    etaHours: z.number().int().min(0).max(240),
    banks: z.array(
      z.object({ bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/), bankName: z.string().trim().min(1).max(140) }).strict(),
    ),
    travelRule: z
      .object({ decidedBy: z.string().regex(/^TEST\b/), requiredFields: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/)) })
      .strict(),
  })
  .strict();

export type GlobalSimCatalogue = z.infer<typeof catalogueShape>;

/** The typed catalogue, or null when it is blank, not JSON, not labelled TEST or not in shape. */
export function parseGlobalSim(json: string | undefined): GlobalSimCatalogue | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = catalogueShape.safeParse(raw);
  if (!parsed.success) return null;
  // A rate of zero or a bound the ledger cannot hold is an unreadable catalogue, not a send that fails later.
  try {
    for (const rate of parsed.data.rates) if (parseAmount(rate.rate) <= 0n) return null;
    for (const line of parsed.data.reviewFrom ?? []) if (parseAmount(line.amount) <= 0n) return null;
    // One line per asset: two lines for one asset would leave which one screens to their order.
    const assets = (parsed.data.reviewFrom ?? []).map((line) => line.asset);
    if (new Set(assets).size !== assets.length) return null;
    for (const corridor of parsed.data.corridors) {
      for (const bound of [corridor.minAmount, corridor.maxAmount]) if (bound !== null && parseAmount(bound) <= 0n) return null;
    }
  } catch {
    return null;
  }
  return parsed.data;
}

const live = () => 'live' as const;

function receive(amount: string, rate: string): string {
  const out = formatAmount(mul(parseAmount(amount), parseAmount(rate), 'floor'));
  parseAmount(out);
  return out;
}

/** The stand-in's ports over one typed catalogue. `now` is injectable so a quote's validity can be tested. */
export function globalSimPorts(catalogue: GlobalSimCatalogue, now: () => Date = () => new Date()): GlobalPorts {
  return {
    standIn: { label: catalogue.label },
    ...(catalogue.reviewFrom?.length
      ? {
          review: {
            waits: ({ assetId, amount }: { assetId: string; amount: string }) => {
              const line = catalogue.reviewFrom!.find((one) => one.asset === assetId.toUpperCase());
              return line !== undefined && parseAmount(amount) >= parseAmount(line.amount);
            },
          },
        }
      : {}),
    corridors: {
      status: live,
      list: async () => catalogue.corridors.map((corridor) => ({ ...corridor, deliveryMethods: [...corridor.deliveryMethods] })),
    },
    bic: {
      status: live,
      lookup: async (bic) => {
        const hit = catalogue.banks.find((bank) => bank.bic === bic.replace(/\s+/g, '').toUpperCase());
        return hit ? { bic: hit.bic, bankName: hit.bankName } : null;
      },
    },
    fx: {
      status: live,
      quote: async ({ asset, amount, toCurrency }) => {
        const row = catalogue.rates.find((rate) => rate.asset === asset && rate.toCurrency === toCurrency);
        // No typed rate for the pair is an unusable answer: the service refuses `bank.global_fx_unusable` and posts nothing.
        if (!row) throw new Error(`no TEST rate for ${asset} to ${toCurrency}`);
        const at = now().getTime();
        return {
          rate: row.rate,
          fee: '0',
          feeAsset: asset,
          // Floor, as a provider pays no more than it quotes; past what the ledger can hold, the quote is unusable.
          receiveAmount: receive(amount, row.rate),
          validUntil: new Date(at + catalogue.quoteValidSeconds * 1000).toISOString(),
          eta: new Date(at + catalogue.etaHours * 3_600_000).toISOString(),
        };
      },
    },
    payout: {
      status: live,
      railId: () => GLOBAL_SIM_RAIL,
      // The stand-in pays nobody: it acknowledges the send so the tracker has a reference, keyed by the send itself.
      submit: async ({ sendId }) => ({ ok: true, providerRef: `TEST-${sendId}`, status: 'sent' }),
    },
    travelRule: {
      decision: () => ({ decidedBy: catalogue.travelRule.decidedBy, requiredFields: [...catalogue.travelRule.requiredFields] }),
    },
  };
}

/** Why the service will not start with the stand-in chosen. */
export class GlobalSimRefusedError extends Error {
  constructor(
    readonly code: 'bank.global_sim_outside_dev_test' | 'bank.global_sim_catalogue_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'GlobalSimRefusedError';
  }
}

/**
 * Total over the closed setting. `none` gives the unset ports, so every send refuses by its own name and nothing posts.
 * `global-sim` gives the stand-in only in an explicit dev or test process with a readable TEST catalogue, and throws at
 * boot otherwise: `env` is the RAW process env, never the schema's defaulted `APP_ENV`.
 */
export function globalPortsFor(
  setting: GlobalPartnerSetting,
  catalogueJson: string | undefined,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
): GlobalPorts {
  if (setting !== 'global-sim') return emptyGlobalPorts();
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new GlobalSimRefusedError(
      'bank.global_sim_outside_dev_test',
      'BANK_GLOBAL_PARTNER=global-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test.',
    );
  }
  const catalogue = parseGlobalSim(catalogueJson);
  if (!catalogue) {
    throw new GlobalSimRefusedError(
      'bank.global_sim_catalogue_unreadable',
      'BANK_GLOBAL_PARTNER=global-sim needs BANK_GLOBAL_SIM_JSON: a catalogue labelled TEST, in shape (see global-sim.ts).',
    );
  }
  return globalSimPorts(catalogue);
}
