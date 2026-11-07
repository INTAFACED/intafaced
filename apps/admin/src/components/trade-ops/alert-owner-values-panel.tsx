'use client';

import { useState } from 'react';
import { Badge, Input } from '@intafaced/ui';
import { PageSection } from './kit';
import { ConfirmAction } from './confirm-action';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { READ_ONLY_TEXT, parseWholeNumberText } from '@/lib/trade-ops/charts-owner-values-model';
import { keyLabel, sourceText, valueText, type AlertOwnerValuesView, type OwnerValueView } from '@/lib/trade-ops/alert-owner-values-model';
import type { Outcome } from '@/lib/trade-ops/outcome';

const slotOf = (v: OwnerValueView) => `${v.key}:${v.plan ?? ''}`;
const utcSecond = (iso: string) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

/**
 * The alert owner values svc-notify enforces (J-charts-desk-18 #5 #6): the price-alert quota per plan and the trigger-log
 * retention. Each row says what applies now and where it comes from; a save needs a reason and is kept in the history with
 * who and when. A blank value clears it to "Not set", and the customer action that needs it refuses.
 */
export function AlertOwnerValuesPanel({ initial }: { initial: AlertOwnerValuesView }) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const rows = [...view.quotas, view.triggerLogDays];
  return (
    <div className="flex flex-col gap-6">
      <PageSection title="Alerts (notification service)">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-2">
            A plan is the account&apos;s verification level. A price alert past its plan&apos;s quota is refused; a blank quota refuses
            every price alert for that plan.
          </p>
          <table className="w-full text-sm" aria-label="Alert owner values">
            <thead>
              <tr className="text-left text-fg-3">
                <th scope="col" className="py-1 pr-4">
                  Setting
                </th>
                <th scope="col" className="py-1 pr-4">
                  Current
                </th>
                <th scope="col" className="py-1 pr-4">
                  Source
                </th>
                <th scope="col" className="py-1 pr-4">
                  New value (blank clears it)
                </th>
                <th scope="col" className="py-1 pr-4" />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const label = keyLabel(v.key, v.plan);
                const slot = slotOf(v);
                const text = draft[slot] ?? (v.value === null ? '' : String(v.value));
                const typed = parseWholeNumberText(text);
                const unchanged = typed.ok && typed.value === v.value;
                const disabledReason = !view.canWrite
                  ? READ_ONLY_TEXT
                  : !typed.ok
                    ? typed.message
                    : unchanged
                      ? 'Nothing to change.'
                      : undefined;
                return (
                  <tr key={slot} data-key={v.key} data-plan={v.plan ?? undefined} data-source={v.source} className="border-t border-line">
                    <th scope="row" className="py-1 pr-4 text-left font-medium">
                      {label}
                    </th>
                    <td className="py-1 pr-4" data-field="current" data-value={v.value ?? undefined}>
                      {v.value === null ? (
                        <Badge tone="neutral" variant="outline" density="dense">
                          Not set
                        </Badge>
                      ) : (
                        <span className="if-num">{v.value}</span>
                      )}
                    </td>
                    <td className="py-1 pr-4 text-fg-2" data-field="source">
                      {sourceText(v)}
                      {v.updatedAt ? `, ${utcSecond(v.updatedAt)} by ${v.operatorId}` : ''}
                    </td>
                    <td className="py-1 pr-4">
                      <Input
                        aria-label={`${label}: new value`}
                        value={text}
                        onValueChange={(next) => setDraft((prev) => ({ ...prev, [slot]: next }))}
                        density="dense"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!view.canWrite}
                        aria-invalid={!typed.ok}
                      />
                    </td>
                    <td className="py-1 pr-4">
                      <ConfirmAction
                        trigger="Save"
                        title={`Change ${label}?`}
                        consequence={`${label} changes from ${valueText(v.value)} to ${
                          typed.ok && typed.value !== null ? typed.value : 'not set'
                        }. Customers see the new value at once.`}
                        confirmLabel="Save value"
                        reasonMin={12}
                        disabled={disabledReason !== undefined}
                        disabledReason={disabledReason}
                        run={(reason): Promise<Outcome<unknown>> =>
                          tradeOpsAction<AlertOwnerValuesView>('alert-settings', {
                            action: 'set',
                            key: v.key,
                            plan: v.plan,
                            value: text,
                            expectedVersion: v.version,
                            reason,
                          })
                        }
                        onDone={(o) => {
                          if (o.kind !== 'ok') return;
                          setView(o.data as AlertOwnerValuesView);
                          setDraft((prev) => {
                            const next = { ...prev };
                            delete next[slot];
                            return next;
                          });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PageSection>
      <PageSection title="Alert settings history">
        {view.history.length === 0 ? (
          <p className="text-sm text-fg-2">Nothing has been changed on this page yet.</p>
        ) : (
          <table className="w-full text-sm" aria-label="Alert settings changes">
            <thead>
              <tr className="text-left text-fg-3">
                <th scope="col" className="py-1 pr-4">
                  When
                </th>
                <th scope="col" className="py-1 pr-4">
                  Who
                </th>
                <th scope="col" className="py-1 pr-4">
                  Setting
                </th>
                <th scope="col" className="py-1 pr-4">
                  Old
                </th>
                <th scope="col" className="py-1 pr-4">
                  New
                </th>
                <th scope="col" className="py-1 pr-4">
                  Reason
                </th>
              </tr>
            </thead>
            <tbody>
              {view.history.map((h) => (
                <tr key={h.id} data-change={h.id} data-key={h.key} data-plan={h.plan ?? undefined} className="border-t border-line">
                  <td className="py-1 pr-4 tabular-nums" data-field="at" data-at={h.at}>
                    {utcSecond(h.at)}
                  </td>
                  <td className="py-1 pr-4" data-field="who">
                    {h.operatorId}
                  </td>
                  <td className="py-1 pr-4">{keyLabel(h.key, h.plan)}</td>
                  <td className="py-1 pr-4" data-field="old">
                    {valueText(h.oldValue)}
                  </td>
                  <td className="py-1 pr-4" data-field="new">
                    {valueText(h.newValue)}
                  </td>
                  <td className="py-1 pr-4" data-field="reason">
                    {h.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PageSection>
    </div>
  );
}
