'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Campaign, CampaignVoucher } from '@intafaced/contracts/campaigns-catalogue';
import { formatWhen } from '@/lib/as-of';
import { fetchVouchers, postRuleAction } from '@/lib/campaigns-ops/builder-browser';

/**
 * VOUCHERS OF A VOUCHER CAMPAIGN (CM-vouchers-coupons-01, CM-campaign-types-01 T-3; J-campaigns-16 #9).
 *
 * A founder issues (publishes) a voucher under the campaign's live revision; it keeps that revision and its reward as its
 * face value, so an approved change of the campaign never changes a voucher already issued. The code is the voucher's
 * key with the campaign: the same code again returns the stored voucher. Claiming and using vouchers is J-campaigns-08.
 */

type Notice = { kind: 'done'; text: string } | { kind: 'refused'; title: string; body: string; code: string | null };

const ISSUES_IN: readonly Campaign['state'][] = ['approved', 'scheduled', 'active', 'paused'];

export function CampaignVouchers({ campaign }: { campaign: Campaign }) {
  const [vouchers, setVouchers] = useState<CampaignVoucher[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    const answer = await fetchVouchers<CampaignVoucher[]>(campaign.id);
    if (answer.ok) {
      setVouchers(answer.data);
      setFailed(null);
    } else setFailed(`${answer.title}. ${answer.body}${answer.code ? ` (${answer.code})` : ''}`);
  }, [campaign.id]);
  // Read again whenever the campaign's live revision changes, so the list sits beside the revision shown above it.
  useEffect(() => void read(), [read, campaign.revision]);

  const issue = async () => {
    setBusy(true);
    setNotice(null);
    const answer = await postRuleAction<CampaignVoucher>({ op: 'voucher-issue', campaignId: campaign.id, code: code.trim() });
    setNotice(
      answer.ok
        ? {
            kind: 'done',
            text: `Issued voucher ${answer.data.code} under revision ${answer.data.revision}: ${answer.data.face.amount} ${answer.data.face.asset}.`,
          }
        : { kind: 'refused', title: answer.title, body: answer.body, code: answer.code },
    );
    await read();
    setBusy(false);
  };

  const issues = ISSUES_IN.includes(campaign.state);
  return (
    <section aria-labelledby="cmp-vouchers-h" data-testid="campaign-vouchers">
      <h2 id="cmp-vouchers-h">Vouchers</h2>
      <p className="dk-muted">
        Each voucher keeps the revision it was issued under, and that revision&apos;s reward per person is its face value. A change approved
        later applies to vouchers issued after it. The face value is a counter, not a balance: nothing is held for a voucher.
      </p>
      {notice?.kind === 'done' && (
        <p role="status" data-testid="voucher-notice">
          {notice.text}
        </p>
      )}
      {notice?.kind === 'refused' && (
        <div role="alert" data-testid="voucher-notice">
          <strong>{notice.title}</strong>
          <p>
            {notice.body}
            {notice.code ? ` (${notice.code})` : ''}
          </p>
          <p>Nothing was issued.</p>
        </div>
      )}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="cmp-voucher-code">Voucher code</label>
          <input id="cmp-voucher-code" maxLength={32} value={code} onChange={(e) => setCode(e.target.value)} />
          <p className="dk-muted">4 to 32 letters, digits or hyphens, stored in capitals.</p>
        </div>
        <button
          type="button"
          className="adm-btn"
          data-variant="primary"
          disabled={busy || !issues || !code.trim()}
          onClick={() => void issue()}
        >
          Issue a voucher
        </button>
      </div>
      {!issues && (
        <p className="dk-muted" data-testid="voucher-not-issuing">
          A voucher is issued once the campaign is approved, and until it ends.
        </p>
      )}
      {failed && (
        <p role="alert" data-testid="vouchers-failed">
          The vouchers could not be read: {failed}
        </p>
      )}
      {vouchers && vouchers.length === 0 && <p data-testid="vouchers-empty">No voucher issued yet.</p>}
      {vouchers && vouchers.length > 0 && (
        <table className="adm-table">
          <caption>Vouchers</caption>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Revision</th>
              <th scope="col">Face value</th>
              <th scope="col">State</th>
              <th scope="col">Issued by</th>
              <th scope="col">Issued</th>
            </tr>
          </thead>
          <tbody>
            {vouchers.map((v) => (
              <tr key={v.id}>
                <td>{v.code}</td>
                <td>Revision {v.revision}</td>
                <td>
                  {v.face.amount} {v.face.asset}
                </td>
                <td>{v.state}</td>
                <td className="dk-packet">{v.issuedBy}</td>
                <td>{formatWhen(v.issuedAt)} (UTC)</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
