import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalWorkbenchView, StepReplyView, type WorkbenchViewProps } from './approval-workbench';
import { decodePacket, encodePacket, type ApprovalPacket } from '@/lib/desk/approval-packet';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const packet: ApprovalPacket = {
  request: { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident <b>x</b>' },
  approvalId: 'appr_1',
  operationId: 'op_1',
  expiresAt: '2026-10-17T03:10:00.000Z',
  requesterId: A,
};
const text = encodePacket(packet);
const base: WorkbenchViewProps = {
  packetText: text,
  reading: decodePacket(text),
  userId: B,
  confirm: '',
  busy: null,
  reply: null,
  blockedReason: null,
  now: new Date('2026-10-17T03:00:00.000Z'),
  onPacketText: () => undefined,
  onConfirm: () => undefined,
  onStep: () => undefined,
};
const render = (over: Partial<WorkbenchViewProps> = {}) => renderToStaticMarkup(<ApprovalWorkbenchView {...base} {...over} />);
const button = (html: string, label: string) => {
  const m = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  if (!m) throw new Error(`no button "${label}"`);
  return m[0];
};

describe('reading a request packet', () => {
  it('shows the second founder, in plain words, exactly what they would approve, escaped', () => {
    const html = render();
    expect(html).toContain('Kill module &quot;trade&quot;');
    expect(html).toContain('market integrity incident &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('Another founder made this request');
    expect(html).toContain('appr_1');
  });
  it('says the console cannot see whether the other founder has approved, instead of guessing', () => {
    expect(render()).toContain('cannot read whether the other founder has approved');
  });
  it('shows nothing actionable for empty, foreign or damaged text, and says which', () => {
    expect(render({ packetText: '', reading: decodePacket('') })).not.toContain('packet-summary');
    expect(render({ packetText: 'hi', reading: decodePacket('hi') })).toContain('That is not a request packet');
    const damaged = 'ifa1.@@@';
    const html = render({ packetText: damaged, reading: decodePacket(damaged) });
    expect(html).toContain('damaged or edited');
    expect(html).not.toContain('Approve this request');
  });
});

describe('which buttons are live', () => {
  it('the second founder, before typing the phrase: only reject is live', () => {
    const html = render();
    expect(button(html, 'Approve this request')).toContain('disabled=""');
    expect(button(html, 'Run the approved request')).toContain('disabled=""');
    expect(button(html, 'Reject')).not.toContain('disabled');
    expect(button(html, 'Withdraw my request')).toContain('disabled=""');
  });
  it('the second founder, with the exact phrase: approve and run are live', () => {
    const html = render({ confirm: 'KILL trade' });
    expect(button(html, 'Approve this request')).not.toContain('disabled');
    expect(button(html, 'Run the approved request')).not.toContain('disabled');
  });
  it('a near-miss phrase keeps them shut', () => {
    expect(button(render({ confirm: 'kill trade' }), 'Approve this request')).toContain('disabled=""');
  });
  it('the requester can never approve their own request, only withdraw it', () => {
    const html = render({ userId: A, confirm: 'KILL trade' });
    expect(html).toContain('You made this request');
    expect(button(html, 'Approve this request')).toContain('disabled=""');
    expect(button(html, 'Reject')).toContain('disabled=""');
    expect(button(html, 'Withdraw my request')).not.toContain('disabled');
  });
  it('an expired approval can only be rejected or withdrawn', () => {
    const html = render({ confirm: 'KILL trade', now: new Date('2026-10-17T03:10:00.000Z') });
    expect(button(html, 'Approve this request')).toContain('disabled=""');
    expect(button(html, 'Run the approved request')).toContain('disabled=""');
    expect(button(html, 'Reject')).not.toContain('disabled');
  });
  it('a deployment block shuts approve and run but never reject or withdraw', () => {
    const html = render({ userId: A, confirm: 'KILL trade', blockedReason: 'ADMIN_OPERATOR_TOKEN is not set' });
    expect(button(html, 'Run the approved request')).toContain('disabled=""');
    expect(button(html, 'Withdraw my request')).not.toContain('disabled');
  });
  it('while a step runs every button is shut and the running one says so', () => {
    const html = render({ confirm: 'KILL trade', busy: 'execute' });
    expect(html).toContain('Working…');
    for (const label of ['Approve this request', 'Reject', 'Withdraw my request']) expect(button(html, label)).toContain('disabled=""');
  });
});

describe('what the page says happened', () => {
  it('a refusal is shown with its words, and "nothing was changed" only when that is true', () => {
    const html = renderToStaticMarkup(
      <StepReplyView
        reply={{
          ok: false,
          step: 'execute',
          refusal: {
            title: 'The second founder has not approved this yet',
            body: 'b',
            next: 'n',
            code: 'action_approval.not_approved',
            changed: 'no',
          },
        }}
      />,
    );
    expect(html).toContain('Nothing was changed.');
    expect(html).toContain('action_approval.not_approved');
    const unknown = renderToStaticMarkup(
      <StepReplyView
        reply={{
          ok: false,
          step: 'execute',
          refusal: { title: 'The outcome is not known', body: 'b', next: 'n', code: null, changed: 'unknown' },
        }}
      />,
    );
    expect(unknown).toContain('Outcome not known.');
    expect(unknown).not.toContain('Nothing was changed.');
    expect(unknown).toContain('data-tone="warn"');
  });
  it('prints when the approval expires in the shared UTC form, not as raw ISO text', () => {
    const html = render();
    expect(html).toContain('17 Oct 2026, 03:10:00 UTC');
    expect(html).not.toContain('2026-10-17T03:10:00.000Z');
    const made = renderToStaticMarkup(
      <StepReplyView
        reply={{
          ok: true,
          step: 'propose',
          approval: {
            approvalId: 'appr_1',
            operationId: 'op_1',
            status: 'PENDING',
            expiresAt: '2026-10-17T03:10:00.000Z',
            requesterId: A,
            approverId: null,
          },
        }}
      />,
    );
    expect(made).toContain('17 Oct 2026, 03:10:00 UTC');
  });
  it('an execute reply says it is what the service said, not the state', () => {
    const html = renderToStaticMarkup(<StepReplyView reply={{ ok: true, step: 'execute', detail: 'svc-edge answered 200' }} />);
    expect(html).toContain('The service answered');
    expect(html).toContain('read again from the service');
  });
  it('an approval that does not match what was read is a loud warning', () => {
    const html = renderToStaticMarkup(
      <StepReplyView
        reply={{
          ok: true,
          step: 'approve',
          matchesReviewedRequest: false,
          approval: { approvalId: 'appr_1', operationId: 'op_1', status: 'APPROVED', expiresAt: 'x', requesterId: A, approverId: B },
        }}
      />,
    );
    expect(html).toContain('NOT for the request you read');
    expect(html).toContain('Ask the requester to withdraw it');
    expect(html).not.toContain('Reject it now');
    expect(html).toContain('role="alert"');
  });
  it('a made request says nothing has run', () => {
    const html = renderToStaticMarkup(
      <StepReplyView
        reply={{
          ok: true,
          step: 'propose',
          approval: { approvalId: 'appr_1', operationId: 'op_1', status: 'PENDING', expiresAt: 'x', requesterId: A, approverId: null },
        }}
      />,
    );
    expect(html).toContain('Nothing has run');
    expect(html).toContain('nobody yet');
  });
});

describe('two desks on one page', () => {
  it('give each workbench its own ids, so every label names its own field', () => {
    const html = renderToStaticMarkup(
      <>
        <ApprovalWorkbenchView {...base} />
        <ApprovalWorkbenchView {...base} />
      </>,
    );
    const ids = [...html.matchAll(/ id="([^"]*dk-packet)"/g)].map((m) => m[1]);
    const fors = [...html.matchAll(/ for="([^"]*dk-packet)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(fors).toEqual(ids);
  });
});
