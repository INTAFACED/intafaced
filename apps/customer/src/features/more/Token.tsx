import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel, Tabs } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
const uuid = z.string().uuid();
const stakeSchema = z.object({
  id: uuid,
  userId: uuid,
  amount: decimalSchema,
  tier: z.enum(['flex', 'm3', 'm12']),
  startedAt: z.string(),
  unlocksAt: z.string().nullable(),
  status: z.enum(['pending', 'active', 'unstaking', 'closed']),
});
const proposalSchema = z.object({
  id: uuid,
  kind: z.enum(['listing', 'fee_param', 'curriculum', 'grant']),
  body: z.record(z.unknown()),
  status: z.enum(['draft', 'open', 'passed', 'rejected', 'executed', 'cancelled']),
  opensAt: z.string(),
  closesAt: z.string(),
  createdAt: z.string(),
});
const tally = z.object({
  forWeight: decimalSchema,
  againstWeight: decimalSchema,
  abstainWeight: decimalSchema,
  totalWeight: decimalSchema,
  voterCount: z.number().int().nonnegative(),
});
export function Token() {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('token');
  const [tab, setTab] = useState('Staking'),
    [status, setStatus] = useState('all'),
    [limit, setLimit] = useState(50),
    [selected, setSelected] = useState(''),
    [kind, setKind] = useState('curriculum'),
    [proposalBody, setProposalBody] = useState(''),
    [opens, setOpens] = useState(''),
    [closes, setCloses] = useState(''),
    [validation, setValidation] = useState('');
  const access = useResource(
      (signal) =>
        api.query('token', 'accessOf', undefined, z.object({ staked: decimalSchema, tier: z.string(), feeDiscountBps: z.number().int() }), {
          signal,
        }),
      `token-access:${userId}`,
    ),
    stakes = useResource(
      (signal) =>
        api.query(
          'token',
          'listStakes',
          { status, limit },
          z.array(stakeSchema).refine((rows) => rows.every((row) => row.userId === userId), 'Stake ownership does not match this account'),
          { signal },
        ),
      `token-stakes:${userId}:${status}:${limit}`,
    ),
    proposals = useResource(
      (signal) => api.query('token', 'listProposals', { limit }, z.array(proposalSchema), { signal }),
      `token-proposals:${userId}:${limit}`,
    ),
    burned = useResource(
      (signal) => api.query('token', 'burnedSupply', undefined, z.object({ burned: decimalSchema }), { signal }),
      `token-burn:${userId}`,
    );
  return (
    <div className="more-grid">
      <Tabs items={['Staking', 'Governance', 'Economy']} value={tab} onChange={setTab} label="Token sections" />
      {tab === 'Staking' ? (
        <div className="more-columns">
          <div>
            <Panel title="Your token access">
              <Read resource={access.resource} retry={access.reload}>
                {(a) => (
                  <Details
                    items={[
                      ['Staked amount', `${displayAmount(a.staked)} · asset identity unavailable`],
                      ['Access tier', a.tier],
                      ['Fee discount', `${a.feeDiscountBps} basis points`],
                    ]}
                  />
                )}
              </Read>
            </Panel>
            <Panel title="Your stakes">
              <Select label="Stake status" value={status} onChange={setStatus} options={['all', 'active', 'pending', 'closed']} />
              <Read resource={stakes.resource} retry={stakes.reload} empty="You have no stakes">
                {(rows) => (
                  <>
                    <DataTable headers={['Amount', 'Term', 'Status', 'Unlock', 'Action']} label="Your token stakes">
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            {displayAmount(row.amount)} · asset identity unavailable<small className="more-receipt">{row.id}</small>
                          </td>
                          <td>{row.tier}</td>
                          <td>{row.status}</td>
                          <td>{row.unlocksAt ?? 'Flexible'}</td>
                          <td>
                            <span className="muted">Unstake unavailable: asset identity missing</span>
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                    <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
                  </>
                )}
              </Read>
            </Panel>
          </div>
          <Panel title="Staking asset identity">
            <p role="status">Staking and unstaking are unavailable until the service publishes its configured asset ID.</p>
            <p className="muted">
              The token asset is deployment-configurable. Stake and access responses contain amounts but no asset binding. A default name
              cannot establish which ledger asset will move.
            </p>
            <p className="muted">
              Your existing stake records remain readable. A published asset identity and authoritative movement review are needed before
              these actions can open.
            </p>
            {action.feedback}
          </Panel>
        </div>
      ) : tab === 'Governance' ? (
        <div className="more-columns">
          <div>
            <Panel title="Proposals">
              <Read resource={proposals.resource} retry={proposals.reload} empty="No proposals are published">
                {(rows) => (
                  <>
                    <DataTable headers={['Proposal', 'Kind', 'Status', 'Closes']} label="Governance proposals">
                      {rows.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <Button variant="ghost" aria-label={`Open proposal ${p.id}`} onClick={() => setSelected(p.id)}>
                              {p.id}
                            </Button>
                          </td>
                          <td>{p.kind}</td>
                          <td>{p.status}</td>
                          <td>{p.closesAt}</td>
                        </tr>
                      ))}
                    </DataTable>
                    <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
                  </>
                )}
              </Read>
            </Panel>
            {selected && <Proposal id={selected} action={action} />}
          </div>
          <Panel title="Create a proposal">
            <p className="muted">
              The service decides which proposal kinds your stake permits. Grant and listing execution remain unconnected after a passed
              vote.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setValidation('');
                let body: unknown;
                try {
                  body = JSON.parse(proposalBody);
                } catch {
                  setValidation('Enter a valid JSON object for the proposal body.');
                  return;
                }
                if (!z.record(z.unknown()).safeParse(body).success) {
                  setValidation('Enter a valid JSON object for the proposal body.');
                  return;
                }
                if ((opens && !Number.isFinite(Date.parse(opens))) || (closes && !Number.isFinite(Date.parse(closes)))) {
                  setValidation('Enter valid opening and closing dates.');
                  return;
                }
                if (opens && closes && Date.parse(closes) <= Date.parse(opens)) {
                  setValidation('The closing date must be after the opening date.');
                  return;
                }
                const proposalId = crypto.randomUUID();
                action.stage({
                  title: 'Review proposal',
                  confirm: 'Submit proposal',
                  success: 'Proposal created',
                  content: (
                    <Details
                      items={[
                        ['Kind', kind],
                        ['Body', proposalBody],
                        ['Opens', opens || 'Service policy'],
                        ['Closes', closes || 'Service policy'],
                      ]}
                    />
                  ),
                  run: () =>
                    api.mutate(
                      'token',
                      'createProposal',
                      {
                        kind,
                        body,
                        proposalId,
                        ...(opens ? { opensAt: new Date(opens).toISOString() } : {}),
                        ...(closes ? { closesAt: new Date(closes).toISOString() } : {}),
                      },
                      proposalSchema,
                    ),
                  done: proposals.reload,
                });
              }}
            >
              <Select label="Proposal kind" value={kind} onChange={setKind} options={['curriculum', 'fee_param', 'listing', 'grant']} />
              <TextArea label="Proposal body as JSON object" value={proposalBody} onChange={setProposalBody} />
              <Field label="Opens at (optional)" type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} />
              <Field label="Closes at (optional)" type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
              {validation && <p role="alert">{validation}</p>}
              <Button type="submit" disabled={action.disabled || !proposalBody.trim()}>
                Review proposal
              </Button>
            </form>
            {action.feedback}
          </Panel>
        </div>
      ) : (
        <div className="more-columns">
          <Panel title="Recorded burn">
            <Read resource={burned.resource} retry={burned.reload}>
              {(b) => <Details items={[['Burned supply', `${displayAmount(b.burned)} · asset identity unavailable`]]} />}
            </Read>
          </Panel>
          <Panel title="Economy boundaries">
            <p>Emission, buyback and revenue-distribution windows are signed service jobs. They are not customer actions.</p>
            <p>
              The customer API publishes no personal yield history, upcoming distribution quote, or buyback execution history. Those values
              stay absent.
            </p>
            <p>
              Governance closure depends on published quorum and threshold rules. A passed listing or grant does not execute while the
              executor is unconnected.
            </p>
          </Panel>
        </div>
      )}
      {tab !== 'Staking' && tab !== 'Governance' && action.feedback}
      {action.dialog}
    </div>
  );
}
function Proposal({ id, action }: { id: string; action: ReturnType<typeof useAction> }) {
  const api = useApi(),
    { userId } = useSession();
  const detail = useResource(
    (signal) => api.query('token', 'getProposal', { proposalId: id }, proposalSchema.extend({ tally }), { signal }),
    `proposal:${userId}:${id}`,
  );
  return (
    <Panel title="Proposal detail">
      <Read resource={detail.resource} retry={detail.reload}>
        {(p) => (
          <>
            <Details
              items={[
                ['Proposal', p.id],
                ['Status', p.status],
                ['For weight', p.tally.forWeight],
                ['Against weight', p.tally.againstWeight],
                ['Abstain weight', p.tally.abstainWeight],
                ['Voters', p.tally.voterCount],
              ]}
            />
            <pre className="more-body">{JSON.stringify(p.body, null, 2)}</pre>
            <div className="actions">
              {['for', 'against', 'abstain'].map((choice) => (
                <Button
                  key={choice}
                  variant="secondary"
                  disabled={action.disabled || p.status !== 'open' || Date.parse(p.closesAt) <= Date.now()}
                  onClick={() =>
                    action.stage({
                      title: 'Review vote',
                      confirm: 'Cast vote',
                      success: 'Vote recorded',
                      content: (
                        <Details
                          items={[
                            ['Proposal', id],
                            ['Choice', choice],
                            ['Weight', 'Determined by your authoritative stake when cast'],
                          ]}
                        />
                      ),
                      run: () =>
                        api.mutate(
                          'token',
                          'castVote',
                          { proposalId: id, choice },
                          z.object({
                            id: uuid,
                            proposalId: uuid,
                            userId: uuid,
                            weight: decimalSchema,
                            choice: z.string(),
                            castAt: z.string(),
                          }),
                        ),
                      done: detail.reload,
                    })
                  }
                >
                  Vote {choice}
                </Button>
              ))}
              <Button
                variant="secondary"
                disabled={action.disabled || p.status !== 'open' || Date.parse(p.closesAt) > Date.now()}
                onClick={() =>
                  action.stage({
                    title: 'Close proposal after voting',
                    confirm: 'Close proposal',
                    success: 'Proposal closure received',
                    content: (
                      <p>The service applies its published quorum and threshold. This request does not execute a grant or listing.</p>
                    ),
                    run: () =>
                      api.mutate(
                        'token',
                        'closeProposal',
                        { proposalId: id },
                        proposalSchema.extend({ tally, execute: z.literal('token.governance_execute_unwired').nullable() }),
                      ),
                    done: detail.reload,
                  })
                }
              >
                Close voting
              </Button>
            </div>
          </>
        )}
      </Read>
    </Panel>
  );
}
