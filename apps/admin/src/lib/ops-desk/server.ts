import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom } from '@/lib/desk/part';
import {
  BANK_CUSTOMER_BALANCES,
  BANK_CUSTOMER_ENTRIES,
  BANK_CUSTOMER_ENTRIES_CHECK,
  DESKS,
  PAY_TRANSFER_DETAIL,
  allReads,
  readSpecFor,
} from './catalog';
import { inputFor, readData } from './model';
import type { DeskView, OpsDeskId, ReadData, ReadOutcome, ReadSpec } from './types';

/**
 * Read a whole module desk as the signed-in founder.
 *
 * Every read is independent: one that is refused, down or unreadable is a failed part with its reason, and the rest
 * still load. Nothing is cached and nothing is summed or estimated here; the only thing this adds to a service answer
 * is the time the console finished reading it.
 *
 * Reads that name the same procedure with the same input (one answer shown as a facts block and a table, say) share ONE
 * call to the service. Each is still read, checked and counted on its own: one that cannot be read is a failed part while
 * its sibling shows.
 */

const SERVICE: Readonly<Record<ReadSpec['module'], string>> = {
  identity: 'svc-identity',
  trade: 'svc-trade',
  pay: 'svc-pay',
  support: 'svc-support',
  notify: 'svc-notify',
  bank: 'svc-bank',
  p2p: 'svc-p2p',
  academy: 'svc-academy',
  market: 'svc-market',
  agents: 'svc-agents',
  quant: 'svc-quant',
  mining: 'svc-mining-pool',
  token: 'svc-token',
  protocol: 'svc-protocol',
  indexer: 'svc-indexer',
  dex: 'svc-dex',
  campaigns: 'svc-campaigns',
};

function outcomeOf(spec: ReadSpec, result: FounderCallResult<ReadData>, asOf: string): ReadOutcome {
  return {
    id: spec.id,
    asOf,
    part: partFrom(result, (d) => d, {
      service: SERVICE[spec.module],
      forbiddenMessage: spec.forbiddenText,
      refusedMessage: (code) => (code !== null && spec.refusals && Object.hasOwn(spec.refusals, code) ? spec.refusals[code]! : null),
    }),
  };
}

async function loadGroup(ctx: FounderCallContext, specs: readonly ReadSpec[], now: Date): Promise<ReadOutcome[]> {
  const first = specs[0]!;
  const answer = await founderCall(ctx, first.module, first.procedure, 'GET', inputFor(first, now), (raw) => ({ raw }), {
    sendEmptyInput: first.sendEmptyInput === true,
  });
  const asOf = new Date().toISOString();
  return specs.map((spec) => {
    if (answer.kind !== 'ok') return outcomeOf(spec, answer, asOf);
    const data = readData(spec, answer.data.raw);
    return outcomeOf(
      spec,
      data === null ? { kind: 'invalid', requestId: answer.requestId } : { kind: 'ok', data, requestId: answer.requestId },
      asOf,
    );
  });
}

export async function loadRead(ctx: FounderCallContext, spec: ReadSpec): Promise<ReadOutcome> {
  return (await loadGroup(ctx, [spec], new Date()))[0]!;
}

/** One transfer's full record, read on request (a click), because svc-bank writes a log line for every one it hands out. */
export async function loadTransferDetail(ctx: FounderCallContext, id: string): Promise<ReadOutcome> {
  return loadRead(ctx, { ...PAY_TRANSFER_DETAIL, input: { id } });
}

/** One customer's balances, read on request (svc-bank logs the operator and the customer before it reads any figure). */
export async function loadCustomerBalances(ctx: FounderCallContext, userId: string): Promise<ReadOutcome> {
  return loadRead(ctx, { ...BANK_CUSTOMER_BALANCES, input: { userId } });
}

/**
 * One page of the entries behind a customer's balance in one coin, with svc-bank's sum check. Both come from ONE call, so the
 * operator is logged once and the check belongs to the very answer the rows came from.
 */
export async function loadCustomerEntries(
  ctx: FounderCallContext,
  userId: string,
  assetId: string,
  cursor: string | null,
): Promise<{ readonly entries: ReadOutcome; readonly check: ReadOutcome }> {
  const input = { userId, assetId, ...(cursor === null ? {} : { cursor }) };
  const [entries, check] = await loadGroup(
    ctx,
    [
      { ...BANK_CUSTOMER_ENTRIES, input },
      { ...BANK_CUSTOMER_ENTRIES_CHECK, input },
    ],
    new Date(),
  );
  return { entries: entries!, check: check! };
}

/**
 * The next page of a list whose service gives a page marker, read on request. Only a read that names a `cursorKey` can be paged,
 * and the marker is passed to the service untouched: it is the service's to judge (a marker it did not issue is its refusal).
 */
export async function loadPage(ctx: FounderCallContext, deskId: OpsDeskId, readId: string, cursor: string): Promise<ReadOutcome | null> {
  const spec = readSpecFor(deskId, readId);
  if (spec === undefined || spec.cursorKey === undefined) return null;
  return loadRead(ctx, { ...spec, input: { ...spec.input, cursor } });
}

/** Any set of reads, in parallel, one call per distinct procedure and input; keyed by read id. */
export async function loadReads(
  ctx: FounderCallContext,
  specs: readonly ReadSpec[],
  now: Date = new Date(),
): Promise<Record<string, ReadOutcome>> {
  const groups = new Map<string, ReadSpec[]>();
  for (const spec of specs) {
    const key = JSON.stringify([spec.module, spec.procedure, inputFor(spec, now) ?? null, spec.sendEmptyInput === true]);
    groups.set(key, [...(groups.get(key) ?? []), spec]);
  }
  const outcomes = (await Promise.all([...groups.values()].map((group) => loadGroup(ctx, group, now)))).flat();
  return Object.fromEntries(outcomes.map((o) => [o.id, o]));
}

/** `sections`, when given, reads only those sections of the desk (the mining desk is the More modules desk's mining section). */
export async function loadDesk(
  ctx: FounderCallContext,
  deskId: OpsDeskId,
  now: Date = new Date(),
  sections?: readonly string[],
): Promise<DeskView> {
  const desk = DESKS[deskId];
  const reads = allReads(sections ? { ...desk, sections: desk.sections.filter((s) => sections.includes(s.id)) } : desk);
  return { deskId, asOf: now.toISOString(), reads: await loadReads(ctx, reads, now) };
}
