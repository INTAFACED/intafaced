import { quantApprovalStateSchema, type QuantApprovalState } from '@intafaced/contracts/quant-research';
import { quantApprovalPolicySchema } from '@intafaced/contracts/quant-research';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { researchCopy } from './research-copy';
import { refusalCode, useLastReady } from './StrategyTeam';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utc = (iso: string) => iso.slice(0, 19).replace('T', ' ');

/**
 * Live approval (RC-algo-dev-01; J-algo-dev-16 #4), on the owner's strategy page and on a teammate's view of it. The owner
 * sets the account's policy and asks for a review of a version; a teammate approves or rejects it. Whether the newest
 * version may go live is the service's reading, and the live runner refuses a start the same way.
 */
export function ApprovalPanel({ strategyId, owner }: { strategyId: string; owner: boolean }) {
  const api = useApi();
  const { t } = researchCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const state = useResource(
    (signal) => api.query('quant', 'approval.get', { strategyId }, quantApprovalStateSchema, { signal }),
    `quant-approval:${strategyId}:${revision}`,
  );
  const kept = useLastReady(state.resource);
  const reload = () => setRevision((n) => n + 1);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ code: string; text: string } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [reason, setReason] = useState('');

  async function act(run: () => Promise<ApiResult<unknown>>) {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    const res = await run();
    setBusy(false);
    if (res.ok) return reload();
    const code = refusalCode(res);
    if (code === 'quant.approval_self_review') setRefused({ code, text: t('apSelf') });
    else if (code === 'quant.approval_hash_stale') setRefused({ code, text: t('apStaleRefused') });
    else if (code === 'quant.approval_decided') setRefused({ code, text: t('apDecided') });
    else if (code === 'quant.approval_policy_unset') setRefused({ code, text: t('apRequestUnset') });
    else setFailure(res);
    reload();
  }

  const view = (data: QuantApprovalState) => {
    const pending = data.approvals.find((row) => row.decision === 'pending' && row.current);
    return (
      <>
        <p data-testid="quant-approval-policy" data-required={data.policy.required === null ? '' : String(data.policy.required)}>
          <strong>{t('apPolicy')}: </strong>
          {data.policy.required === null ? t('apPolicyUnset') : data.policy.required ? t('apPolicyOn') : t('apPolicyOff')}
        </p>
        {owner && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.mutate(
                  'quant',
                  'approval.policy.set',
                  {
                    required: data.policy.required !== true,
                    // A business key: this change from the policy as read, so a second press of the same change is one row.
                    idempotencyKey: `from:${data.policy.setAt ?? 'unset'}:to:${data.policy.required !== true}`,
                  },
                  quantApprovalPolicySchema,
                ),
              )
            }
          >
            {data.policy.required === true ? t('apPolicyDrop') : t('apPolicyRequire')}
          </Button>
        )}
        <p data-testid="quant-approval-live" data-allowed={data.live.allowed} data-code={data.live.code ?? ''} data-version={data.version}>
          {data.live.allowed ? t('apLiveAllowed', { version: data.version }) : t('apLiveBlocked', { version: data.version })}
        </p>
        {owner && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.mutate(
                  'quant',
                  'approval.request',
                  { strategyId: data.strategyId, strategyVersion: data.version },
                  quantApprovalStateSchema,
                ),
              )
            }
          >
            {t('apRequest', { version: data.version })}
          </Button>
        )}
        {data.approvals.length === 0 ? (
          <EmptyState title={t('apNone')} />
        ) : (
          <DataTable
            label={t('apTitle')}
            headers={[t('apColVersion'), t('apColDecision'), t('apColReviewer'), t('apColRequested'), t('apColState')]}
          >
            {data.approvals.map((row) => (
              <tr
                key={row.approvalId}
                data-testid="quant-approval-row"
                data-version={row.strategyVersion}
                data-decision={row.decision}
                data-current={row.current}
                data-reviewer={row.reviewer ?? ''}
              >
                <td lang="zxx">{row.strategyVersion}</td>
                <td>
                  {t(`ap_${row.decision}`)}
                  {row.reason ? ` — ${row.reason}` : ''}
                </td>
                <td lang="zxx">{row.reviewer ?? '—'}</td>
                <td lang="zxx">{utc(row.requestedAt)}</td>
                <td>{row.current ? t('apCurrent') : t('apStale')}</td>
              </tr>
            ))}
          </DataTable>
        )}
        {pending && (
          <div data-testid="quant-approval-decide" data-approval-id={pending.approvalId}>
            <Field label={t('apReason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <Button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api.mutate(
                    'quant',
                    'approval.decide',
                    { strategyId: data.strategyId, approvalId: pending.approvalId, decision: 'approved', reason },
                    quantApprovalStateSchema,
                  ),
                )
              }
            >
              {t('apApprove', { version: pending.strategyVersion })}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api.mutate(
                    'quant',
                    'approval.decide',
                    { strategyId: data.strategyId, approvalId: pending.approvalId, decision: 'rejected', reason },
                    quantApprovalStateSchema,
                  ),
                )
              }
            >
              {t('apReject', { version: pending.strategyVersion })}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <section aria-label={t('apTitle')} data-testid="quant-approval">
      <h3>{t('apTitle')}</h3>
      <p className="muted">{t('apIntro')}</p>
      {kept ? (
        view(kept)
      ) : (
        <Read resource={state.resource} retry={state.reload}>
          {() => null}
        </Read>
      )}
      {refused && (
        <p role="alert" data-testid="quant-approval-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <Failure result={failure} />}
    </section>
  );
}
