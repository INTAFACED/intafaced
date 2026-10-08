import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
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
  const { hideBalances } = usePreferences();
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
          z
            .array(stakeSchema)
            .refine((rows) => rows.every((row) => row.userId === userId), copyText('token.stake.ownership.does.not.match.this.account')),
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
      <Tabs
        items={['Staking', 'Governance', 'Economy']}
        labels={{ Staking: copyText('token.staking'), Governance: copyText('token.governance'), Economy: copyText('token.economy') }}
        value={tab}
        onChange={setTab}
        label={copyText('token.token.sections')}
      />
      {tab === 'Staking' ? (
        <div className="more-columns">
          <div>
            <Panel title={copyText('token.your.token.access')}>
              <Read resource={access.resource} retry={access.reload}>
                {(a) => (
                  <Details
                    items={[
                      [
                        copyText('token.staked.amount'),
                        hideBalances
                          ? copyText('token.hidden.asset.identity.unavailable')
                          : copyText('token.asset.identity.unavailable.2', { amount: displayAmount(a.staked) }),
                      ],
                      [copyText('token.access.tier'), a.tier],
                      [copyText('token.fee.discount'), copyText('token.basis.points', { bps: a.feeDiscountBps })],
                    ]}
                  />
                )}
              </Read>
            </Panel>
            <Panel title={copyText('token.your.stakes')}>
              <Select
                label={copyText('token.stake.status')}
                value={status}
                onChange={setStatus}
                options={['all', 'active', 'pending', 'closed']}
              />
              <Read resource={stakes.resource} retry={stakes.reload} empty={copyText('token.you.have.no.stakes')}>
                {(rows) => (
                  <>
                    <DataTable
                      headers={[
                        copyText('token.amount'),
                        copyText('token.term'),
                        copyText('token.status'),
                        copyText('token.unlock'),
                        copyText('token.action'),
                      ]}
                      label={copyText('token.your.token.stakes')}
                    >
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            {displayAmount(row.amount)}
                            <Text k="token.asset.identity.unavailable" />
                            <small className="more-receipt">{row.id}</small>
                          </td>
                          <td>{row.tier}</td>
                          <td>{row.status}</td>
                          <td>{row.unlocksAt ?? copyText('token.flexible')}</td>
                          <td>
                            <span className="muted">
                              <Text k="token.unstake.unavailable.asset.identity.missing" />
                            </span>
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
          <Panel title={copyText('token.staking.asset.identity')}>
            <p role="status">
              <Text k="token.staking.and.unstaking.are.unavailable.until.the" />
            </p>
            <p className="muted">
              <Text k="token.the.token.asset.is.deployment.configurable.stake" />
            </p>
            <p className="muted">
              <Text k="token.your.existing.stake.records.remain.readable.a" />
            </p>
            {action.feedback}
          </Panel>
        </div>
      ) : tab === 'Governance' ? (
        <div className="more-columns">
          <div>
            <Panel title={copyText('token.proposals')}>
              <Read resource={proposals.resource} retry={proposals.reload} empty={copyText('token.no.proposals.are.published')}>
                {(rows) => (
                  <>
                    <DataTable
                      headers={[copyText('token.proposal'), copyText('token.kind'), copyText('token.status'), copyText('token.closes')]}
                      label={copyText('token.governance.proposals')}
                    >
                      {rows.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <Button
                              variant="ghost"
                              aria-label={copyText('token.open.proposal', { value1: p.id })}
                              onClick={() => setSelected(p.id)}
                            >
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
          <Panel title={copyText('token.create.a.proposal')}>
            <p className="muted">
              <Text k="token.the.service.decides.which.proposal.kinds.your" />
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setValidation('');
                let body: unknown;
                try {
                  body = JSON.parse(proposalBody);
                } catch {
                  setValidation(copyText('token.enter.a.valid.json.object.for.the'));
                  return;
                }
                if (!z.record(z.unknown()).safeParse(body).success) {
                  setValidation(copyText('token.enter.a.valid.json.object.for.the'));
                  return;
                }
                if ((opens && !Number.isFinite(Date.parse(opens))) || (closes && !Number.isFinite(Date.parse(closes)))) {
                  setValidation(copyText('token.enter.valid.opening.and.closing.dates'));
                  return;
                }
                if (opens && closes && Date.parse(closes) <= Date.parse(opens)) {
                  setValidation(copyText('token.the.closing.date.must.be.after.the'));
                  return;
                }
                const proposalId = crypto.randomUUID();
                action.stage({
                  title: copyText('token.review.proposal'),
                  confirm: copyText('token.submit.proposal'),
                  success: copyText('token.proposal.created'),
                  content: (
                    <Details
                      items={[
                        [copyText('token.kind'), kind],
                        [copyText('token.body'), proposalBody],
                        [copyText('token.opens'), opens || copyText('token.service.policy')],
                        [copyText('token.closes'), closes || copyText('token.service.policy')],
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
              <Select
                label={copyText('token.proposal.kind')}
                value={kind}
                onChange={setKind}
                options={['curriculum', 'fee_param', 'listing', 'grant']}
              />
              <TextArea label={copyText('token.proposal.body.as.json.object')} value={proposalBody} onChange={setProposalBody} />
              <Field
                label={copyText('token.opens.at.optional')}
                type="datetime-local"
                value={opens}
                onChange={(e) => setOpens(e.target.value)}
              />
              <Field
                label={copyText('token.closes.at.optional')}
                type="datetime-local"
                value={closes}
                onChange={(e) => setCloses(e.target.value)}
              />
              {validation && <p role="alert">{validation}</p>}
              <Button type="submit" disabled={action.disabled || !proposalBody.trim()}>
                <Text k="token.review.proposal" />
              </Button>
            </form>
            {action.feedback}
          </Panel>
        </div>
      ) : (
        <div className="more-columns">
          <Panel title={copyText('token.recorded.burn')}>
            <Read resource={burned.resource} retry={burned.reload}>
              {(b) => (
                <Details
                  items={[
                    [copyText('token.burned.supply'), copyText('token.asset.identity.unavailable.2', { amount: displayAmount(b.burned) })],
                  ]}
                />
              )}
            </Read>
          </Panel>
          <Panel title={copyText('token.economy.boundaries')}>
            <p>
              <Text k="token.emission.buyback.and.revenue.distribution.windows.are" />
            </p>
            <p>
              <Text k="token.the.customer.api.publishes.no.personal.yield" />
            </p>
            <p>
              <Text k="token.governance.closure.depends.on.published.quorum.and" />
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
    <Panel title={copyText('token.proposal.detail')}>
      <Read resource={detail.resource} retry={detail.reload}>
        {(p) => (
          <>
            <Details
              items={[
                [copyText('token.proposal'), p.id],
                [copyText('token.status'), p.status],
                [copyText('token.for.weight'), p.tally.forWeight],
                [copyText('token.against.weight'), p.tally.againstWeight],
                [copyText('token.abstain.weight'), p.tally.abstainWeight],
                [copyText('token.voters'), p.tally.voterCount],
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
                      title: copyText('token.review.vote'),
                      confirm: copyText('token.cast.vote'),
                      success: copyText('token.vote.recorded'),
                      content: (
                        <Details
                          items={[
                            [copyText('token.proposal'), id],
                            [copyText('token.choice'), choice],
                            [copyText('token.weight'), copyText('token.determined.by.your.authoritative.stake.when.cast')],
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
                  <Text k="token.vote" />
                  {choice}
                </Button>
              ))}
              <Button
                variant="secondary"
                disabled={action.disabled || p.status !== 'open' || Date.parse(p.closesAt) > Date.now()}
                onClick={() =>
                  action.stage({
                    title: copyText('token.close.proposal.after.voting'),
                    confirm: copyText('token.close.proposal'),
                    success: copyText('token.proposal.closure.received'),
                    content: (
                      <p>
                        <Text k="token.the.service.applies.its.published.quorum.and" />
                      </p>
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
                <Text k="token.close.voting" />
              </Button>
            </div>
          </>
        )}
      </Read>
    </Panel>
  );
}
