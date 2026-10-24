import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';

/**
 * WHO SPEAKS FOR THE DIRECT DEBIT SCHEME (BK-xfer-11).
 *
 * A direct debit moves money on a third party's instruction, and which scheme the bank joins, its failure fees and its
 * guarantee periods are the owner's call (owner decision list item 12). Nothing is switched on: `BANK_DD_SCHEME=none`
 * (the default) is the honest answer for every deployment, and every customer control refuses `rail.bank`.
 *
 * `dd-sim` is a stand-in for the local test stack and the journey tests, like the global-send stand-in: a catalogue
 * someone typed (`BANK_DD_SIM_JSON`, labelled TEST in the bank's test profile) names the TEST creditors that may set up a
 * mandate and present a collection through the signed job doors, and a TEST guarantee period. It calls no network,
 * holds no credentials and pays nobody: a collection posts once in the real book to the stand-in's rail boundary. Chosen
 * in a process whose raw `APP_ENV` is not exactly `dev` or `test`, or with `NODE_ENV=production`, the service refuses
 * to start, and so it does over a blank or unreadable catalogue.
 *
 * Not in the catalogue on purpose: the failure fee table. No fee is charged on a failed collection in this build, and the
 * fee shows as not set (`bank.dd_failure_fee_unset`) until the owner publishes one and a fee entry exists to collect it.
 */
export const DD_SCHEME_SETTINGS = ['none', 'dd-sim'] as const;
export type DirectDebitSchemeSetting = (typeof DD_SCHEME_SETTINGS)[number];

/** The ledger rail boundary the stand-in's collections land on. Never a scheme's or a creditor's name. */
export const DD_SIM_RAIL = 'dd-sim';

export interface DirectDebitCreditor {
  readonly id: string;
  readonly name: string;
}

export interface DirectDebitScheme {
  readonly status: 'unset' | 'live';
  /** The stand-in's TEST label, shown beside everything it answers. Null for a real scheme. */
  readonly standIn: string | null;
  /** The ledger rail boundary a collection posts to. */
  readonly railId: string;
  /** Days after a collection in which a refund may be requested. Null is not set: refunds are refused, never assumed. */
  readonly guaranteeDays: number | null;
  /** The creditor the scheme knows by this id, or null. */
  creditor(id: string): DirectDebitCreditor | null;
}

export const unsetDirectDebitScheme: DirectDebitScheme = {
  status: 'unset',
  standIn: null,
  railId: '',
  guaranteeDays: null,
  creditor: () => null,
};

const catalogueShape = z
  .object({
    label: z.string().regex(/^TEST\b/),
    // TEST: null leaves the guarantee period not set, so a refund request is refused by name.
    guaranteeDays: z.number().int().min(1).max(400).nullable(),
    creditors: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
            name: z
              .string()
              .regex(/^TEST\b/)
              .max(140),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type DirectDebitSimCatalogue = z.infer<typeof catalogueShape>;

/** The typed catalogue, or null when it is blank, not JSON, not labelled TEST or not in shape. */
export function parseDirectDebitSim(json: string | undefined): DirectDebitSimCatalogue | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = catalogueShape.safeParse(raw);
  if (!parsed.success) return null;
  const ids = parsed.data.creditors.map((one) => one.id);
  if (new Set(ids).size !== ids.length) return null;
  return parsed.data;
}

export function directDebitSimScheme(catalogue: DirectDebitSimCatalogue): DirectDebitScheme {
  return {
    status: 'live',
    standIn: catalogue.label,
    railId: DD_SIM_RAIL,
    guaranteeDays: catalogue.guaranteeDays,
    creditor: (id) => {
      const hit = catalogue.creditors.find((one) => one.id === id);
      return hit ? { id: hit.id, name: hit.name } : null;
    },
  };
}

/** Why the service will not start with the stand-in chosen. */
export class DirectDebitSimRefusedError extends Error {
  constructor(
    readonly code: 'bank.dd_sim_outside_dev_test' | 'bank.dd_sim_catalogue_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'DirectDebitSimRefusedError';
  }
}

/**
 * Total over the closed setting. `none` is the unset scheme. `dd-sim` is the stand-in only in an explicit dev or test
 * process with a readable TEST catalogue, and throws at boot otherwise: `env` is the RAW process env.
 */
export function directDebitSchemeFor(
  setting: DirectDebitSchemeSetting,
  catalogueJson: string | undefined,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
): DirectDebitScheme {
  if (setting !== 'dd-sim') return unsetDirectDebitScheme;
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new DirectDebitSimRefusedError(
      'bank.dd_sim_outside_dev_test',
      'BANK_DD_SCHEME=dd-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test.',
    );
  }
  const catalogue = parseDirectDebitSim(catalogueJson);
  if (!catalogue) {
    throw new DirectDebitSimRefusedError(
      'bank.dd_sim_catalogue_unreadable',
      'BANK_DD_SCHEME=dd-sim needs BANK_DD_SIM_JSON: a catalogue labelled TEST, in shape (see direct-debits/scheme.ts).',
    );
  }
  return directDebitSimScheme(catalogue);
}
