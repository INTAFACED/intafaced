import type { MerchantControlProfile, PayHaltEvent } from '@intafaced/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsTable } from './approvals-queue';
import { RefusalBlock } from './registry-form';
import { DecisionPanel, DecisionResult, ApprovalDecision, type DecisionSubject } from './approval-decision';
import { ConfirmChangeView } from './confirm-change-panel';
import { ControlChangeForm, currentAsChange, ReviewStage, SubmittedStage } from './control-change-form';
import { AutoTripCard, HaltHistoryTable, HaltStatesTable, PendingClearsGap } from './halts-panels';
import { postControl } from '@/lib/merchants/control-client';
import { makeHandoff, type ControlChange, type TierView } from '@/lib/merchants/control-model';

const html = (el: unknown) => renderToStaticMarkup(el as never);
const MID = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const hash = `sha256:${'b'.repeat(64)}`;

const tier: TierView = {
  id: 'standard',
  name: 'Standard',
  archetype: 'standard',
  caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '5000' }],
  reserve: null,
  approvalThresholds: [{ assetCode: 'USDT', amount: '100' }],
  founderThresholds: [{ assetCode: 'USDT', amount: '1000' }],
  approvalTtlSeconds: 3600,
  version: '1',
  merchants: 2,
};
const unconfigured: MerchantControlProfile = {
  merchantId: MID,
  tierId: null,
  archetypeId: null,
  caps: null,
  pricing: null,
  reserve: null,
  version: '0',
  updatedAt: null,
};
const capsChange: ControlChange = { kind: 'set_caps', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '2500' }] };

