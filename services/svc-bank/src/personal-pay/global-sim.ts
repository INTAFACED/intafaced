import { SCALE, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { cardSimIsLivePosture, type CardIssuerPosture } from '../cards/issuer.js';
import { emptyGlobalPorts, type GlobalPorts } from './ports.js';

/**
 * THE GLOBAL-SEND STAND-IN, AND IT IS A TEST FIXTURE.
 *
 * `BANK_GLOBAL_PARTNER` picks who answers a global send. `none` (the default) is the honest answer for every deployment
 * that has no partner: each port is unset and every send refuses by name. `global-sim` is a stand-in for the local test
 * stack and the journey tests: it answers from a catalogue someone typed (`BANK_GLOBAL_SIM_JSON`, labelled TEST in the
 * bank's test profile), calls no network, holds no credentials and pays nobody. What it lets run end to end is the bank's
 * own half: the corridor check, the quote check, the one forward posting to the stand-in's rail boundary in the real book,
 * and the tracker. Under live posture (`NODE_ENV=production`, `APP_ENV` staging or prod) `global-sim` is refused and the
 * ports stay unset, the same posture as `card-sim`. Choosing the stand-in has to be an act somebody performed.
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
    for (const corridor of parsed.data.corridors) {
      for (const bound of [corridor.minAmount, corridor.maxAmount]) if (bound !== null && parseAmount(bound) <= 0n) return null;
    }
  } catch {
    return null;
  }
  return parsed.data;
}

const live = () => 'live' as const;

/** The stand-in's ports over one typed catalogue. `now` is injectable so a quote's validity can be tested. */
export function globalSimPorts(catalogue: GlobalSimCatalogue, now: () => Date = () => new Date()): GlobalPorts {
  return {
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
          receiveAmount: formatAmount((parseAmount(amount) * parseAmount(row.rate)) / SCALE),
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

/**
 * Total over the closed setting. `none`, live posture, or a blank or unreadable catalogue all give the unset ports, so
 * every send refuses by its own name and nothing posts.
 */
export function globalPortsFor(
  setting: GlobalPartnerSetting,
  catalogueJson: string | undefined,
  posture: CardIssuerPosture = {},
): GlobalPorts {
  if (setting !== 'global-sim' || cardSimIsLivePosture(posture)) return emptyGlobalPorts();
  const catalogue = parseGlobalSim(catalogueJson);
  return catalogue ? globalSimPorts(catalogue) : emptyGlobalPorts();
}
