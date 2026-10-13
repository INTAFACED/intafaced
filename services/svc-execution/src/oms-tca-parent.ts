/**
 * TCA for one parent — only retained EMS fills and a bound capture book.
 *
 * No caller observations, arrival, or decision clock. If those retained
 * inputs are missing, refuse. Never invent a benchmark from fill VWAP.
 * Does not touch matching.
 */
import type { CaptureLake } from '@intafaced/venue-adapter';
import type { EmsOrderStore } from './oms-ems-store.js';
import { runTcaRun, type TcaRunOk } from './oms-tca.js';

export type TcaParentInput = {
  readonly parentClientOrderId?: string;
  readonly emsStore?: EmsOrderStore;
  readonly captureLake?: Pick<CaptureLake, 'records'>;
};

export type TcaParentRefuse = {
  readonly ok: false;
  readonly reason: 'missing_parent' | 'ems_store_unwired' | 'no_ems_evidence' | 'missing_retained_inputs';
  readonly detail: string;
};

export type TcaParentResult = TcaRunOk | TcaParentRefuse;

function retainedClock(emsStore: EmsOrderStore, parentClientOrderId: string): string | null {
  const stamps = emsStore
    .list({ parentClientOrderId })
    .map((row) => row.execution?.executedAt)
    .flatMap((at) => {
      if (!at) return [];
      const parsed = at instanceof Date ? at : new Date(at);
      if (Number.isNaN(parsed.getTime())) return [];
      return [parsed.toISOString()];
    })
    .sort();
  return stamps[0] ?? null;
}

export function runTcaForParent(input: TcaParentInput): TcaParentResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return { ok: false, reason: 'missing_parent', detail: 'parentClientOrderId is required' };
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for a parent TCA run' };
  }

  const rows = input.emsStore.list({ parentClientOrderId });
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'no_ems_evidence',
      detail: 'no EMS journal rows for this parent — refusing to invent fills',
    };
  }

  const arrivalAt = retainedClock(input.emsStore, parentClientOrderId);
  if (!arrivalAt || !input.captureLake) {
    return {
      ok: false,
      reason: 'missing_retained_inputs',
      detail: 'parent TCA needs a retained execution clock and a bound capture book — refusing to invent a benchmark',
    };
  }

  const result = runTcaRun({
    parentClientOrderId,
    arrivalAt,
    emsStore: input.emsStore,
    captureLake: input.captureLake,
  });

  if (!result.ok) {
    const reason: TcaParentRefuse['reason'] = result.reason === 'missing_identity' ? 'missing_parent' : result.reason;
    return { ok: false, reason, detail: result.detail };
  }

  const arrival = result.run.benchmarks.find((row) => row.class === 'arrival');
  if (!arrival || arrival.status !== 'AVAILABLE') {
    const detail = arrival && arrival.status === 'UNAVAILABLE' ? arrival.detail : 'no retained arrival benchmark — refusing to invent one';
    return { ok: false, reason: 'missing_retained_inputs', detail };
  }

  return result;
}