describe('change form, edit stage', () => {
  const render = (over: Partial<Parameters<typeof ControlChangeForm>[0]> = {}) =>
    html(<ControlChangeForm merchantId={MID} profile={unconfigured} tiers={[tier]} tiersReadable merchantRules={[]} {...over} />);

  it('starts blank for an unconfigured merchant: no default number anywhere, and says blank stays unconfigured', () => {
    const out = render();
    expect(out).toContain('Nothing here has a default number');
    expect(out).toContain('Choose a tier');
    expect(out).toContain('Review change');
    expect(out).toContain('Version 0 of this merchant');
    expect(out).not.toMatch(/value="\d/);
  });

  it('offers the four kinds as a labelled group and a required reason with a hint', () => {
    const out = render();
    for (const label of ['Tier', 'Caps', 'Pricing', 'Reserve']) expect(out).toContain(`<span>${label}</span>`);
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('Reason');
    expect(out).toContain('At least 3 characters');
  });

  it('only tiers an owner has defined can be chosen; an unreadable tier list turns the choice off instead of guessing', () => {
    expect(render()).toContain('Standard (standard), 2 merchants');
    const off = render({ tiers: [], tiersReadable: false });
    expect(off).toContain('Tier list unavailable');
    expect(off).toContain('disabled');
  });

  it('starts from the merchant’s own current values where they exist', () => {
    const out = render({ profile: { ...unconfigured, tierId: 'standard', archetypeId: 'psp', version: '7' } });
    expect(out).toContain('Version 7');
    expect(out).toMatch(/<option value="standard" selected/);
  });
});

describe('change form, review and waiting stages', () => {
  it('review shows in force now next to after, the reason, and that submitting only records the request', () => {
    const out = html(
      <ReviewStage
        change={capsChange}
        reason="Raise the cap"
        profile={{ ...unconfigured, caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '1000' }] }}
        tiers={[tier]}
      />,
    );
    expect(out).toContain('In force now');
    expect(out).toContain('After the second founder confirms');
    expect(out).toContain('1,000.00 USDT');
    expect(out).toContain('2,500.00 USDT');
    expect(out).toContain('Raise the cap');
    expect(out).toContain('Submitting only records the request');
    expect(out).toContain('Submit for the second founder');
  });

  it('review of something that was never configured says so rather than showing a number', () => {
    const out = html(<ReviewStage change={capsChange} reason="First caps" profile={unconfigured} tiers={[]} />);
    expect(out).toContain('Not configured: payments refuse');
  });

  it('a submit in flight disables the button (double click safe) and a refusal is plain English', () => {
    const busy = html(<ReviewStage change={capsChange} reason="r" profile={unconfigured} tiers={[]} busy />);
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Submitting…/);
    const refused = html(
      <ReviewStage
        change={capsChange}
        reason="r"
        profile={unconfigured}
        tiers={[]}
        refusal={{ title: 'This changed', body: 'It moved.', next: 'Reload.', code: 'pay.change_not_found', requestId: 'req-9' }}
      />,
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('Request reference: req-9');
    expect(refused).not.toContain('pay.change_not_found');
  });

  it('after a successful submit it says waiting for a second founder, that nothing changed yet, and hands over the request', () => {
    const out = html(
      <SubmittedStage
        outcome="pending_second_approval"
        merchantId={MID}
        requestId={REQ}
        expectedVersion="0"
        change={capsChange}
        reason="r"
      />,
    );
    expect(out).toContain('Waiting for a second founder');
    expect(out).toContain('recorded but not applied');
    expect(out).toContain('Today’s values stay in force');
    expect(out).toContain(REQ);
    expect(out).toContain('Copy request for the second founder');
  });

  it('every other outcome is explained and none of them claims a change was made, except "changed"', () => {
    const out = (outcome: Parameters<typeof SubmittedStage>[0]['outcome']) =>
      html(<SubmittedStage outcome={outcome} merchantId={MID} requestId={REQ} expectedVersion="0" change={capsChange} reason="r" />);
    expect(out('noop')).toContain('already the values in force');
    expect(out('conflict')).toContain('changed while you were editing');
    expect(out('conflict')).toContain('role="alert"');
    expect(out('refused')).toContain('refused this change');
    expect(out('changed')).toContain('Changed');
    for (const o of ['noop', 'conflict', 'refused', 'pending_second_approval'] as const) expect(out(o)).not.toMatch(/>Changed</);
  });

  it('currentAsChange reads the section a change touches, null when it is unconfigured', () => {
    expect(currentAsChange('set_caps', unconfigured)).toBeNull();
    expect(currentAsChange('set_tier', { ...unconfigured, tierId: 'standard' })).toEqual({
      kind: 'set_tier',
      tierId: 'standard',
      archetypeId: null,
    });
    expect(currentAsChange('set_reserve', { ...unconfigured, reserve: { rollingReserveBps: null, holdDays: null } })).toMatchObject({
      kind: 'set_reserve',
    });
    expect(currentAsChange('set_pricing', unconfigured)).toBeNull();
  });
});

