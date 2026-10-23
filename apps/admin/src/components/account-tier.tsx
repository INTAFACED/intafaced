'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  ACCOUNT_TIER_TERM_KEYS,
  type AccountTier,
  type AccountTierList,
  type AccountTierResult,
  type AccountTierState,
} from '@intafaced/contracts';
import { ControlDesk } from '@/components/control-desk';

const TERM_LABEL: Record<(typeof ACCOUNT_TIER_TERM_KEYS)[number], string> = {
  ratePercent: 'Rate (% a year)',
  monthlyFee: 'Monthly fee',
  feeAssetId: 'Fee and limit asset',
  dailyLimit: 'Daily limit',
  clearingDays: 'Clearing (days)',
};

function blankTerms(tier: AccountTier): string[] {
  return ACCOUNT_TIER_TERM_KEYS.filter((key) => tier.terms[key] === null);
}

/**
 * Account product tier of one identity account (J-ops-console-04 #11): the tiers the owner published with their terms,
 * the tier the account is on, and a move onto another tier as a two-founder request (you propose, the other founder
 * approves on their own console, you run it). A tier with a blank term cannot be chosen, and identity refuses it too.
 */
export function AccountTierPanel({ userId, founderId, onChanged }: { userId: string; founderId: string; onChanged: () => void }) {
  const [list, setList] = useState<AccountTierList | null>(null);
  const [state, setState] = useState<AccountTierState | null>(null);
  const [history, setHistory] = useState<AccountTierResult[]>([]);
  const [error, setError] = useState('');
  const [tierId, setTierId] = useState('');

  const load = useCallback(async () => {
    setError('');
    const id = encodeURIComponent(userId.toLowerCase());
    const [listResponse, stateResponse, historyResponse] = await Promise.all([
      fetch('/api/accounts/tier?list=true', { cache: 'no-store' }),
      fetch(`/api/accounts/tier?id=${id}`, { cache: 'no-store' }),
      fetch(`/api/accounts/tier?id=${id}&history=true&limit=50`, { cache: 'no-store' }),
    ]);
    if (!listResponse.ok || !stateResponse.ok || !historyResponse.ok) {
      setState(null);
      setError('Identity (svc-identity) did not answer for this account’s tier. Nothing can be moved until it does.');
      return;
    }
    setList((await listResponse.json()) as AccountTierList);
    setState((await stateResponse.json()) as AccountTierState | null);
    setHistory((await historyResponse.json()) as AccountTierResult[]);
  }, [userId]);

  useEffect(() => {
    void load().catch(() => setError('Identity (svc-identity) did not answer for this account’s tier.'));
  }, [load]);

  const refresh = () => {
    void load().catch(() => setError('The tier could not be read again. Inspect the account again.'));
    onChanged();
  };

  const tiers = list?.configured ? list.tiers : [];
  const chosen = tiers.find((tier) => tier.id === tierId);
  const current = state?.tierId ? tiers.find((tier) => tier.id === state.tierId) : undefined;
  const blocked = !list
    ? null
    : !list.configured
      ? 'The owner has not published the account tiers (IDENTITY_ACCOUNT_TIERS), so no account can be moved (identity.account_tiers_unset).'
      : userId.toLowerCase() === founderId.toLowerCase()
        ? 'You cannot move your own account; the other founder can (identity.tier_self_forbidden).'
        : chosen && blankTerms(chosen).length > 0
          ? `Tier ${chosen.name} has blank terms (${blankTerms(chosen)
              .map((key) => TERM_LABEL[key as keyof typeof TERM_LABEL].toLowerCase())
              .join(', ')}), so it cannot be assigned (identity.tier_terms_unset).`
          : null;

  return (
    <div className="adm-control-card" data-testid="account-tier">
      <h2>Product tier</h2>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p className="adm-subtle">Reading the account’s tier…</p>}
      {state && list && (
        <>
          <p data-testid="account-tier-status">
            <strong>
              {state.tierId === null
                ? 'Not on a tier'
                : current
                  ? `Tier: ${current.name} (${current.id})`
                  : `Tier: ${state.tierId} (no longer in the owner’s tier list)`}
            </strong>
            <span className="adm-subtle"> · tier version {state.version}</span>
          </p>
          {list.configured ? (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-tier-list">
                <caption className="adm-sr-only">Tiers the owner published, with their terms</caption>
                <thead>
                  <tr>
                    <th>Tier</th>
                    {ACCOUNT_TIER_TERM_KEYS.map((key) => (
                      <th key={key}>{TERM_LABEL[key]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.tiers.map((tier) => (
                    <tr key={tier.id}>
                      <td>
                        {tier.name} <span className="adm-subtle">({tier.id})</span>
                      </td>
                      {ACCOUNT_TIER_TERM_KEYS.map((key) => (
                        <td key={key}>{tier.terms[key] ?? 'not set'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="adm-subtle" data-testid="account-tier-unset">
              No tiers: the owner has not published them (identity.account_tiers_unset).
            </p>
          )}
          {list.configured && (
            <label className="adm-field">
              Move to tier
              <select value={tierId} onChange={(event) => setTierId(event.target.value)}>
                <option value="">Choose a tier</option>
                {list.tiers
                  .filter((tier) => tier.id !== state.tierId)
                  .map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {tier.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <ControlDesk
            key={`tier:${userId}:${state.version}:${tierId}`}
            endpoint="/api/accounts/tier"
            userId={founderId}
            blockedReason={blocked}
            formHold={tierId === '' ? 'Choose a tier first.' : null}
            action={
              blocked
                ? null
                : {
                    heading: 'Move this account to another tier',
                    submitLabel: 'Ask the other founder to approve the tier move',
                    needsReason: true,
                    reasonLabel: 'Why (kept in the account’s tier history, 12 to 255 characters)',
                    build: (why) => ({
                      kind: 'identity.account.tier_move',
                      userId: userId.toLowerCase(),
                      tierId,
                      reason: why,
                      version: state.version,
                    }),
                  }
            }
            consequence="Both founders must agree: you make the request here, the other founder pastes the packet on their own console and approves it, and then you run it. A tier carries fees and limits, so identity accepts only a founder as the approver and checks again when it runs. No money moves."
            blockedButtonLabel="Tier move unavailable"
            onChanged={refresh}
          />
          <h3>Tier history</h3>
          {history.length === 0 ? (
            <p>No recorded tier moves.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-tier-history">
                <caption className="adm-sr-only">Most recent 50 tier move attempts</caption>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Tier</th>
                    <th>Outcome</th>
                    <th>Actor</th>
                    <th>Approved by</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((event) => (
                    <tr key={event.auditId}>
                      <td>{new Date(event.occurredAt).toLocaleString()}</td>
                      <td>{event.outcome === 'changed' ? `${event.before.tierId ?? 'none'} → ${event.tierId}` : event.tierId}</td>
                      <td>
                        {event.outcome === 'refused' ? `refused (${event.code})` : event.outcome}
                        {event.outcome === 'refused' && event.blankTerms ? ` · blank: ${event.blankTerms.join(', ')}` : ''}
                      </td>
                      <td>{event.actorUserId?.slice(0, 8) ?? 'Unauthenticated'}</td>
                      <td>{event.outcome === 'changed' ? event.approverUserId.slice(0, 8) : '—'}</td>
                      <td>{event.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
