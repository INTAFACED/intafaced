'use client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { StaffHold, StaffHoldList } from '@intafaced/contracts/ops-staff-holds';
import { STAFF_HOLD_AMOUNT_PATTERN, STAFF_HOLD_ASSET_PATTERN, STAFF_HOLD_REASON_MAX } from '@intafaced/contracts/ops-staff-holds';
import { ControlDesk } from '@/components/control-desk';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { HOLD_STATE_LABEL, holdActionable, movementLine, placeKey } from '@/lib/accounts/holds';
import type { RefusalView } from '@/lib/desk/refusal-copy';

type Loaded = { readonly list: StaffHoldList; readonly writes: RefusalView | null };
type PlaceReply = { ok: true; detail: string } | { ok: false; refusal: RefusalView | null };

function Refusal({ refusal, testId }: { refusal: RefusalView; testId: string }) {
  return (
    <div className="adm-alert" role="alert" data-testid={testId}>
      <strong>{refusal.title}</strong>
      <p>{refusal.body}</p>
      <p className="adm-subtle">{refusal.next}</p>
      {refusal.code && <p className="adm-subtle">Code: {refusal.code}</p>}
    </div>
  );
}

function HoldRow({ hold }: { hold: StaffHold }) {
  return (
    <tr data-testid="hold-row" data-hold-no={hold.holdNo}>
      <td>{hold.holdNo}</td>
      <td>
        {hold.amount} {hold.assetId}
      </td>
      <td data-testid="hold-remaining">
        {hold.remaining} {hold.assetId}
      </td>
      <td data-testid="hold-state">{HOLD_STATE_LABEL[hold.state]}</td>
      <td>{hold.reason}</td>
      <td>{hold.expiresAt ? new Date(hold.expiresAt).toLocaleString() : 'No expiry'}</td>
      <td>
        <ul className="adm-plain-list">
          {hold.movements.map((m) => (
            <li key={`${m.kind}:${m.no}`} data-testid="hold-movement">
              {movementLine(m)} · key {m.idempotencyKey}
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

/**
 * Staff holds on one customer's funds (J-ops-console-04 #2-#5). A hold needs one founder and a reason; releasing or confirming
 * it needs a second founder. The value never sits in the console or in svc-ops: it is in the customer's own ledger pot for the
 * hold, and every post svc-ops made for it is listed with its ledger key.
 */
export function AccountHolds({
  userId,
  founderId,
  readOnly = null,
}: {
  userId: string;
  founderId: string;
  /**
   * Why no new hold may be placed or confirmed (an archived record), or null. A confirm moves held money onward, so it is a
   * new movement and is off too; only releasing a hold already placed stays open, so no money is stranded (lead's ruling,
   * 2026-10-31, J-ops-console-04 #10).
   */
  readOnly?: string | null;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<RefusalView | string | null>(null);
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [placeReply, setPlaceReply] = useState<PlaceReply | null>(null);
  const [holdNo, setHoldNo] = useState('');
  const [releaseAmount, setReleaseAmount] = useState('');

  const id = userId.toLowerCase();
  const uid = useId();
  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/accounts/holds?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as ({ ok: true } & Loaded) | { ok: false; refusal: RefusalView | null } | null;
    if (!body || !body.ok) {
      setLoaded(null);
      setError(
        body && !body.ok && body.refusal
          ? body.refusal
          : 'svc-ops did not answer for this account’s holds. Nothing is shown rather than a guess.',
      );
      return;
    }
    setLoaded({ list: body.list, writes: body.writes });
  }, [id]);

  useEffect(() => {
    void load().catch(() => setError('svc-ops did not answer for this account’s holds.'));
  }, [load]);

  const holds = loaded?.list.holds ?? [];
  const settings = loaded?.list.settings;
  const chosen = useMemo(() => holds.find((h) => h.holdNo === holdNo && holdActionable(h)) ?? null, [holds, holdNo]);
  const open = holds.filter(holdActionable);
  // Derived from the list, never random: asking again before the list shows the hold sends the same key (placeKey).
  const key = placeKey(id, holds);

  const expiry = hours.trim() === '' ? null : Number(hours);
  const placeWhy = readOnly
    ? readOnly
    : !loaded
      ? 'The holds are still being read.'
      : loaded.writes
        ? loaded.writes.body
        : !STAFF_HOLD_ASSET_PATTERN.test(assetId)
          ? 'Give the coin, for example USDT.'
          : !STAFF_HOLD_AMOUNT_PATTERN.test(amount) || !/[1-9]/.test(amount)
            ? 'Give an amount above zero, as a plain decimal.'
            : reason.trim() === '' || reason.trim().length > STAFF_HOLD_REASON_MAX
              ? `Give a reason of 1 to ${STAFF_HOLD_REASON_MAX} characters.`
              : expiry !== null && !(Number.isInteger(expiry) && expiry >= 1)
                ? 'Give the expiry as whole hours, or leave it blank for no expiry.'
                : expiry !== null && settings?.expiryMaxHours === null
                  ? 'The owner has set no longest hold expiry, so a hold cannot be given one. Leave it blank.'
                  : expiry !== null && settings?.expiryMaxHours != null && expiry > settings.expiryMaxHours
                    ? `A hold may expire in at most ${settings.expiryMaxHours} hours.`
                    : null;

  async function place() {
    if (busy || placeWhy) return;
    setBusy(true);
    setPlaceReply(null);
    try {
      const res = await fetch('/api/accounts/holds/place', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await founderMutationHeaders()) },
        body: JSON.stringify({ userId: id, assetId, amount, reason: reason.trim(), expiresInHours: expiry, idempotencyKey: key }),
      });
      const body = (await res.json().catch(() => null)) as PlaceReply | null;
      setPlaceReply(body ?? { ok: false, refusal: null });
    } catch {
      setPlaceReply({ ok: false, refusal: null });
    } finally {
      setBusy(false);
      void load().catch(() => undefined);
    }
  }

  const hold = chosen;
  const releaseOk = hold !== null && STAFF_HOLD_AMOUNT_PATTERN.test(releaseAmount) && /[1-9]/.test(releaseAmount);
  // Only the treasury credential's holder may ask (svc-ops spends the approval for the founder who proposed it). The approver's
  // workbench stays open to everyone, so this goes on the request form, not on the whole desk.
  const askHold = loaded?.writes?.body ?? (!hold ? 'Choose a hold that still holds something.' : null);
  const consequence =
    'Two different people must agree: you make the request here, a different founder pastes the packet on their own console and approves it, and then you run it. svc-ops posts it in the ledger and spends the approval once.';

  return (
    <div className="adm-control-card" data-testid="account-holds">
      <h2>Holds on funds</h2>
      <p className="adm-subtle">
        A hold keeps part of this customer’s balance from being spent or withdrawn: their available balance falls and their total does not.
        It stays in their own ledger balance for the hold, never in this console or in svc-ops.
      </p>
      {error &&
        (typeof error === 'string' ? (
          <p className="adm-alert" role="alert">
            {error}
          </p>
        ) : (
          <Refusal refusal={error} testId="holds-failed" />
        ))}
      {!loaded && !error && <p className="adm-subtle">Reading the account’s holds…</p>}
      {loaded && (
        <>
          <dl className="adm-dl" data-testid="hold-settings">
            <dt>Longest expiry</dt>
            <dd>{settings?.expiryMaxHours === null ? 'Not set: no hold can be given an expiry.' : `${settings?.expiryMaxHours} hours`}</dd>
            <dt>Where a confirmed hold goes</dt>
            <dd>{settings?.confirmAccountSet ? 'The owner-named account.' : 'Not set: confirm refuses (owner.decision).'}</dd>
          </dl>
          {holds.length === 0 ? (
            <p data-testid="holds-empty">svc-ops holds nothing on this account.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="holds-table">
                <caption className="adm-sr-only">Staff holds on this account, newest first</caption>
                <thead>
                  <tr>
                    <th>Hold</th>
                    <th>Held</th>
                    <th>Still held</th>
                    <th>State</th>
                    <th>Reason</th>
                    <th>Expires</th>
                    <th>Ledger posts</th>
                  </tr>
                </thead>
                <tbody>
                  {holds.map((h) => (
                    <HoldRow key={h.holdNo} hold={h} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Place a hold</h3>
          <form
            className="adm-stack"
            data-testid="hold-place"
            onSubmit={(event) => {
              event.preventDefault();
              void place();
            }}
          >
            <label className="adm-field">
              Coin
              <input value={assetId} onChange={(e) => setAssetId(e.target.value.trim().toUpperCase())} placeholder="USDT" />
            </label>
            <label className="adm-field">
              Amount to hold
              <input value={amount} onChange={(e) => setAmount(e.target.value.trim())} inputMode="decimal" />
            </label>
            <label className="adm-field">
              Reason (kept with the hold, at most {STAFF_HOLD_REASON_MAX} characters)
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={STAFF_HOLD_REASON_MAX} />
            </label>
            <label className="adm-field">
              Expires in hours (blank for no expiry)
              <input value={hours} onChange={(e) => setHours(e.target.value.trim())} inputMode="numeric" />
            </label>
            {placeWhy && (
              <p className="adm-subtle" data-testid="hold-place-why">
                {placeWhy}
              </p>
            )}
            <button type="submit" className="adm-button" disabled={busy || placeWhy !== null}>
              {busy ? 'Placing…' : 'Place the hold'}
            </button>
          </form>
          {placeReply &&
            (placeReply.ok ? (
              <p role="status" data-testid="hold-place-reply">
                {placeReply.detail}
              </p>
            ) : placeReply.refusal ? (
              <Refusal refusal={placeReply.refusal} testId="hold-place-reply" />
            ) : (
              <p className="adm-alert" role="alert" data-testid="hold-place-reply">
                It is not known whether the hold was placed. Asking again with the same details is safe: svc-ops returns the hold it stored.
              </p>
            ))}

          <h3>Release or confirm a hold</h3>
          <div className="adm-field">
            <label htmlFor={`${uid}hold`}>Hold</label>
            <select id={`${uid}hold`} value={holdNo} onChange={(e) => setHoldNo(e.target.value)}>
              <option value="">Choose a hold</option>
              {open.map((h) => (
                <option key={h.holdNo} value={h.holdNo}>
                  Hold {h.holdNo}: {h.remaining} {h.assetId} still held
                </option>
              ))}
            </select>
          </div>
          <label className="adm-field">
            Amount to release
            <input value={releaseAmount} onChange={(e) => setReleaseAmount(e.target.value.trim())} inputMode="decimal" />
          </label>
          <div data-testid="hold-release">
            <ControlDesk
              key={`release:${id}`}
              endpoint="/api/accounts/holds"
              userId={founderId}
              blockedReason={null}
              formHold={askHold ?? (!releaseOk ? 'Give the amount to release, above zero.' : null)}
              action={{
                heading: 'Release part or all of the hold',
                submitLabel: 'Ask a second founder to approve the release',
                needsReason: true,
                reasonLabel: 'Why (shown to the approver, 12 to 500 characters)',
                build: (why) => ({
                  kind: 'ops.hold.release',
                  holdNo: hold?.holdNo ?? '1',
                  userId: id,
                  assetId: hold?.assetId ?? 'USD',
                  amount: releaseAmount || '0',
                  reason: why,
                }),
              }}
              consequence={consequence}
              blockedButtonLabel="Release unavailable"
              onChanged={() => void load().catch(() => undefined)}
            />
          </div>
          <div data-testid="hold-confirm">
            <ControlDesk
              key={`confirm:${id}`}
              endpoint="/api/accounts/holds"
              userId={founderId}
              blockedReason={
                readOnly
                  ? readOnly
                  : settings && !settings.confirmAccountSet
                    ? 'The owner has not named the account a confirmed hold moves to, so svc-ops refuses a confirm (owner.decision) before any approval is spent.'
                    : null
              }
              formHold={askHold}
              action={{
                heading: 'Confirm the hold',
                submitLabel: 'Ask a second founder to approve the confirm',
                needsReason: true,
                reasonLabel: 'Why (shown to the approver, 12 to 500 characters)',
                danger: true,
                build: (why) => ({
                  kind: 'ops.hold.confirm',
                  holdNo: hold?.holdNo ?? '1',
                  userId: id,
                  assetId: hold?.assetId ?? 'USD',
                  reason: why,
                }),
              }}
              consequence={`${consequence} A confirm moves whatever is still held when it runs out of the customer’s balance.`}
              blockedButtonLabel="Confirm unavailable"
              onChanged={() => void load().catch(() => undefined)}
            />
          </div>
        </>
      )}
    </div>
  );
}
