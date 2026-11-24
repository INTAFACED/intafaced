import type { Sql } from 'postgres';
import { z } from 'zod';
import type { ScreeningAnswer } from './decision.js';
import type { ScreeningScreener, ScreeningSubject } from './guard.js';

/**
 * The OpenSanctions screener, the owner's chosen screening vendor. It asks `/match/default` about one party, scoped with `include_dataset` to exactly the four official lists (OFAC SDN,
 * UN Security Council, EU financial sanctions, UK sanctions list) and nothing else, and maps the reply:
 *
 * - any result OpenSanctions marks `match` (its score at or above the threshold) → `review`: the send is held and queued
 *   for a person, never cleared. Not `refuse`: a score is name-match confidence, not proof it is the listed party, and a
 *   refusal is final with nobody looking; a held send keeps the money still until a person decides.
 * - no result marked `match` → `clear`.
 * - a party this service cannot name → `unavailable` (`party_unresolved`), never clear.
 * - anything else (timeout, network, a status that is not 2xx, a body that is not the documented shape) → `unavailable`
 *   (`provider_down`).
 *
 * The key is read once from settings at boot and only ever put in the `Authorization` header. It is never logged and
 * never part of an answer or a thrown message. A case keeps the factor codes only, never the name it asked about.
 */
export const OPENSANCTIONS_SCREENER = 'opensanctions';
export const OPENSANCTIONS_API_KEY_ENV = 'OPENSANCTIONS_API_KEY';
const OPENSANCTIONS_BASE_URL = 'https://api.opensanctions.org';
/** The four official lists, exactly as published (OFAC SDN, UN Security Council, EU, UK), by dataset name; no other. */
export const OPENSANCTIONS_DATASETS = ['us_ofac_sdn', 'un_sc_sanctions', 'eu_fsf', 'gb_fcdo_sanctions'] as const;

/** Who a send goes to, as the matcher needs it. Resolved by svc-pay from what it owns; never stored in a case. */
export interface ScreeningParty {
  readonly schema: 'Person' | 'Organization';
  readonly names: readonly string[];
  /** YYYY-MM-DD, a person only. */
  readonly birthDate?: string;
  /** ISO alpha-2: a person's nationality or an organisation's country. */
  readonly country?: string;
}

/** Null when this service cannot say who the party is: the answer is then unavailable, never clear. */
export type ScreeningPartyResolver = (subject: ScreeningSubject) => Promise<ScreeningParty | null>;

const QUERY_ID = 'party';
const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;

const replySchema = z.object({
  responses: z.record(
    z.string(),
    z.object({
      status: z.number().int().optional(),
      results: z.array(z.object({ match: z.boolean() })),
    }),
  ),
});

const MerchantNameRow = z.object({ legal_name: z.string().nullable(), display_name: z.string().nullable() });

const down: ScreeningAnswer = { category: 'unavailable', factors: [{ code: 'provider_down' }] };
const unresolved: ScreeningAnswer = { category: 'unavailable', factors: [{ code: 'party_unresolved' }] };

/** The match URL with the four lists, built once. */
function openSanctionsMatchUrl(baseUrl: string = OPENSANCTIONS_BASE_URL): string {
  const url = new URL('/match/default', baseUrl);
  for (const dataset of OPENSANCTIONS_DATASETS) url.searchParams.append('include_dataset', dataset);
  return url.toString();
}

function queryOf(party: ScreeningParty): Record<string, unknown> {
  const properties: Record<string, string[]> = { name: [...party.names] };
  if (party.schema === 'Person') {
    if (party.birthDate) properties.birthDate = [party.birthDate];
    if (party.country) properties.nationality = [party.country.toLowerCase()];
  } else if (party.country) {
    properties.country = [party.country.toLowerCase()];
  }
  return { queries: { [QUERY_ID]: { schema: party.schema, properties } } };
}

export function createOpenSanctionsScreener(input: {
  apiKey: string;
  resolveParty: ScreeningPartyResolver;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
}): ScreeningScreener {
  const apiKey = input.apiKey.trim();
  if (apiKey === '') throw new Error(`pay.screening_screener_refused: ${OPENSANCTIONS_API_KEY_ENV} is blank`);
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = openSanctionsMatchUrl(input.baseUrl);
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async (subject) => {
    if (!subject) return unresolved;
    let party: ScreeningParty | null;
    try {
      party = await input.resolveParty(subject);
    } catch {
      return unresolved;
    }
    const names = (party?.names ?? []).map((name) => name.trim()).filter((name) => name !== '');
    if (!party || names.length === 0) return unresolved;
    let body: unknown;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `ApiKey ${apiKey}` },
        body: JSON.stringify(queryOf({ ...party, names })),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return down;
      body = await response.json();
    } catch {
      return down;
    }
    const read = replySchema.safeParse(body);
    if (!read.success) return down;
    const answer = read.data.responses[QUERY_ID];
    if (!answer || (answer.status !== undefined && answer.status !== 200)) return down;
    if (answer.results.some((result) => result.match)) return { category: 'review', factors: [{ code: 'sanctions_list_match' }] };
    return { category: 'clear', factors: [{ code: 'sanctions_list_clear' }] };
  };
}

/**
 * Names the party of a send from what svc-pay itself owns. A payout's party is the business (`pay.merchants`, its
 * legal name, else its display name). A withdrawal's party is a person, whose verified name, birth date and nationality
 * svc-identity owns and does not yet publish to svc-pay through a record: until it does, a withdrawal resolves to
 * nothing and is unavailable, as it is today.
 */
export function createPayPartyResolver(sql: Sql): ScreeningPartyResolver {
  return async (subject) => {
    if (subject.kind !== 'payout') return null;
    const rows = MerchantNameRow.array().parse(
      await sql`SELECT legal_name, display_name FROM pay.merchants WHERE id = ${subject.partyRef}`,
    );
    const row = rows[0];
    if (!row) return null;
    const names = [row.legal_name, row.display_name].filter((name): name is string => !!name && name.trim() !== '');
    return names.length > 0 ? { schema: 'Organization', names: [...new Set(names)] } : null;
  };
}
