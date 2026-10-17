'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { AuditRow } from '@/lib/trade-ops/audit-rows';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { validateUserId } from '@/lib/trade-ops/restrictions';
import { ReadProblem } from './blocker-panel';
import { AuditTable } from './audit-table';

/** Restriction history by user id, read when asked (the service keeps this per account, not as one feed). */
export function AuditRestrictions({ initialUserId = '' }: { initialUserId?: string }) {
  const [userId, setUserId] = useState(initialUserId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ userId: string; outcome: Outcome<AuditRow[]> } | null>(null);
  const check = userId.trim() ? validateUserId(userId) : null;

  async function load() {
    const u = validateUserId(userId);
    if (!u.ok) return;
    setBusy(true);
    const outcome = await tradeOpsAction<AuditRow[]>('audit', { action: 'restriction_history', userId: u.value, limit: 200 });
    setBusy(false);
    setResult({ userId: u.value, outcome });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Account user id"
          error={check && !check.ok ? check.message : undefined}
          density="dense"
          className="w-[26rem] max-w-full"
        >
          <Input
            value={userId}
            onValueChange={setUserId}
            density="dense"
            autoComplete="off"
            spellCheck={false}
            placeholder="3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f"
          />
        </Field>
        <Button type="button" variant="secondary" shape="rounded" size={32} loading={busy} disabled={!check?.ok} onClick={load}>
          Load history
        </Button>
        {result?.outcome.kind === 'ok' ? <p className="pb-2 text-xs text-fg-3">Read {result.outcome.asOf.slice(11, 19)} UTC</p> : null}
      </div>
      {!result ? <p className="text-sm text-fg-2">Enter a user id to read that account's restriction history.</p> : null}
      {result?.outcome.kind === 'ok' ? (
        <AuditTable
          label={`Restriction history of ${result.userId}`}
          rows={result.outcome.data}
          emptyText="The service has no restriction entries for this account."
        />
      ) : null}
      {result && result.outcome.kind !== 'ok' ? <ReadProblem outcome={result.outcome} title="Restriction history not read" /> : null}
    </div>
  );
}