describe('confirming a change as the second founder', () => {
  const base = { merchantId: MID, tiers: [tier], reason: '' };
  const handoff = makeHandoff({ requestId: REQ, merchantId: MID, expectedVersion: '0', change: capsChange, reason: 'Raise the cap' });
  const parsed = (text: string) => (text ? JSON.parse(text) : null);

  it('empty: labelled paste box and the rule that you cannot confirm your own change', () => {
    const out = html(<ConfirmChangeView {...base} text="" parsed={null} />);
    expect(out).toContain('Confirm a change from another founder');
    expect(out).toContain('for="cf-handoff"');
    expect(out).toContain('cannot confirm a change');
    expect(out).not.toContain('Confirm this change');
  });

  it('a paste that is not a request is refused in words', () => {
    expect(html(<ConfirmChangeView {...base} text="hello" parsed={null} />)).toContain('not a request this page understands');
  });

  it('a request for another merchant is refused and nothing can be sent', () => {
    const other = {
      requestId: REQ,
      merchantId: '44444444-4444-4444-8444-444444444444',
      expectedVersion: '0',
      change: capsChange,
      reason: 'x',
    };
    const out = html(<ConfirmChangeView {...base} text="{}" parsed={other} />);
    expect(out).toContain('different merchant');
    expect(out).not.toContain('Confirm this change');
  });

  it('a good request is read in words, flagged as pasted text, and needs a reason before it can be confirmed', () => {
    const p = { requestId: REQ, merchantId: MID, expectedVersion: '0', change: capsChange, reason: 'Raise the cap' };
    const out = html(
      <ConfirmChangeView {...base} text={handoff} parsed={p} reasonError="Write at least 3 characters: why is this change being made?" />,
    );
    expect(out).toContain('pasted text, not a record from the service');
    expect(out).toContain('2,500.00 USDT');
    expect(out).toContain('Raise the cap');
    expect(out).toContain('Confirm this change');
    expect(out).toContain('Decline');
    expect(out).toContain('aria-invalid="true"');
    expect(parsed(handoff).v).toBe(1);
  });

  it('every result is stated plainly; a mismatch is a loud incident, a conflict says nothing was applied', () => {
    const result = {
      requestId: REQ,
      merchantId: MID,
      outcome: 'changed',
      actorUserId: ME,
      profile: null,
      occurredAt: '2026-10-15T10:00:00.000Z',
    } as const;
    const p = { requestId: REQ, merchantId: MID, expectedVersion: '0', change: capsChange, reason: 'r' };
    const show = (kind: 'confirmed' | 'declined' | 'mismatch' | 'conflict' | 'other') =>
      html(<ConfirmChangeView {...base} text={handoff} parsed={p} done={{ kind, result }} />);
    expect(show('confirmed')).toContain('Confirmed and applied');
    expect(show('mismatch')).toContain('security incident');
    expect(show('mismatch')).toContain('role="alert"');
    expect(show('declined')).toContain('Nothing was changed');
    expect(show('conflict')).toContain('Nothing was');
    expect(show('other')).toContain('did not apply');
  });
});

describe('confirm panel, safety rails', () => {
  const p = { requestId: REQ, merchantId: MID, expectedVersion: '3', change: capsChange, reason: 'Raise the cap' };

  it('an out-of-date request turns confirming off, says why and still allows a decline', () => {
    const out = html(<ConfirmChangeView merchantId={MID} tiers={[tier]} text="{}" parsed={p} stale="5" reason="" />);
    expect(out).toContain('This request is out of date');
    expect(out).toContain('version 5');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Confirm this change/);
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Decline/);
  });

  it('"you already signed this one first" appears with the dual-control refusal and not with others', () => {
    const refusal = (code: string) => ({ title: 'A different founder has to do this step', body: 'b', next: 'n', code, requestId: null });
    expect(html(<RefusalBlock refusal={refusal('pay.dual_control_required')} />)).toContain('You already signed this one first');
    expect(html(<RefusalBlock refusal={refusal('pay.change_not_found')} />)).not.toContain('You already signed this one first');
    expect(
      html(
        <ConfirmChangeView merchantId={MID} tiers={[]} text="" parsed={null} reason="" refusal={refusal('pay.dual_control_required')} />,
      ),
    ).toContain('You already signed this one first');
  });

  it('success says the result matches what you were shown', () => {
    const result = {
      requestId: REQ,
      merchantId: MID,
      outcome: 'changed',
      actorUserId: ME,
      profile: null,
      occurredAt: '2026-10-15T10:00:00.000Z',
    } as const;
    expect(
      html(<ConfirmChangeView merchantId={MID} tiers={[]} text="{}" parsed={p} reason="" done={{ kind: 'confirmed', result }} />),
    ).toContain('matches what you were shown');
  });
});

