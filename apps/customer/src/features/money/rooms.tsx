import { useState } from 'react';
import { z } from 'zod';
import { Button, DataTable, EmptyState, Failure, Field, Page } from '../../shared/ui';
import { decimalSchema, parseAmount } from '../../shared/money';
import { useSession } from '../session/session';
import { validateTransfer, type Space } from './client';
import {
  amount,
  funds,
  bps,
  cadenceField,
  Continuation,
  date,
  iso,
  NoRows,
  positiveMoney,
  ResourceView,
  Section,
  startsField,
  useBankRead,
  usePageLimit,
  uuidField,
  type ActionSpec,
} from './components';
import { AutoInvestRules } from './repeat-buy';

const bankRooms = ['Overview', 'Spaces', 'Transfers', 'Earn', 'Loans', 'Cards', 'Ramps', 'Analytics', 'Business'] as const;
export function BankNavigation({ current }: { current: string }) {
  return (
    <nav className="money-bank-nav" aria-label="Bank rooms">
      {bankRooms.map((room) => (
        <a
          key={room}
          href={room === 'Overview' ? '/bank' : `/bank/${room.toLowerCase()}`}
          aria-current={current === room ? 'page' : undefined}
        >
          {room}
        </a>
      ))}
    </nav>
  );
}
function BankPage({ room, description, children }: { room: string; description: string; children: React.ReactNode }) {
  return (
    <Page
      eyebrow="Money / Bank"
      title={room}
      description={description}
      actions={
        <a className="button button--secondary" href="/bank">
          Bank overview
        </a>
      }
    >
      <BankNavigation current={room} />
      {children}
    </Page>
  );
}
const assetField = {
  name: 'assetId',
  label: 'Asset',
  hint: 'Exact asset code. This does not convert currencies.',
  validate: (value: string) => (value.length <= 16 ? null : 'Asset codes are limited to 16 characters.'),
};
const moneyValue = (value: string) => (decimalSchema.safeParse(value).success ? null : 'Enter an exact nonnegative decimal.');
function spaceName(space: Space) {
  return `${space.name} · ${space.assetId} · ${funds(space.balance, space.assetId)} available${space.lockedUntil && Date.parse(space.lockedUntil) > Date.now() ? ' · locked' : ''}`;
}
function Spaces({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const spaces = useBankRead('spaces.list', { limit });
  const unnamed = useBankRead('spaces.unnamed', undefined);
  const create = () =>
    open({
      title: 'Create space',
      procedure: 'spaces.create',
      fields: [
        assetField,
        { name: 'name', label: 'Space name', validate: (value) => (value.length <= 64 ? null : 'Use 64 characters or fewer.') },
        {
          name: 'goalTarget',
          label: 'Savings target (asset units)',
          optional: true,
          hint: 'A target is not a balance.',
          validate: moneyValue,
        },
        { ...startsField, name: 'lockedUntil', label: 'Lock until (optional)', optional: true },
      ],
      notes: [
        'A named space is a ledger subaccount. The primary space labels your existing available account.',
        'A future lock prevents Bank debits from this space. No trade-wide lock is promised.',
      ],
      input: (values) => ({
        assetId: values.assetId,
        name: values.name,
        ...(values.goalTarget ? { goalTarget: values.goalTarget } : {}),
        ...(values.lockedUntil ? { lockedUntil: iso(values.lockedUntil) } : {}),
      }),
    });
  return (
    <BankPage room="Spaces" description="Give an asset a purpose inside the same ledger.">
      <Section
        title="Your spaces"
        actions={
          <>
            <Button variant="ghost" onClick={spaces.reload}>
              Refresh
            </Button>
            <Button onClick={create}>Create space</Button>
          </>
        }
      >
        <ResourceView resource={spaces.resource} reload={spaces.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((space) => (
                  <article className="money-record" key={space.id}>
                    <header>
                      <div>
                        <h3>{space.name}</h3>
                        <p>
                          {space.assetId} ·{' '}
                          {space.kind === 'primary' ? 'Primary · included in your user ledger projection' : 'Named ledger subaccount'}
                        </p>
                      </div>
                      <strong className="numeric">{funds(space.balance, space.assetId)}</strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>Target</dt>
                        <dd>{funds(space.goalTarget, space.assetId)}</dd>
                      </div>
                      <div>
                        <dt>Bank lock</dt>
                        <dd>{date(space.lockedUntil)}</dd>
                      </div>
                      <div>
                        <dt>Space reference</dt>
                        <dd>{space.id}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <a className="button button--secondary" href={`/bank/transfers?from=${encodeURIComponent(space.id)}`}>
                        Transfer
                      </a>
                      {space.kind === 'named' && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            open({
                              title: 'Archive space',
                              procedure: 'spaces.archive',
                              facts: [
                                ['Space', space.name],
                                ['Available quantity', amount(space.balance, space.assetId)],
                              ],
                              notes: [
                                'Archiving removes the label from active lists. It does not move or sweep funds.',
                                'Archived named-space funds are not included in the current user holdings projection.',
                              ],
                              input: () => ({ spaceId: space.id }),
                              submit: 'Archive label',
                            })
                          }
                        >
                          Archive label
                        </Button>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title="No spaces returned">Create a named space. Its balance will come from the ledger.</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <Section
        title="Assets without a space"
        description="Positive user available accounts only. These quantities already belong to your user ledger projection."
      >
        <ResourceView resource={unnamed.resource} reload={unnamed.reload}>
          {(rows) =>
            rows.length ? (
              rows.map((row) => (
                <div className="money-space-row" key={row.assetId}>
                  <strong>{row.assetId}</strong>
                  <span className="numeric">{funds(row.balance, row.assetId)}</span>
                </div>
              ))
            ) : (
              <NoRows title="No unnamed positive quantities returned">This does not establish that all balances are zero.</NoRows>
            )
          }
        </ResourceView>
      </Section>
    </BankPage>
  );
}
function ScheduleExecutions({ id }: { id: string }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('transfers.executions', { scheduleId: id, limit });
  return (
    <Section
      title="Execution outcomes"
      description="Each due occurrence has its own status. A skipped or refused occurrence did not complete a transfer."
    >
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              <DataTable headers={['Occurrence', 'Amount', 'Status / refusal', 'Ledger transaction']} label="Schedule execution outcomes">
                {rows.map((row) => (
                  <tr key={row.occurrence}>
                    <td>{row.occurrence}</td>
                    <td className="numeric">{row.amount}</td>
                    <td>
                      {row.status}
                      {row.rejectionCode && <small className="money-block">{row.rejectionCode}</small>}
                    </td>
                    <td>{row.ledgerTxId ?? 'No posted transaction'}</td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <NoRows title="No executions returned">The schedule has no recorded execution on this bounded list.</NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Schedules({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useBankRead('transfers.listSchedules', { limit });
  return (
    <>
      <Section
        title="Standing orders"
        actions={
          <Button variant="ghost" onClick={query.reload}>
            Refresh
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={query.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((row) => (
                  <article className="money-record" key={row.id}>
                    <header>
                      <div>
                        <h3>{row.cadence} transfer</h3>
                        <p>
                          {row.status} · next run {date(row.nextRunAt)}
                        </p>
                      </div>
                      <strong className="numeric">{funds(row.amount, row.assetId)}</strong>
                    </header>
                    <div className="actions">
                      <Button variant="secondary" onClick={() => setSelected(row.id)}>
                        Execution history
                      </Button>
                      {row.status !== 'cancelled' && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              open({
                                title: row.status === 'paused' ? 'Resume standing order' : 'Pause standing order',
                                procedure: row.status === 'paused' ? 'transfers.resume' : 'transfers.pause',
                                facts: [
                                  ['Schedule', row.id],
                                  ['Amount', amount(row.amount, row.assetId)],
                                ],
                                notes: [
                                  row.status === 'paused'
                                    ? 'Occurrences missed while paused are skipped. They are not paid as a catch-up batch.'
                                    : 'Pause future scheduled transfers. Past posted transfers remain settled.',
                                ],
                                input: () => ({ scheduleId: row.id }),
                              })
                            }
                          >
                            {row.status === 'paused' ? 'Resume' : 'Pause'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              open({
                                title: 'Cancel standing order',
                                procedure: 'transfers.cancel',
                                notes: ['Cancel future occurrences. This does not reverse any posted transfer.'],
                                facts: [['Schedule', row.id]],
                                input: () => ({ scheduleId: row.id }),
                              })
                            }
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title="No standing orders returned">A scheduled transfer appears here after the service confirms it.</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      {selected && <ScheduleExecutions id={selected} />}
    </>
  );
}
function Transfers({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('spaces.list', { limit });
  const [fromId, setFrom] = useState(() => new URLSearchParams(location.search).get('from') ?? '');
  const [destination, setDestination] = useState<'space' | 'user'>('space');
  const [scheduled, setScheduled] = useState(false);
  return (
    <BankPage room="Transfers" description="Move available quantities between spaces or to another user.">
      <Section title="New transfer">
        <ResourceView resource={query.resource} reload={query.reload}>
          {(spaces) => {
            const from = spaces.find((row) => row.id === fromId);
            return spaces.length ? (
              <>
                <div className="money-transfer-setup">
                  <label className="field">
                    <span>From your space</span>
                    <select value={fromId} onChange={(event) => setFrom(event.target.value)}>
                      <option value="">Choose source…</option>
                      {spaces.map((space) => (
                        <option key={space.id} value={space.id}>
                          {spaceName(space)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Destination</span>
                    <select value={destination} onChange={(event) => setDestination(event.target.value as 'space' | 'user')}>
                      <option value="space">Space ID</option>
                      <option value="user">User ID</option>
                    </select>
                  </label>
                  <label className="money-check">
                    <input type="checkbox" checked={scheduled} onChange={(event) => setScheduled(event.target.checked)} /> Repeat on a
                    schedule
                  </label>
                  <Button
                    disabled={!from}
                    onClick={() => {
                      if (!from) return;
                      open({
                        title: scheduled ? 'Schedule transfer' : 'Transfer',
                        procedure: scheduled
                          ? destination === 'space'
                            ? 'transfers.schedule'
                            : 'transfers.scheduleToUser'
                          : destination === 'space'
                            ? 'transfers.create'
                            : 'transfers.toUser',
                        initial: { fromSpaceId: from.id },
                        fields: [
                          destination === 'space'
                            ? uuidField('toSpaceId', 'Destination space ID')
                            : {
                                name: 'toUserId',
                                label: 'Recipient user ID',
                                validate: (value) => (value.length <= 64 ? null : 'Use 64 characters or fewer.'),
                              },
                          positiveMoney(from.assetId),
                          ...(scheduled ? [cadenceField, startsField] : []),
                        ],
                        facts: [
                          ['Source', from.name],
                          ['Asset', from.assetId],
                          ['Available at last read', amount(from.balance, from.assetId)],
                        ],
                        notes: [
                          'The service checks ownership, lock policy and current available funds before posting. A read is not a reservation.',
                          'Use the destination ID supplied by your recipient. No recipient identity is inferred from the ID.',
                        ],
                        validate: (input) =>
                          validateTransfer(spaces, { ...input, transferId: 'review-reference' } as Parameters<typeof validateTransfer>[1]),
                        ...(!scheduled ? { transferSpaces: spaces } : {}),
                        input: (values, requestId) => ({
                          fromSpaceId: from.id,
                          ...(destination === 'space' ? { toSpaceId: values.toSpaceId } : { toUserId: values.toUserId }),
                          amount: values.amount,
                          ...(scheduled
                            ? { scheduleId: requestId, cadence: values.cadence, startsAt: iso(values.startsAt!) }
                            : { transferId: requestId }),
                        }),
                      });
                    }}
                  >
                    Continue
                  </Button>
                </div>
                <Continuation count={spaces.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
              </>
            ) : (
              <NoRows title="No source spaces returned">Create a space or name an existing primary asset before transferring.</NoRows>
            );
          }}
        </ResourceView>
      </Section>
      <Schedules open={open} />
    </BankPage>
  );
}
function Earn({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const pools = useBankRead('earn.pools', { limit });
  const positions = useBankRead('earn.positions', { limit });
  return (
    <BankPage room="Earn" description="Configured products and ledger-backed principal. No rate is invented.">
      <Section title="Available pools">
        <ResourceView resource={pools.resource} reload={pools.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((pool) => (
                  <article className="money-record" key={pool.id}>
                    <header>
                      <div>
                        <h3>{pool.name}</h3>
                        <p>
                          {pool.assetId} · {pool.kind} · {pool.termDays === null ? 'Flexible term' : `${pool.termDays} days`}
                        </p>
                      </div>
                      <strong>{bps(pool.aprBps)} APR</strong>
                    </header>
                    <p className="money-caption">
                      Minimum deposit {funds(pool.minDeposit, pool.assetId)}. APR is the configured simple annual rate, not a promised APY.
                    </p>
                    <div className="actions">
                      <Button
                        onClick={() =>
                          open({
                            title: 'Deposit into earn',
                            procedure: 'earn.deposit',
                            fields: [positiveMoney(pool.assetId)],
                            facts: [
                              ['Pool', pool.name],
                              ['APR', bps(pool.aprBps)],
                              ['Term', pool.termDays === null ? 'Flexible' : `${pool.termDays} days`],
                              ['Minimum', amount(pool.minDeposit, pool.assetId)],
                            ],
                            notes: [
                              'Principal moves from your user available account to a purpose-keyed earn stake account in the same ledger.',
                              'The service verifies the pool is open and the amount meets its minimum.',
                            ],
                            validate: (input) =>
                              parseAmount(String(input.amount)) >= parseAmount(pool.minDeposit)
                                ? null
                                : 'The amount is below the configured minimum deposit.',
                            input: (values, requestId) => ({ poolId: pool.id, positionId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        Deposit
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open({
                            title: 'Create threshold sweep',
                            procedure: 'autoInvest.createThresholdSweep',
                            fields: [{ name: 'threshold', label: `Keep available (${pool.assetId})`, validate: moneyValue }],
                            facts: [
                              ['Pool', pool.name],
                              ['Asset', pool.assetId],
                            ],
                            notes: [
                              'Keep this exact quantity in the primary available account. Excess moves to this same-asset earn pool.',
                              'No cross-asset rate is assumed. The runner remains subject to configured policy.',
                            ],
                            input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, threshold: values.threshold }),
                          })
                        }
                      >
                        Threshold sweep
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          open({
                            title: 'Create card round-up',
                            procedure: 'autoInvest.createRoundUp',
                            fields: [positiveMoney(pool.assetId, 'granularity', 'Round-up increment')],
                            facts: [
                              ['Pool', pool.name],
                              ['Asset', pool.assetId],
                            ],
                            notes: [
                              'Same-asset spare change goes to this earn pool when a connected card capture occurs.',
                              'This instruction does not connect an issuer or create a live card.',
                            ],
                            input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, granularity: values.granularity }),
                          })
                        }
                      >
                        Card round-up
                      </Button>
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title="No configured pools returned">Earn requires a published rate and open pool.</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <Section title="Your positions">
        <ResourceView resource={positions.resource} reload={positions.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((position) => (
                  <article className="money-record" key={position.id}>
                    <header>
                      <div>
                        <h3>{position.assetId} earn position</h3>
                        <p>Matures {date(position.maturesAt)}</p>
                      </div>
                      <strong className="numeric">{funds(position.principal, position.assetId)} principal</strong>
                    </header>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        open({
                          title: 'Withdraw earn principal',
                          procedure: 'earn.withdraw',
                          facts: [
                            ['Position', position.id],
                            ['Principal', amount(position.principal, position.assetId)],
                            ['Matures', date(position.maturesAt)],
                          ],
                          notes: [
                            'The service checks maturity and reconciles ledger-backed principal before withdrawal.',
                            'A refusal leaves the position unchanged. No yield amount is estimated here.',
                          ],
                          input: () => ({ positionId: position.id }),
                        })
                      }
                    >
                      Review withdrawal
                    </Button>
                  </article>
                ))
              ) : (
                <NoRows title="No active earn positions returned">A position appears only after the service confirms a deposit.</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <AutoInvestRules open={open} />
    </BankPage>
  );
}
function Loans({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const products = useBankRead('loans.products', { limit });
  const loans = useBankRead('loans.list', { limit });
  const health = useBankRead('loans.health', undefined);
  return (
    <BankPage room="Loans" description="Configured borrowing terms, ledger collateral and authoritative risk checks.">
      <Section title="Loan health">
        <ResourceView resource={health.resource} reload={health.reload}>
          {(risk) => (
            <>
              <div className="money-risk">
                <strong>{bps(risk.portfolioLtvBps)} LTV</strong>
                <span>{risk.loans.length} loans in this risk calculation</span>
              </div>
              <p className="notice">
                This calculation values loans only. Its response does not supply valuation quote units or mark time. It cannot be treated as
                account wealth or a current dollar balance.
              </p>
            </>
          )}
        </ResourceView>
      </Section>
      <Section title="Loan products">
        <ResourceView resource={products.resource} reload={products.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((product) => (
                  <article className="money-record" key={product.id}>
                    <header>
                      <div>
                        <h3>{product.name}</h3>
                        <p>
                          Borrow {product.debtAssetId} · secure with {product.collateralAssetId}
                        </p>
                      </div>
                      <strong>{bps(product.aprBps)} APR</strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>Minimum principal</dt>
                        <dd>{funds(product.minPrincipal, product.debtAssetId)}</dd>
                      </div>
                      <div>
                        <dt>Maximum LTV</dt>
                        <dd>{bps(product.maxLtvBps)}</dd>
                      </div>
                      <div>
                        <dt>Margin call LTV</dt>
                        <dd>{bps(product.marginCallLtvBps)}</dd>
                      </div>
                      <div>
                        <dt>Liquidation LTV</dt>
                        <dd>{bps(product.liquidationLtvBps)}</dd>
                      </div>
                      <div>
                        <dt>Mark quote asset</dt>
                        <dd>{product.quoteAssetId}</dd>
                      </div>
                    </dl>
                    <Button
                      onClick={() =>
                        open({
                          title: 'Open loan',
                          procedure: 'loans.open',
                          fields: [
                            positiveMoney(product.debtAssetId, 'principal', 'Principal to borrow'),
                            positiveMoney(product.collateralAssetId, 'collateralAmount', 'Collateral to pledge'),
                          ],
                          facts: [
                            ['Product', product.name],
                            ['APR', bps(product.aprBps)],
                            ['Maximum LTV', bps(product.maxLtvBps)],
                            ['Margin call', bps(product.marginCallLtvBps)],
                            ['Liquidation', bps(product.liquidationLtvBps)],
                          ],
                          notes: [
                            'Collateral moves from your user available account into a purpose-keyed loan collateral account. Borrowed principal is credited only after the service confirms the draw.',
                            'The service obtains acceptable current marks and checks LTV, minimum principal and reserve funding. No price or approval is invented by this review.',
                          ],
                          validate: (input) =>
                            parseAmount(String(input.principal)) >= parseAmount(product.minPrincipal)
                              ? null
                              : 'Principal is below the product minimum.',
                          input: (values, requestId) => ({
                            loanId: requestId,
                            productId: product.id,
                            principal: values.principal,
                            collateralAmount: values.collateralAmount,
                          }),
                          submit: 'Confirm loan request',
                        })
                      }
                    >
                      Review borrowing
                    </Button>
                  </article>
                ))
              ) : (
                <NoRows title="No loan products returned">
                  Borrowing requires a configured open product, usable collateral marks and a funded reserve.
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <Section
        title="Your loans"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              loans.reload();
              health.reload();
            }}
          >
            Refresh loans and health
          </Button>
        }
      >
        <ResourceView resource={loans.resource} reload={loans.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((loan) => (
                  <article className="money-record" key={loan.id}>
                    <header>
                      <div>
                        <h3>{loan.debtAssetId} loan</h3>
                        <p>
                          {loan.status}
                          {loan.marginCalledAt && ` · margin called ${date(loan.marginCalledAt)}`}
                        </p>
                      </div>
                      <strong>{bps(loan.aprBps)} APR</strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>Outstanding principal</dt>
                        <dd>{funds(loan.outstandingPrincipal, loan.debtAssetId)}</dd>
                      </div>
                      <div>
                        <dt>Outstanding interest</dt>
                        <dd>{funds(loan.outstandingInterest, loan.debtAssetId)}</dd>
                      </div>
                      <div>
                        <dt>Ledger collateral</dt>
                        <dd>{funds(loan.collateral, loan.collateralAssetId)}</dd>
                      </div>
                      <div>
                        <dt>Loan reference</dt>
                        <dd>{loan.id}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <Button
                        onClick={() =>
                          open({
                            title: 'Repay loan',
                            procedure: 'loans.repay',
                            fields: [positiveMoney(loan.debtAssetId)],
                            facts: [
                              ['Loan', loan.id],
                              ['Principal at last read', amount(loan.outstandingPrincipal, loan.debtAssetId)],
                              ['Interest at last read', amount(loan.outstandingInterest, loan.debtAssetId)],
                            ],
                            notes: [
                              'Repayment debits your user available account. The service applies interest and principal and returns the remaining debt.',
                              'Your request reference remains stable. An uncertain response must be reconciled against this loan.',
                            ],
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        Repay
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open({
                            title: 'Add collateral',
                            procedure: 'loans.addCollateral',
                            fields: [positiveMoney(loan.collateralAssetId)],
                            facts: [['Loan', loan.id]],
                            notes: [
                              'Additional collateral is locked from your user available account into this loan. It is not spendable while pledged.',
                            ],
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        Add collateral
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open({
                            title: 'Release excess collateral',
                            procedure: 'loans.releaseExcess',
                            fields: [positiveMoney(loan.collateralAssetId)],
                            facts: [
                              ['Loan', loan.id],
                              ['Collateral at last read', amount(loan.collateral, loan.collateralAssetId)],
                            ],
                            notes: [
                              'The service obtains current marks before releasing collateral. It refuses a release that would exceed the product LTV cap.',
                              'No available amount is optimistically increased. Refresh after the confirmed outcome.',
                            ],
                            input: (values) => ({ loanId: loan.id, amount: values.amount }),
                          })
                        }
                      >
                        Release excess
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={parseAmount(loan.outstandingPrincipal) !== 0n || parseAmount(loan.outstandingInterest) !== 0n}
                        onClick={() =>
                          open({
                            title: 'Release settled collateral',
                            procedure: 'loans.close',
                            facts: [
                              ['Loan', loan.id],
                              ['Collateral at last read', amount(loan.collateral, loan.collateralAssetId)],
                            ],
                            notes: [
                              'The service releases collateral only after verifying that nothing is owed. A read of zero is not a reservation.',
                            ],
                            input: () => ({ loanId: loan.id }),
                          })
                        }
                      >
                        Close settled loan
                      </Button>
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title="No loans returned">No loan balance is inferred from an empty list.</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
    </BankPage>
  );
}
function CardAuthorizations({ id, asset }: { id: string; asset: string }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('cards.authorizations', { cardId: id, limit });
  return (
    <Section title="Card decisions" description="Approvals and declines remain visible, including the reason a payment was refused.">
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((row) => (
                <article className="money-record" key={row.id}>
                  <header>
                    <div>
                      <h3>
                        {row.decision} · {row.status}
                      </h3>
                      <p>
                        {date(row.decidedAt)} · {row.merchantCategory ?? 'Category not supplied'}
                      </p>
                    </div>
                    <strong className="numeric">{funds(row.amount, asset)}</strong>
                  </header>
                  {row.declineCode && <p className="notice">Decline: {row.declineCode}</p>}
                  <p className="money-reference">Authorization: {row.authorizationRef}</p>
                  {row.conversion && (
                    <dl className="detail-list">
                      <div>
                        <dt>Merchant charge</dt>
                        <dd>{funds(row.conversion.settlementAmount, row.conversion.settlementAssetId)}</dd>
                      </div>
                      <div>
                        <dt>Conversion rate</dt>
                        <dd>
                          {row.conversion.rate} · {row.conversion.rateQuality}
                        </dd>
                      </div>
                      <div>
                        <dt>Rate time</dt>
                        <dd>{date(row.conversion.rateAsOf)}</dd>
                      </div>
                    </dl>
                  )}
                </article>
              ))
            ) : (
              <NoRows title="No card decisions returned">No purchase or decline is invented here.</NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Cards({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const programme = useBankRead('cards.programme', undefined);
  const cards = useBankRead('cards.list', { limit });
  const [selected, setSelected] = useState<{ id: string; asset: string } | null>(null);
  const live = programme.resource.status === 'ready' && !programme.resource.data.simulated && programme.resource.data.id !== 'none';
  return (
    <BankPage room="Cards" description="Issuer connectivity and card outcomes are separate from your balance.">
      <Section title="Issuer programme">
        <ResourceView resource={programme.resource} reload={programme.reload}>
          {(info) => (
            <div className="money-capability">
              <h3>{info.id === 'none' ? 'Card issuer is not connected' : info.displayName}</h3>
              <p>
                {info.simulated
                  ? 'Simulation programme. It does not issue a live payment card, card number or merchant rail.'
                  : info.id === 'none'
                    ? 'A live card requires a connected issuer programme. There is no card to activate.'
                    : 'Issuer programme confirmed by the service.'}
              </p>
              <p>
                New card issuance is unavailable until live issuer products and applicable limits are supplied. No cashback or authorization
                limit is invented.
              </p>
            </div>
          )}
        </ResourceView>
      </Section>
      <Section title="Your card records">
        <ResourceView resource={cards.resource} reload={cards.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((card) => (
                  <article className="money-record" key={card.id}>
                    <header>
                      <div>
                        <h3>
                          {card.simulated ? 'Simulation record' : 'Card'} · {card.panTail}
                        </h3>
                        <p>
                          {card.status} · {card.issuer}
                          {card.simulated && ' · not a live card'}
                        </p>
                      </div>
                      <strong>{card.assetId}</strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>Funding asset</dt>
                        <dd>{card.assetId}</dd>
                      </div>
                      <div>
                        <dt>Merchant settlement asset</dt>
                        <dd>{card.settlementAssetId}</dd>
                      </div>
                      <div>
                        <dt>Authorization limit</dt>
                        <dd>{funds(card.perAuthorizationLimit, card.assetId)}</dd>
                      </div>
                      <div>
                        <dt>Configured cashback</dt>
                        <dd>{bps(card.cashbackBps)}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <Button variant="secondary" onClick={() => setSelected({ id: card.id, asset: card.assetId })}>
                        Decisions and declines
                      </Button>
                      {live && !card.simulated && card.status !== 'closed' && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              open({
                                title: card.status === 'frozen' ? 'Unfreeze card' : 'Freeze card',
                                procedure: 'cards.setStatus',
                                facts: [
                                  ['Card', card.panTail],
                                  ['Funding asset', card.assetId],
                                ],
                                notes: [
                                  card.status === 'frozen'
                                    ? 'Resume issuer use of this existing card. Current limits still apply.'
                                    : 'Ask the issuer to freeze this existing card. Existing captures and reservations are not reversed.',
                                ],
                                input: () => ({ cardId: card.id, status: card.status === 'frozen' ? 'active' : 'frozen' }),
                              })
                            }
                          >
                            {card.status === 'frozen' ? 'Unfreeze' : 'Freeze'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              open({
                                title: 'Close card',
                                procedure: 'cards.setStatus',
                                facts: [['Card', card.panTail]],
                                notes: ['Close this card. This action does not reverse existing posted transactions.'],
                                input: () => ({ cardId: card.id, status: 'closed' }),
                              })
                            }
                          >
                            Close card
                          </Button>
                        </>
                      )}
                    </div>
                    {(!live || card.simulated) && <p className="money-caption">Issuer actions remain unavailable for this record.</p>}
                  </article>
                ))
              ) : (
                <NoRows title="No card records returned">An empty list does not establish issuer connectivity.</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      {selected && <CardAuthorizations id={selected.id} asset={selected.asset} />}
    </BankPage>
  );
}
function RampRecords({ direction }: { direction: 'in' | 'out' }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead(direction === 'in' ? 'ramps.onramps' : 'ramps.offramps', { limit });
  return (
    <Section title={direction === 'in' ? 'Incoming rail records' : 'Outgoing rail records'}>
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((row) => (
                <article className="money-record" key={row.id}>
                  <header>
                    <div>
                      <h3>
                        {row.kind} · {row.status}
                      </h3>
                      <p>
                        {row.rail} · {date(row.createdAt)}
                        {row.simulated && ' · simulated ledger rail'}
                      </p>
                    </div>
                    <strong className="numeric">{funds(row.amount, row.assetId)}</strong>
                  </header>
                  <dl className="detail-list">
                    <div>
                      <dt>Record reference</dt>
                      <dd>{row.id}</dd>
                    </div>
                    {'destinationRef' in row && (
                      <div>
                        <dt>Destination reference</dt>
                        <dd>{row.destinationRef}</dd>
                      </div>
                    )}
                    {'clientRef' in row && (
                      <div>
                        <dt>Client reference</dt>
                        <dd>{row.clientRef}</dd>
                      </div>
                    )}
                    {'ledgerTxId' in row && (
                      <div>
                        <dt>Ledger transaction</dt>
                        <dd>{row.ledgerTxId ?? 'Not posted'}</dd>
                      </div>
                    )}
                    {'holdLedgerTxId' in row && (
                      <>
                        <div>
                          <dt>Reservation transaction</dt>
                          <dd>{row.holdLedgerTxId ?? 'None supplied'}</dd>
                        </div>
                        <div>
                          <dt>Settlement transaction</dt>
                          <dd>{row.settleLedgerTxId ?? 'Not supplied'}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  {row.simulated && <p className="notice">This record does not confirm a live bank transfer or network broadcast.</p>}
                </article>
              ))
            ) : (
              <NoRows title="No rail records returned">No completed deposit or withdrawal is inferred.</NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Ramps() {
  const programme = useBankRead('ramps.programme', undefined);
  const fiat = useBankRead('ramps.fiatSettle', undefined);
  return (
    <BankPage room="Ramps" description="Inspect the connected cash and crypto rail capabilities and their actual records.">
      <div className="money-two-lanes">
        <Section title="Rail programme">
          <ResourceView resource={programme.resource} reload={programme.reload}>
            {(info) => (
              <div className="money-capability">
                <h3>{info.id === 'none' ? 'Ramp programme is not connected' : info.displayName}</h3>
                <p>
                  {info.simulated
                    ? 'This programme is simulated. Ledger entries do not broadcast crypto or deliver a live bank payment.'
                    : 'The service supplied this programme identity.'}
                </p>
                <dl className="detail-list">
                  <div>
                    <dt>Crypto rail</dt>
                    <dd>{info.cryptoRail ?? 'Not connected'}</dd>
                  </div>
                  <div>
                    <dt>Fiat adapter</dt>
                    <dd>{info.fiatVia}</dd>
                  </div>
                </dl>
              </div>
            )}
          </ResourceView>
        </Section>
        <Section title="Fiat settlement capability">
          <ResourceView resource={fiat.resource} reload={fiat.reload}>
            {(info) => (
              <>
                <p className="notice">
                  The adapter can settle using {info.onrampRailId} and {info.offrampRailId}. Live custody delivery and programme authority
                  still require their own confirmation.
                </p>
              </>
            )}
          </ResourceView>
        </Section>
      </div>
      <Section title="Live deposit and withdrawal">
        <EmptyState title="Live custody is not connected">
          No live destination, address, funding instruction or delivery form is enabled by a simulated ledger rail.
        </EmptyState>
        <div className="actions">
          <a className="button button--secondary" href="/uc/recharge">
            Deposit capability
          </a>
          <a className="button button--secondary" href="/uc/withdraw">
            Withdrawal capability
          </a>
        </div>
      </Section>
      <RampRecords direction="in" />
      <RampRecords direction="out" />
    </BankPage>
  );
}
function Analytics() {
  const [values, setValues] = useState({ assetId: '', from: '', to: '' });
  const [range, setRange] = useState<{ assetId: string; from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useBankRead('analytics.spend', range, Boolean(range));
  function load() {
    if (!values.assetId.trim() || values.assetId.trim().length > 16) {
      setError('Enter an asset code of 1 to 16 characters.');
      return;
    }
    if (
      !Number.isFinite(Date.parse(values.from)) ||
      !Number.isFinite(Date.parse(values.to)) ||
      Date.parse(values.from) >= Date.parse(values.to)
    ) {
      setError('Choose a valid start before the end of the window.');
      return;
    }
    setError(null);
    setRange({ assetId: values.assetId.trim(), from: iso(values.from), to: iso(values.to) });
  }
  return (
    <BankPage room="Analytics" description="Ledger movements by asset and date. Movement is not investment performance.">
      <Section title="Movement window">
        <form
          className="money-analytics-form"
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <Field
            label="Asset"
            value={values.assetId}
            maxLength={16}
            required
            onChange={(event) => setValues({ ...values, assetId: event.target.value })}
          />
          <Field
            label="From"
            type="datetime-local"
            value={values.from}
            required
            onChange={(event) => setValues({ ...values, from: event.target.value })}
          />
          <Field
            label="To"
            type="datetime-local"
            value={values.to}
            required
            onChange={(event) => setValues({ ...values, to: event.target.value })}
          />
          <Button type="submit">Read movements</Button>
        </form>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </Section>
      {range ? (
        <ResourceView resource={query.resource} reload={query.reload}>
          {(summary) => (
            <>
              <Section title={`${summary.assetId} movement`} description={`${date(summary.from)} to ${date(summary.to)}`}>
                <div className="money-movement-stats">
                  <div>
                    <span>Inflow</span>
                    <strong className="numeric">{funds(summary.totalInflow, summary.assetId)}</strong>
                  </div>
                  <div>
                    <span>Outflow</span>
                    <strong className="numeric">{funds(summary.totalOutflow, summary.assetId)}</strong>
                  </div>
                  <div>
                    <span>Net movement</span>
                    <strong className="numeric">{funds(summary.net, summary.assetId)}</strong>
                  </div>
                </div>
                <p className="money-caption">
                  {summary.movements} ledger movements. Transfers between your spaces may appear in both inflow and outflow; they net out.
                  These figures are not gains, spending power or a complete valued portfolio.
                </p>
              </Section>
              <Section title="Outflow categories">
                {Object.entries(summary.outflowByCategory).length ? (
                  Object.entries(summary.outflowByCategory).map(([category, quantity]) => (
                    <div className="money-space-row" key={category}>
                      <span>{category}</span>
                      <strong className="numeric">{funds(quantity, summary.assetId)}</strong>
                    </div>
                  ))
                ) : (
                  <NoRows title="No outflow categories returned">
                    The service returned no categorized outflow for this exact asset and window.
                  </NoRows>
                )}
              </Section>
            </>
          )}
        </ResourceView>
      ) : (
        <NoRows title="Choose an asset and time window">This view does not invent a default spend period or balance.</NoRows>
      )}
    </BankPage>
  );
}
function BusinessApprovals({ accountId }: { accountId: string }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('business.pending', { accountId, limit });
  return (
    <Section title="Pending maker / checker approvals" description="The service verifies membership for this Bank policy record.">
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((approval) => (
                <article className="money-record" key={approval.id}>
                  <header>
                    <div>
                      <h3>{approval.status} transfer proposal</h3>
                      <p>{date(approval.createdAt)}</p>
                    </div>
                    <strong className="numeric">{funds(approval.amount, approval.assetId)}</strong>
                  </header>
                  <dl className="detail-list">
                    <div>
                      <dt>Maker</dt>
                      <dd>{approval.makerUserId}</dd>
                    </div>
                    <div>
                      <dt>Checker</dt>
                      <dd>{approval.checkerUserId ?? 'Not yet checked'}</dd>
                    </div>
                    <div>
                      <dt>Debit space</dt>
                      <dd>{approval.fromSpaceId}</dd>
                    </div>
                    <div>
                      <dt>Credit space</dt>
                      <dd>{approval.toSpaceId}</dd>
                    </div>
                    <div>
                      <dt>Reservation transaction</dt>
                      <dd>{approval.holdLedgerTxId ?? 'No reservation supplied'}</dd>
                    </div>
                    <div>
                      <dt>Posted transaction</dt>
                      <dd>{approval.ledgerTxId ?? 'Not posted'}</dd>
                    </div>
                    <div>
                      <dt>Approval reference</dt>
                      <dd>{approval.id}</dd>
                    </div>
                  </dl>
                  <p className="notice">
                    Approval, rejection and cancellation require verified company authority. This record does not provide an
                    organization-owned ledger context.
                  </p>
                </article>
              ))
            ) : (
              <NoRows title="No pending approvals returned">
                An empty pending list does not imply a company balance or permission to propose a transfer.
              </NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Business() {
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useBankRead('business.list', { limit });
  const { mode } = useSession();
  return (
    <BankPage
      room="Business"
      description="Bank membership and maker / checker policy records. These are distinct from a verified Business account."
    >
      <Section title="Company money">
        <div className="money-capability">
          <h3>Company balance and write authority are unavailable</h3>
          <p>
            The connected Bank contract does not supply an organization ledger owner or verified company identity. Its maker debit currently
            uses the actor’s personal space. Personal quantities cannot be labelled as company funds.
          </p>
          <p>
            Creating a company bank record, adding members, proposing transfers, approval decisions and payroll stay unavailable until those
            dependencies are connected.
          </p>
          <a className="text-link" href="/account">
            Account identity and verification ↗
          </a>
        </div>
      </Section>
      <Section
        title="Bank policy records"
        description={`Current product account context: ${mode}. Membership does not switch the account identity.`}
        actions={
          <Button variant="ghost" onClick={query.reload}>
            Refresh
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={query.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((record) => (
                  <article className="money-record" key={record.id}>
                    <header>
                      <div>
                        <h3>{record.name}</h3>
                        <p>
                          {record.assetId} · {record.status}
                        </p>
                      </div>
                      <span className="badge">Policy record</span>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>Checker threshold</dt>
                        <dd>{funds(record.spendThreshold, record.assetId)}</dd>
                      </div>
                      <div>
                        <dt>Created</dt>
                        <dd>{date(record.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Record reference</dt>
                        <dd>{record.id}</dd>
                      </div>
                    </dl>
                    <p className="money-caption">
                      Amounts over the configured threshold require separate maker and checker. The maker cannot approve their own proposal.
                      This record is not a company balance.
                    </p>
                    <Button variant="secondary" onClick={() => setSelected(record.id)}>
                      Read pending approvals
                    </Button>
                  </article>
                ))
              ) : (
                <NoRows title="No Bank policy memberships returned">
                  Verified company ownership and company balances remain separate missing contracts.
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      {selected && <BusinessApprovals accountId={selected} />}
    </BankPage>
  );
}
function Activity({ open }: { open: (spec: ActionSpec) => void }) {
  const asset = new URLSearchParams(location.search).get('asset');
  return (
    <Page
      eyebrow="Money"
      title={asset ? `${asset} activity` : 'Money activity'}
      description="Supported Bank operation records retain their actual status and ledger references."
      actions={
        <a className="button button--secondary" href={asset ? `/portfolio/${encodeURIComponent(asset)}` : '/portfolio'}>
          Back to holdings
        </a>
      }
    >
      <p className="notice">
        Whole-account ledger history is not exposed to customer sessions. The sections below are Bank schedules and rail records, not a
        complete statement.{asset && ` The asset context is ${asset}; each record keeps its own explicit asset.`}
      </p>
      <Schedules open={open} />
      <RampRecords direction="in" />
      <RampRecords direction="out" />
      <a className="link-row" href="/bank/cards">
        <span>
          Card decisions and declines<small>Inspect the actual card authorization history</small>
        </span>
        <span>↗</span>
      </a>
      <a className="link-row" href="/bank/analytics">
        <span>
          Movement analysis<small>Choose this asset and a time window</small>
        </span>
        <span>↗</span>
      </a>
    </Page>
  );
}
export function BankRoutes({ path, open }: { path: string; open: (spec: ActionSpec) => void }) {
  switch (path) {
    case '/bank/spaces':
      return <Spaces open={open} />;
    case '/bank/transfers':
      return <Transfers open={open} />;
    case '/bank/earn':
      return <Earn open={open} />;
    case '/bank/loans':
      return <Loans open={open} />;
    case '/bank/cards':
      return <Cards open={open} />;
    case '/bank/ramps':
      return <Ramps />;
    case '/bank/analytics':
      return <Analytics />;
    case '/bank/business':
      return <Business />;
    case '/uc/record':
      return <Activity open={open} />;
    default:
      return (
        <Page eyebrow="Money / Bank" title="Bank room unavailable">
          <EmptyState
            title="This Bank address is not registered"
            action={
              <a className="button button--secondary" href="/bank">
                Bank overview
              </a>
            }
          >
            Choose a registered Bank room.
          </EmptyState>
        </Page>
      );
  }
}
