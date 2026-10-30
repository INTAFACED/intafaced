import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangePolicyRoom } from './room';

const asOf = '2026-10-30T10:00:00.000Z';

describe('ChangePolicyRoom', () => {
  it('shows a set row and an unset row with its typed code, and no control that edits', () => {
    const html = renderToStaticMarkup(
      <ChangePolicyRoom
        asOf={asOf}
        policies={{
          kind: 'ok',
          data: [
            {
              state: 'set',
              actionType: 'ops.ledger.reverse',
              policy: {
                requiredApprovals: 2,
                approverAudience: 'operator',
                applier: 'svc-ops',
                maxAgeSeconds: 600,
                version: `sha256:${'b'.repeat(64)}`,
              },
            },
            { state: 'unset', actionType: 'ops.ledger.adjust', code: 'action_approval.policy_unset' },
          ],
        }}
      />,
    );
    expect(html).toContain('data-state="set"');
    expect(html).toContain('2 other than the requester');
    expect(html).toContain('Operators');
    expect(html).toContain('data-state="unset"');
    expect(html).toContain('action_approval.policy_unset');
    expect(html).not.toMatch(/<(form|button|input)\b/);
  });

  it('a failed read says why and lists nothing', () => {
    const html = renderToStaticMarkup(
      <ChangePolicyRoom
        asOf={asOf}
        policies={{ kind: 'failed', message: 'svc-identity did not answer.', code: null, notBuilt: false, forbidden: false }}
      />,
    );
    expect(html).toContain('data-testid="policy-failed"');
    expect(html).toContain('svc-identity did not answer.');
    expect(html).not.toContain('policy-table');
  });

  it('an empty list is said, never drawn as a table', () => {
    const html = renderToStaticMarkup(<ChangePolicyRoom asOf={asOf} policies={{ kind: 'ok', data: [] }} />);
    expect(html).toContain('data-testid="policy-empty"');
  });
});