describe('payout approval decision', () => {
  const subject: DecisionSubject = {
    approvalId: '00000001-0000-4000-8000-000000000000',
    payloadHash: hash,
    amountText: '1,200.50 USDT',
    merchantText: 'Acme Shop',
    createdAt: '2026-10-15T09:00:00.000Z',
    expiresAt: '2026-10-15T21:00:00.000Z',
    tookPart: false,
    expired: false,
  };

  it('starts closed with one button; it is disabled with a stated reason when you took part or it expired', () => {
    expect(html(<ApprovalDecision subject={subject} />)).toContain('Review and decide');
    const mine = html(<ApprovalDecision subject={{ ...subject, tookPart: true }} />);
    expect(mine).toMatch(/<button[^>]*disabled/);
    expect(mine).toContain('A different founder must sign it');
    const gone = html(<ApprovalDecision subject={{ ...subject, expired: true }} />);
    expect(gone).toContain('ran out of time');
  });

  it('review shows what is being signed, the hash it is bound to, and asks for a reason', () => {
    const out = html(<DecisionPanel subject={subject} mode="review" choice="approve" reason="" />);
    expect(out).toContain('1,200.50 USDT');
    expect(out).toContain('Acme Shop');
    expect(out).toContain(hash);
    expect(out).toContain('If amount, destination or rail change, your signature no longer applies');
    expect(out).toContain('Approve…');
    expect(out).toContain('Reject…');
  });

  it('there is a confirm step that says what will happen and that it cannot be undone', () => {
    const approve = html(<DecisionPanel subject={subject} mode="confirm" choice="approve" reason="ok" />);
    expect(approve).toContain('only goes ahead when a different founder also signs');
    expect(approve).toContain('This cannot be undone');
    expect(approve).toContain('Yes, approve');
    const reject = html(<DecisionPanel subject={subject} mode="confirm" choice="reject" reason="no" />);
    expect(reject).toContain('Yes, reject');
    expect(reject).toContain('role="alert"');
  });

  it('a first approval is "waiting for a second founder", not "approved"', () => {
    expect(html(<DecisionResult approval={{ status: 'pending' }} choice="approve" />)).toContain('Waiting for a second founder');
    expect(html(<DecisionResult approval={{ status: 'approved' }} choice="approve" />)).toContain('Fully approved');
    expect(html(<DecisionResult approval={{ status: 'rejected' }} choice="reject" />)).toContain('will not go');
    const voided = html(<DecisionResult approval={{ status: 'voided' }} choice="approve" />);
    expect(voided).toContain('Voided');
    expect(voided).toContain('Nothing was approved');
  });

  it('the queue table gives every row an age, a time-left chip and the decision button', () => {
    const now = new Date('2026-10-15T12:00:00.000Z');
    const row = {
      approvalId: subject.approvalId,
      merchantId: 'a0000001-0000-4000-8000-000000000001',
      settlementId: '50000001-0000-4000-8000-000000000000',
      amount: '1200.5',
      assetCode: 'USDT',
      payloadHash: hash as `sha256:${string}`,
      status: 'pending' as const,
      makerUserId: ME,
      checkerUserId: OTHER,
      createdAt: '2026-10-15T09:00:00.000Z',
      decidedAt: null,
      expiresAt: '2026-10-15T21:00:00.000Z',
    };
    const out = html(<ApprovalsTable rows={[row]} names={new Map([[row.merchantId, 'Acme Shop']])} now={now} currentUserId={ME} />);
    expect(out).toContain('Acme Shop');
    expect(out).toContain('waiting 3 h 0 min');
    expect(out).toContain('expires in 9 h 0 min');
    expect(out).toContain('1,200.50 USDT');
    expect(out).toContain('needs two founders');
    expect(out).toContain('A different founder must sign it');
    expect(out).toContain('role="region"');
  });
});

