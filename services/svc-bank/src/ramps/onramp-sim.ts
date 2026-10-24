import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';
import { add, formatAmount, mul, parseAmount } from '@intafaced/ledger-client';
import { ONRAMP_METHODS, type OnrampMethod, type OnrampQuoteSource } from './customer-ports.js';

/**
 * THE ADD-MONEY RATE STAND-IN, AND IT IS A TEST FIXTURE (J-bank-02 #4).
 *
 * Paying in fiat is `socket.psp-partners`: a partner prices it and a partner takes the payment, and neither is wired, so
 * every way to pay refuses by name (`docs/adr/2026-08-04-bank-vertical-law.md`). `BANK_ONRAMP_RATES=none` (the default)
 * keeps it that way. `ramp-sim` is a stand-in for the local test stack and the journey tests, like the global-send
 * stand-in: it answers quotes from a catalogue someone typed (`BANK_ONRAMP_SIM_JSON`, labelled TEST in the bank's test
 * profile), for the countries, ways to pay and assets it lists and nothing else, so a quote can be shown, accepted and
 * run out. It is a rate source only. It opens no payment, takes no money and credits nothing: an accepted quote still
 * ends `bank.fiat_ramp_socket`, because no partner exists to pay. Outside its list every ask takes the ordinary path and
 * refuses as before. Chosen in a process whose raw `APP_ENV` is not exactly `dev` or `test`, or with
 * `NODE_ENV=production`, the service refuses to start, and so it does over a blank or unreadable catalogue.
 */
export const ONRAMP_RATE_SETTINGS = ['none', 'ramp-sim'] as const;
export type OnrampRateSetting = (typeof ONRAMP_RATE_SETTINGS)[number];

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

const catalogueShape = z
  .object({
    label: z.string().regex(/^TEST\b/),
    quoteValidSeconds: z.number().int().min(1).max(3600),
    quotes: z
      .array(
        z
          .object({
            country: z.string().regex(/^[A-Z]{2}$/),
            method: z.enum(ONRAMP_METHODS),
            asset: z.string().regex(/^[A-Z0-9]{2,16}$/),
            payCurrency: z.string().regex(/^[A-Z]{3,16}$/),
            rate: decimal,
            fee: decimal,
            deliveryEstimate: z.string().trim().min(1).max(140).nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type OnrampSimCatalogue = z.infer<typeof catalogueShape>;

/** What the stand-in quotes, with its TEST label. Asks it does not list are not its to answer. */
export interface OnrampStandIn {
  readonly label: string;
  covers(input: { readonly assetId: string; readonly method: OnrampMethod; readonly country: string }): boolean;
  readonly quotes: OnrampQuoteSource;
}

/** The typed catalogue, or null when it is blank, not JSON, not labelled TEST or not in shape. */
export function parseOnrampSim(json: string | undefined): OnrampSimCatalogue | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = catalogueShape.safeParse(raw);
  if (!parsed.success) return null;
  const keys = parsed.data.quotes.map((q) => `${q.country}:${q.method}:${q.asset}`);
  if (new Set(keys).size !== keys.length) return null;
  try {
    for (const q of parsed.data.quotes) if (parseAmount(q.rate) <= 0n) return null;
  } catch {
    return null;
  }
  return parsed.data;
}

/** The stand-in over one typed catalogue. `now` is injectable so a quote's expiry can be tested. */
export function onrampSim(catalogue: OnrampSimCatalogue, now: () => Date = () => new Date()): OnrampStandIn {
  const line = (input: { assetId: string; method: OnrampMethod; country: string }) =>
    catalogue.quotes.find((q) => q.country === input.country && q.method === input.method && q.asset === input.assetId);
  return {
    label: catalogue.label,
    covers: (input) => line(input) !== undefined,
    quotes: {
      quote: async (input) => {
        const hit = line(input);
        if (!hit) return null;
        // The payer pays the amount at the TEST rate, rounded up, plus the TEST fee, both in the pay currency.
        const payAmount = add(mul(parseAmount(input.amount), parseAmount(hit.rate), 'ceil'), parseAmount(hit.fee));
        return {
          payAmount: formatAmount(payAmount),
          fee: hit.fee,
          rate: hit.rate,
          payCurrency: hit.payCurrency,
          expiresAt: new Date(now().getTime() + catalogue.quoteValidSeconds * 1000),
          deliveryEstimate: hit.deliveryEstimate,
        };
      },
    },
  };
}

/** Why the service will not start with the stand-in chosen. */
export class OnrampSimRefusedError extends Error {
  constructor(
    readonly code: 'bank.onramp_sim_outside_dev_test' | 'bank.onramp_sim_catalogue_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'OnrampSimRefusedError';
  }
}

/**
 * Total over the closed setting. `none` is no stand-in. `ramp-sim` is the stand-in only in an explicit dev or test
 * process with a readable TEST catalogue, and throws at boot otherwise: `env` is the RAW process env.
 */
export function onrampStandInFor(
  setting: OnrampRateSetting,
  catalogueJson: string | undefined,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
): OnrampStandIn | null {
  if (setting !== 'ramp-sim') return null;
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new OnrampSimRefusedError(
      'bank.onramp_sim_outside_dev_test',
      'BANK_ONRAMP_RATES=ramp-sim is a local-test stand-in that prices nothing real; it runs only with APP_ENV exactly dev or test.',
    );
  }
  const catalogue = parseOnrampSim(catalogueJson);
  if (!catalogue) {
    throw new OnrampSimRefusedError(
      'bank.onramp_sim_catalogue_unreadable',
      'BANK_ONRAMP_RATES=ramp-sim needs BANK_ONRAMP_SIM_JSON: a catalogue labelled TEST, in shape (see ramps/onramp-sim.ts).',
    );
  }
  return onrampSim(catalogue);
}
