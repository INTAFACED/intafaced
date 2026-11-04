import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';
import type { OnrampMethod, OnrampPaymentPort } from './customer-ports.js';

/**
 * THE ADD-MONEY PAY-IN STAND-IN, AND IT IS A TEST FIXTURE (J-bank-02 #3, #5).
 *
 * Paying in fiat is `socket.psp-partners`: a partner opens the payment, the payer approves it on the partner's page, and
 * the partner later says the money arrived. None is wired, so every way to pay is kept refused by name
 * (`docs/adr/2026-08-04-bank-vertical-law.md`). `BANK_ONRAMP_PARTNER=none` (the default) keeps it that way. `payin-sim`
 * is a stand-in for the local test stack and the journey tests, as `payout-sim` is for cash-outs: for the hosted ways to
 * pay its catalogue lists (`BANK_PAYIN_SIM_JSON`, labelled TEST in the bank's test profile) it opens a TEST payment page
 * served by this service (`/test/payin-sim/pay/<id>`), where the payer approves and is sent back to the app. It takes no
 * money: saying the payment was paid is the partner's signed call (`/internal/jobs/payin-sim/paid`), which only a test
 * makes here, and the credit moves value only through the ledger's deposit recipe from its own TEST rail boundary
 * (`payin-sim`). Chosen in a process whose raw `APP_ENV` is not exactly `dev` or `test`, or with
 * `NODE_ENV=production`, the service refuses to start, and so it does over a blank or unreadable catalogue, or without
 * the page and return addresses.
 */
export const ONRAMP_PARTNER_SETTINGS = ['none', 'payin-sim'] as const;
export type OnrampPartnerSetting = (typeof ONRAMP_PARTNER_SETTINGS)[number];

/** The ledger rail boundary the stand-in's pay-ins arrive from. */
export const PAYIN_SIM_RAIL = 'payin-sim';

/** The ways to pay that are a hosted page. A bank transfer is instructions, not a page, and the stand-in opens none. */
const HOSTED_METHODS = ['pay_by_bank', 'card', 'wallet_pay'] as const satisfies readonly OnrampMethod[];

const catalogueShape = z
  .object({
    label: z.string().regex(/^TEST\b/),
    methods: z.array(z.enum(HOSTED_METHODS)).min(1),
  })
  .strict();

export type PayinSimCatalogue = z.infer<typeof catalogueShape>;

/** A partner that opens hosted pay-ins and later says each was paid. The stand-in is the only one in this build. */
export interface OnrampPartner {
  /** The TEST label when this is the stand-in. */
  readonly label: string;
  /** The ledger rail boundary paid-in value arrives from. */
  readonly rail: string;
  /** Whether it opens payments for this way to pay. */
  covers(method: OnrampMethod): boolean;
  /** Opens the payment: the hosted page the payer goes to. */
  readonly payments: OnrampPaymentPort;
  /** Where the payer is sent back to after the partner's page, with the request id. */
  returnUrl(requestId: string): string;
}

/** The typed catalogue, or null when it is blank, not JSON, not labelled TEST or not in shape. */
export function parsePayinSim(json: string | undefined): PayinSimCatalogue | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = catalogueShape.safeParse(raw);
  if (!parsed.success) return null;
  if (new Set(parsed.data.methods).size !== parsed.data.methods.length) return null;
  return parsed.data;
}

/** A loopback http(s) base address with no path, query or fragment: the only place a TEST page or return may be. */
function loopbackBase(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return url;
}

/** The stand-in over one typed catalogue, its own page address and the app's return address. */
export function payinSim(catalogue: PayinSimCatalogue, pageBase: URL, returnTo: URL): OnrampPartner {
  const listed = new Set<OnrampMethod>(catalogue.methods);
  const page = (onrampId: string) => new URL(`/test/payin-sim/pay/${encodeURIComponent(onrampId)}`, pageBase).toString();
  return {
    label: catalogue.label,
    rail: PAYIN_SIM_RAIL,
    covers: (method) => listed.has(method),
    payments: {
      loopbackPages: true,
      async open(input) {
        if (!listed.has(input.method)) return null;
        return { partnerRail: PAYIN_SIM_RAIL, hostedUrl: page(input.onrampId) };
      },
    },
    returnUrl(requestId) {
      const back = new URL(returnTo.toString());
      back.searchParams.set('request', requestId);
      return back.toString();
    },
  };
}

/** Why the service will not start with the stand-in chosen. */
export class PayinSimRefusedError extends Error {
  constructor(
    readonly code: 'bank.payin_sim_outside_dev_test' | 'bank.payin_sim_catalogue_unreadable' | 'bank.payin_sim_address_unset',
    message: string,
  ) {
    super(message);
    this.name = 'PayinSimRefusedError';
  }
}

/**
 * Total over the closed setting. `none` is no partner. `payin-sim` is the stand-in only in an explicit dev or test
 * process with a readable TEST catalogue and loopback page and return addresses, and throws at boot otherwise: `env` is
 * the RAW process env.
 */
export function onrampPartnerFor(
  setting: OnrampPartnerSetting,
  config: { readonly catalogueJson?: string | undefined; readonly pageUrl?: string | undefined; readonly returnUrl?: string | undefined },
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
): OnrampPartner | null {
  if (setting !== 'payin-sim') return null;
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new PayinSimRefusedError(
      'bank.payin_sim_outside_dev_test',
      'BANK_ONRAMP_PARTNER=payin-sim is a local-test stand-in that takes no money; it runs only with APP_ENV exactly dev or test.',
    );
  }
  const catalogue = parsePayinSim(config.catalogueJson);
  if (!catalogue) {
    throw new PayinSimRefusedError(
      'bank.payin_sim_catalogue_unreadable',
      'BANK_ONRAMP_PARTNER=payin-sim needs BANK_PAYIN_SIM_JSON: a catalogue labelled TEST, in shape (see ramps/payin-sim.ts).',
    );
  }
  const pageBase = loopbackBase(config.pageUrl);
  const returnTo = loopbackBase(config.returnUrl);
  if (!pageBase || !returnTo) {
    throw new PayinSimRefusedError(
      'bank.payin_sim_address_unset',
      'BANK_ONRAMP_PARTNER=payin-sim needs BANK_PAYIN_SIM_PAGE_URL and BANK_PAYIN_SIM_RETURN_URL, both loopback http(s) addresses.',
    );
  }
  return payinSim(catalogue, pageBase, returnTo);
}

/** The pay-in partner's "paid" job body (`/internal/jobs/payin-sim/paid`): which request, and what it says was paid. */
export const payinPaidBody = z
  .object({
    requestId: z.string().uuid(),
    paidAmount: z.string().regex(/^\d+(\.\d{1,18})?$/),
    payCurrency: z.string().regex(/^[A-Z]{3,16}$/),
  })
  .strict();