describe('halt panels', () => {
  it('automatic trip: off means nothing pauses by itself and no default count exists; on states the count', () => {
    const off = html(<AutoTripCard autoTrip={{ enabled: false, consecutiveFailures: null }} />);
    expect(off).toContain('Automatic trip is off');
    expect(off).toContain('no default one');
    const on = html(<AutoTripCard autoTrip={{ enabled: true, consecutiveFailures: 3 }} />);
    expect(on).toContain('3 failures in a row');
    expect(html(<AutoTripCard autoTrip={{ enabled: true, consecutiveFailures: 1 }} />)).toContain('1 failure in a row');
    expect(html(<AutoTripCard autoTrip={{ enabled: true, consecutiveFailures: null }} />)).toContain('Automatic trip is off');
  });

  it('pending clears are an honest "not available yet", not an empty list', () => {
    const out = html(<PendingClearsGap />);
    expect(out).toContain('not available yet');
    expect(out).toContain('no read for it');
  });

  const event = (over: Partial<PayHaltEvent>): PayHaltEvent => ({
    scope: 'payout',
    target: { level: 'global' },
    halted: false,
    reason: 'Rail repaired',
    source: 'operator',
    actorUserId: ME,
    confirmedByUserId: OTHER,
    version: '5',
    changedAt: '2026-10-15T10:00:00.000Z',
    ...over,
  });

  it('history names the second founder on a clear, marks a stop as needing one founder, and flags a clear without one', () => {
    const out = html(
      <HaltHistoryTable
        currentUserId={ME}
        events={[
          event({}),
          event({ halted: true, confirmedByUserId: null, reason: 'Venue failing', version: '4' }),
          event({ confirmedByUserId: null, reason: 'Odd clear', version: '3' }),
          event({ source: 'auto_trip', actorUserId: null, halted: true, confirmedByUserId: null, reason: 'Trip', version: '2' }),
        ]}
      />,
    );
    expect(out).toContain('confirmed by a second founder');
    expect(out).toContain('(you)');
    expect(out).toContain('Not needed: one founder can stop an operation');
    expect(out).toContain('no second founder recorded');
    expect(out).toContain('Automatic trip');
    expect(out).toContain('Paying out');
  });

  it('current switches show running or halted by words, for everyone or one merchant', () => {
    const out = html(
      <HaltStatesTable
        caption="Switches"
        states={[
          {
            scope: 'intake',
            target: { level: 'global' },
            halted: false,
            reason: null,
            source: null,
            actorUserId: null,
            version: '0',
            changedAt: null,
          },
          {
            scope: 'conversion',
            target: { level: 'merchant', merchantId: MID },
            halted: true,
            reason: 'Review',
            source: 'operator',
            actorUserId: ME,
            version: '1',
            changedAt: '2026-10-15T09:00:00.000Z',
          },
        ]}
      />,
    );
    expect(out).toContain('Taking payments');
    expect(out).toContain('Everyone');
    expect(out).toContain('Merchant 22222222…2222');
    expect(out).toContain('running');
    expect(out).toContain('halted');
    expect(out).toContain('never changed');
  });
});

describe('browser client for controls', () => {
  const shown = { merchantId: MID, expectedVersion: '0', change: capsChange };
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the session nonce first and sends it with the request, never a token', async () => {
    const csrf = 'A'.repeat(43);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return url === '/api/session'
          ? Response.json({ csrf })
          : Response.json({ ok: true, result: { outcome: 'pending_second_approval' } });
      }),
    );
    const reply = await postControl({ action: 'confirm', requestId: REQ, ...shown, reason: 'looks right' });
    expect(reply.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/api/session', '/api/merchants/controls']);
    expect((calls[1]!.init!.headers as Record<string, string>)['x-intafaced-csrf']).toBe(csrf);
    expect(String(calls[1]!.init!.body)).not.toMatch(/token/i);
  });

  it('signed out, a gate refusal and a network failure all become plain refusals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    const out = await postControl({ action: 'decline', requestId: REQ, ...shown, reason: 'no' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal.title).toBe('You are signed out');
    const csrf = 'B'.repeat(43);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/session' ? Response.json({ csrf }) : Response.json({ code: 'admin.founder_required' }, { status: 403 }),
      ),
    );
    const gated = await postControl({ action: 'decline', requestId: REQ, ...shown, reason: 'no' });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.refusal.title).toBe('Not allowed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/session') return Response.json({ csrf });
        throw new Error('offline');
      }),
    );
    const down = await postControl({ action: 'decline', requestId: REQ, ...shown, reason: 'no' });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.refusal.body).toContain('nothing was changed');
  });
});
