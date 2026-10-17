'use client';

import { useState } from 'react';
import { Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { MarketRow } from '@/lib/trade-ops/reads';
import { LIMIT_FIELDS, checkLimitEdit, currentValue, isLimitField, type LimitField } from '@/lib/trade-ops/risk-limits-model';
import { ConfirmAction } from './confirm-action';

/**
 * Change one limit on one market. Fully built: the value is checked against the market's own tick and lot rules
 * before anything is asked, a second approver (not you) is required, and the dialog takes the reason. Today the
 * console answers with the typed blocker risk_limits_no_operator_api; nothing is changed.
 */
export function RiskLimitsEdit({ markets, signedInUserId }: { markets: readonly MarketRow[]; signedInUserId: string }) {
  const [symbol, setSymbol] = useState(markets[0]?.symbol ?? '');
  const [field, setField] = useState<LimitField>('tickSize');
  const [value, setValue] = useState('');
  const [second, setSecond] = useState('');
  const market = markets.find((m) => m.symbol === symbol) ?? null;
  const current = market ? currentValue(market, field) : null;
  const check = checkLimitEdit({ symbol, field, value, reason: 'x'.repeat(12), secondApproverId: second }, markets, signedInUserId);
  const problem = check.ok ? null : check;
  const info = LIMIT_FIELDS.find((f) => f.field === field);
  const shown = value !== '' && problem && problem.code.startsWith('risk_limits') ? problem.message : undefined;
  const secondShown = second !== '' && problem?.code === 'missing_operator' ? problem.message : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Market" density="dense">
          <Select
            items={Object.fromEntries(markets.map((m) => [m.symbol, m.symbol]))}
            value={symbol}
            onValueChange={(v) => setSymbol(String(v))}
          >
            <SelectTrigger size={32}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {markets.map((m) => (
                <SelectItem key={m.id} value={m.symbol}>
                  {m.symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Limit" hint={info?.meaning} density="dense">
          <Select
            items={Object.fromEntries(LIMIT_FIELDS.map((f) => [f.field, f.label]))}
            value={field}
            onValueChange={(v) => {
              if (isLimitField(v)) setField(v);
            }}
          >
            <SelectTrigger size={32}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_FIELDS.map((f) => (
                <SelectItem key={f.field} value={f.field}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="New value" hint={`Current: ${current ?? '—'}`} density="dense" error={shown}>
          <Input value={value} onValueChange={setValue} density="dense" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Second approver id" hint="A different operator than you." density="dense" error={secondShown}>
          <Input value={second} onValueChange={setSecond} density="dense" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div>
        <ConfirmAction
          trigger="Change limit"
          title={`Change ${info?.label ?? 'limit'} on ${symbol}?`}
          consequence={`${info?.label ?? 'The limit'} on ${symbol} would change from ${current ?? '—'} to ${value || '—'}. Orders are checked against the new value from then on.`}
          confirmLabel="Change limit"
          reasonMin={12}
          disabled={problem !== null}
          disabledReason={problem?.message}
          run={(reason) => tradeOpsAction('risk-limits', { action: 'edit', symbol, field, value, reason, secondApproverId: second })}
        />
      </div>
    </div>
  );
}
