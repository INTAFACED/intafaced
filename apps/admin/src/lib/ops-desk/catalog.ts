import type { Column, DeskPage, DeskSpec, DeskSection, OpsDeskId, ReadSpec, Unavailable } from './types';

/**
 * What each module desk reads, and what it admits it cannot read.
 *
 * Every read below is a procedure that exists today in the owning service's router, with the columns copied from its
 * output schema. Nothing is invented: a figure the service does not give (a loan book total, an offers count, a share
 * count) is listed under `unavailable` with the reason and the number of the back-end need that would unblock it
 * (admin-BACKEND-NEEDS.md). The page prints those as "not available", never as zero.
 *
 * All of these run as the signed-in founder through svc-edge (`founderCall`). The services check scopes themselves;
 * a founder session that lacks one gets the service's refusal, shown in words, and the rest of the desk still loads.
 */

const FORBID_BANK = 'svc-bank did not accept your founder session for this read (it needs bank:read).';
const FORBID_BANK_OPS = 'svc-bank did not accept your founder session for this read (it needs the operator permission admin:read).';

const col = (key: string, label: string, kind: Column['kind'], extra: Partial<Column> = {}): Column => ({ key, label, kind, ...extra });
const text = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'text', extra);
const int = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'int', extra);
const bool = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'bool', extra);
const time = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'time', extra);
const bps = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'bps', extra);
const amount = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'amount', extra);
const list = (key: string, label: string, extra?: Partial<Column>) => col(key, label, 'list', extra);

const un = (id: string, label: string, reason: string, need: number | null): Unavailable => ({ id, label, reason, need });

// ─── Bank ────────────────────────────────────────────────────────────────────────────────────────────────────────

const bankHealth: ReadSpec = {
  id: 'bank.health',
  title: 'Service health',
  note: 'Whether svc-bank answers. Process liveness only; it says nothing about the rails behind it.',
  module: 'bank',
  procedure: 'health',
  shape: 'record',
  columns: [bool('ok', 'Answering'), text('service', 'Service')],
  emptyText: '',
  forbiddenText: FORBID_BANK,
};

const bankSections: readonly DeskSection[] = [
  {
    id: 'service',
    title: 'Service',
    intro: 'Is the neo-bank service up.',
    reads: [bankHealth],
    unavailable: [],
    disabledActions: [],
    links: [
      {
        href: '/tools',
        label: 'Bank ops jobs (Operator tools)',
        why: 'Run due transfers, accrue interest, risk sweep, resume or abandon pending loans, reconcile the loan reserve. They run as treasury jobs and already have their own forms.',
      },
    ],
  },
  {
    id: 'pools',
    title: 'Earn pools',
    intro: 'The pool catalogue: rate and minimum for each pool. This is the product on offer, not the money held in it.',
    reads: [
      {
        id: 'bank.pools',
        title: 'Earn pools offered',
        note: 'The rate and minimum deposit of each pool, as svc-bank publishes them. APR is the pool rate; no balances are read.',
        module: 'bank',
        procedure: 'earn.pools',
        input: { limit: 200 },
        shape: 'list',
        idKey: 'id',
        page: 200,
        columns: [
          text('name', 'Pool'),
          text('assetId', 'Asset'),
          text('kind', 'Kind'),
          bps('aprBps', 'APR'),
          int('termDays', 'Term (days)', { nullable: true }),
          amount('minDeposit', 'Minimum deposit'),
          text('id', 'Pool id', { detail: true }),
        ],
        emptyText: 'svc-bank lists no earn pools. That means none are configured, not that Earn is healthy.',
        forbiddenText: FORBID_BANK,
      },
      {
        id: 'bank.pool-totals',
        title: 'Money held in each pool',
        note: 'What each pool holds now (the ledger balance of every active position, added up) and how many people hold a position. Utilisation is not recorded by svc-bank, so no figure is given. If the ledger cannot be read the pool shows the reason, never zero.',
        module: 'bank',
        plainName: 'pool balances',
        procedure: 'ops.poolTotals',
        shape: 'list',
        rowsKey: 'pools',
        idKey: 'poolId',
        namesFrom: { read: 'bank.pools', idKey: 'id', nameKey: 'name', label: 'Pool', missing: 'the earn pools list above' },
        columns: [
          text('poolId', 'Pool id'),
          text('assetId', 'Asset'),
          amount('amountHeld', 'Held in the pool', { nullable: true }),
          text('amountReason', 'Why there is no figure', { nullable: true }),
          int('depositorCount', 'People holding a position'),
          text('utilisationReason', 'Utilisation'),
        ],
        emptyText: 'svc-bank has no earn pool to total. That means none are configured.',
        forbiddenText: 'svc-bank did not accept your founder session for this read (it needs admin:read or admin:treasury).',
      },
    ],
    unavailable: [],
    disabledActions: [
      {
        id: 'bank.fund-pool',
        label: 'Fund a pool',
        reason:
          'Moves treasury money, so it stays on Operator tools (treasury credential, two-founder approval at the service), not on this read desk.',
      },
    ],
    links: [],
  },
  {
    id: 'loans',
    title: 'Loans book',
    intro: 'The loan products and the thresholds a borrower is held to, then the book as it stands.',
    reads: [
      {
        id: 'bank.loan-products',
        title: 'Loan products',
        note: 'Rate, maximum loan-to-value and the margin-call and liquidation levels of each product. These are product terms, not loans outstanding.',
        module: 'bank',
        procedure: 'loans.products',
        input: { limit: 200 },
        shape: 'list',
        idKey: 'id',
        page: 200,
        columns: [
          text('name', 'Product'),
          text('debtAssetId', 'Borrow'),
          text('collateralAssetId', 'Collateral'),
          bps('aprBps', 'APR'),
          bps('maxLtvBps', 'Max LTV'),
          bps('marginCallLtvBps', 'Margin call at'),
          bps('liquidationLtvBps', 'Liquidation at'),
          amount('minPrincipal', 'Minimum loan'),
          text('quoteAssetId', 'Priced in', { detail: true }),
          text('id', 'Product id', { detail: true }),
        ],
        emptyText: 'svc-bank lists no loan products. That means none are configured.',
        forbiddenText: FORBID_BANK,
      },
      {
        id: 'bank.loan-book',
        title: 'Loan book',
        note: 'Open loans are active, margin-call and liquidating ones. Each is placed in a band using the levels stored on the loan when it opened. A loan with no usable price is counted as unpriced, never as healthy.',
        module: 'bank',
        plainName: 'the loan book',
        procedure: 'ops.loanBook',
        shape: 'record',
        columns: [
          int('openCount', 'Open loans'),
          col('outstandingPrincipal', 'Outstanding principal', 'assetAmounts'),
          int('bands.healthy', 'Healthy'),
          int('bands.marginCall', 'At margin call'),
          int('bands.liquidation', 'At liquidation'),
          int('bands.unpriced', 'Without a usable price'),
          text('oldestPending.id', 'Oldest pending loan', { nullable: true, parentNullable: true }),
          int('oldestPending.ageSeconds', 'Its age (seconds)', { nullable: true, parentNullable: true }),
        ],
        emptyText: '',
        forbiddenText: FORBID_BANK_OPS,
      },
      {
        id: 'bank.loans-unpriced',
        title: 'Open loans with no usable price',
        note: 'Loans svc-bank cannot place in a band, and why. An empty list is not a statement that the book is healthy.',
        module: 'bank',
        plainName: 'the loans without a price',
        procedure: 'ops.loanBook',
        shape: 'list',
        rowsKey: 'unpriced',
        idKey: 'loanId',
        columns: [text('loanId', 'Loan id'), text('reason', 'Why')],
        emptyText: 'svc-bank reports no open loan without a usable price. That is not a statement that the book is healthy.',
        forbiddenText: FORBID_BANK_OPS,
      },
    ],
    unavailable: [],
    disabledActions: [
      {
        id: 'bank.seize-loan',
        label: 'Seize or liquidate a loan',
        reason:
          'Moves collateral. It is a treasury procedure on Operator tools and is not repeated here: the loan book gives counts and the ids of unpriced loans, not a list of loans to choose from.',
      },
    ],
    links: [
      {
        href: '/tools',
        label: 'Risk sweep and loan jobs',
        why: 'runRiskSweep, resumePendingLoans, abandonPendingLoan, reconcileLoanReserve.',
      },
    ],
  },
  {
    id: 'cards',
    title: 'Card programme',
    intro: 'What the card programme on this deployment is, including when it is a simulation.',
    reads: [
      {
        id: 'bank.card-programme',
        title: 'Card programme status',
        note: 'Whether cards are issued by a real issuer or simulated. A simulated programme must be treated as no real cards.',
        module: 'bank',
        procedure: 'cards.programme',
        shape: 'record',
        columns: [text('displayName', 'Programme'), bool('simulated', 'Simulated'), text('id', 'Programme id')],
        emptyText: '',
        forbiddenText: FORBID_BANK,
      },
      {
        id: 'bank.card-counts',
        title: 'Cards issued (all time) · authorisations, last 30 days',
        note: 'How many cards exist and in what state, across all owners. "Simulated" is the issuer’s own flag: true means no real card was issued.',
        module: 'bank',
        plainName: 'card counts',
        procedure: 'ops.cardProgramme',
        windowDays: 30,
        shape: 'record',
        columns: [bool('simulated', 'Simulated issuer'), int('issued', 'Issued'), int('active', 'Active'), int('frozen', 'Frozen')],
        emptyText: '',
        forbiddenText: FORBID_BANK_OPS,
      },
      {
        id: 'bank.card-days',
        title: 'Card authorisations by day, last 30 days',
        note: 'Approved volume per asset and declines for each UTC day, from the card authorisations svc-bank decided in the window. A day with nothing shows no volume, not a guess.',
        module: 'bank',
        plainName: 'card authorisations',
        procedure: 'ops.cardProgramme',
        windowDays: 30,
        shape: 'list',
        rowsKey: 'days',
        idKey: 'day',
        columns: [text('day', 'Day (UTC)'), col('volume', 'Approved volume', 'assetAmounts'), int('declines', 'Declined')],
        emptyText: 'svc-bank returned no days for this window.',
        forbiddenText: FORBID_BANK_OPS,
      },
    ],
    unavailable: [],
    disabledActions: [],
    sectionAction: 'bank.card.status',
    links: [],
  },
  {
    id: 'global-holds',
    title: 'Global send holds',
    intro: 'Sends held before they were debited: the queue, the owner settings behind it, and who may release.',
    reads: [],
    unavailable: [],
    disabledActions: [],
    links: [
      {
        href: '/bank-ops/holds',
        label: 'Global send holds',
        why: 'The hold queue, release, information requests and the customer’s file are on their own page.',
      },
    ],
  },
  {
    id: 'customer-balances',
    title: 'Customer balances',
    intro:
      'One customer’s balance per coin and the entries behind it, for the finance-treasury desk. It needs the treasury permission on your session; a session without it is refused in words. The support view of the same figures waits on the customer consent grant (PF-ops-01) and is not here.',
    reads: [],
    unavailable: [],
    disabledActions: [],
    sectionAction: 'bank.customer.balances',
    links: [],
  },
  {
    id: 'ramps',
    title: 'Ramps',
    intro: 'The on- and off-ramp programme and whether fiat can settle at all.',
    reads: [
      {
        id: 'bank.ramp-programme',
        title: 'Ramp programme',
        note: 'Which rail the programme uses, and whether it is simulated. Simulated ramps move no real cash.',
        module: 'bank',
        procedure: 'ramps.programme',
        shape: 'record',
        columns: [
          text('displayName', 'Programme'),
          bool('simulated', 'Simulated'),
          text('cryptoRail', 'Crypto rail', { nullable: true }),
          text('fiatLeg', 'Fiat leg'),
          text('fiatVia', 'Fiat via'),
          text('id', 'Programme id', { detail: true }),
        ],
        emptyText: '',
        forbiddenText: FORBID_BANK,
      },
      {
        id: 'bank.fiat-settle',
        title: 'Fiat settlement probe',
        note: 'Asks svc-bank whether svc-pay has a rail that can settle fiat. A refusal here is the answer: no rail can.',
        module: 'bank',
        procedure: 'ramps.fiatSettle',
        shape: 'record',
        columns: [bool('canSettle', 'Can settle fiat'), text('onrampRailId', 'On-ramp rail'), text('offrampRailId', 'Off-ramp rail')],
        emptyText: '',
        forbiddenText: FORBID_BANK,
      },
      {
        id: 'bank.ramp-health',
        title: 'Ramp rails, last 24 hours',
        note: 'For each rail: when it last succeeded and failed, what is open, and failures out of attempts in the window. An unset provider is not a healthy rail. svc-bank gives no heartbeat, so none is shown.',
        module: 'bank',
        plainName: 'ramp health',
        procedure: 'ops.rampHealth',
        input: { windowHours: 24 },
        shape: 'list',
        rowsKey: 'rails',
        idKey: 'id',
        columns: [
          text('id', 'Rail'),
          text('provider', 'Provider'),
          int('openCount', 'Open now'),
          int('failureCount', 'Failed'),
          int('totalCount', 'Attempts'),
          text('failureRate', 'Failed out of attempts', { nullable: true }),
          time('lastSuccess', 'Last success', { nullable: true }),
          time('lastFailure', 'Last failure', { nullable: true }),
          text('reason', 'Heartbeat', { detail: true }),
        ],
        emptyText: 'svc-bank lists no ramp rail.',
        forbiddenText: FORBID_BANK_OPS,
      },
    ],
    unavailable: [
      un(
        'bank.ramp-heartbeat',
        'Provider heartbeat, fiat provider status and ramp volumes',
        'svc-bank records no heartbeat from any provider and its fiat provider is unset, so the rails above show only what the ledger rail recorded. It gives no ramp volume read.',
        16,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'business',
    title: 'Business bank and approvals',
    intro: 'The rules the business bank enforces on transfers and payroll.',
    reads: [
      {
        id: 'bank.business-policy',
        title: 'Business approval rules',
        note: 'The standing rules, not a queue: who may approve, and what posts immediately.',
        module: 'bank',
        procedure: 'business.policy',
        shape: 'record',
        columns: [
          bool('dualControlOverThreshold', 'Two people over the threshold'),
          bool('makerCannotSelfApprove', 'Maker cannot approve own transfer'),
          bool('holdBeforeCheckerApprove', 'Funds held until a checker approves'),
          bool('underThresholdPostsImmediately', 'Under the threshold posts at once'),
          bool('payrollAtomicAllOrNothing', 'Payroll is all-or-nothing'),
          bool('payrollSameAssetOnly', 'Payroll in one asset only'),
          list('roles', 'Roles'),
        ],
        emptyText: '',
        forbiddenText: FORBID_BANK,
      },
      {
        id: 'bank.business-approvals',
        title: 'Business transfers waiting for their own checker',
        note: 'Pending transfers across every business, oldest first by the service’s order. Read-only: the business’s own checker approves or rejects, never an operator. A maker the directory cannot name shows the reason.',
        module: 'bank',
        plainName: 'business approvals',
        procedure: 'ops.businessApprovals',
        input: { limit: 50 },
        shape: 'list',
        rowsKey: 'approvals',
        anonymousRows: true,
        page: 50,
        columns: [
          text('businessId', 'Business id'),
          amount('amount', 'Amount'),
          text('assetId', 'Asset'),
          amount('rule', 'Business spend threshold'),
          int('ageSeconds', 'Waiting (seconds)'),
          text('makerHandle', 'Proposed by', { nullable: true }),
          text('makerHandleReason', 'Why no name', { nullable: true, detail: true }),
        ],
        emptyText: 'No business transfer is waiting for a checker.',
        forbiddenText: FORBID_BANK_OPS,
      },
    ],
    unavailable: [],
    disabledActions: [
      {
        id: 'bank.business-approve',
        label: 'Approve or reject a business transfer',
        reason:
          'By design the approval is the business’s own checker (maker cannot approve their own). An operator approving on a business’s behalf would defeat that, so there is no such procedure.',
      },
    ],
    links: [],
  },
  {
    id: 'freezes',
    title: 'Freezes',
    intro: 'Stopping a person or a business from using the bank.',
    reads: [],
    unavailable: [
      un(
        'bank.frozen-list',
        'List of frozen or restricted accounts',
        'Identity records every restriction in its control history, but has no read that lists the restricted accounts. You can inspect one account by id.',
        18,
      ),
    ],
    disabledActions: [],
    links: [
      {
        href: '/accounts',
        label: 'Account controls',
        why: 'Inspect one account, read its control history, restrict or restore it with a reason.',
      },
      { href: '/ledger', label: 'Ledger freeze', why: 'Stops all value movement platform-wide (two founders).' },
    ],
  },
];

// ─── Personal Pay ────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_PAY_READ =
  'svc-bank did not accept your founder session for this read (it needs the operator permission admin:read on an interactive sign-in; a long-lived key is refused).';
const FORBID_PAY_COMPLIANCE =
  'svc-bank did not accept your founder session for this read (it needs the operator permission admin:compliance on an interactive sign-in; admin:read alone is refused).';

/** Typed refusals of the three transfer reads, each with the real reason in a sentence. */
const TRANSFER_REFUSALS: Readonly<Record<string, string>> = {
  'bank.transfer_health_window_unset':
    'svc-bank refused because this console sent no valid window. The window must be a whole number of hours from 1 to 720, and svc-bank has no default.',
  'bank.failed_transfers_window_unset':
    'svc-bank refused because this console sent no valid window. The window must be a whole number of hours from 1 to 720, and svc-bank has no default.',
  'bank.failed_transfers_limit_unset':
    'svc-bank refused because this console sent no page size. svc-bank has no default page size, so a blank one is refused.',
  'bank.failed_transfers_cursor_invalid': 'svc-bank refused the page marker as one it did not issue.',
  'bank.party_handles_unset':
    'svc-bank cannot name the sender and receiver because its identity lookup (IDENTITY_URL) is not set. It refuses the whole list rather than show rows without names.',
  'bank.party_handles_unavailable':
    'The identity service did not answer svc-bank’s name lookup, so svc-bank refused the whole list rather than show rows without names. Nothing is shown.',
  'bank.ops_transfer_not_found':
    'svc-bank has no transfer with this id. It gives the same answer for an id that is not in its format, so this does not say which.',
};

const BILLS_REFUSALS: Readonly<Record<string, string>> = {
  'bank.bills_list_limit_unset': 'svc-bank refused because this console sent no page size. svc-bank has no default page size.',
  'bank.global_list_limit_unset': 'svc-bank refused because this console sent no page size. svc-bank has no default page size.',
  'bank.bills_cursor_invalid': 'svc-bank refused the page marker as one it did not issue.',
};

/**
 * The rate columns of a transfer-health block. svc-bank gives a ratio as a decimal string or a reduced fraction ("0.25",
 * "1/3"), or null when the window has no rows; it is shown as the service wrote it.
 */
const RATE_NOTE =
  'The rate is a ratio the service computed (0.25 is one in four; 1/3 is a third). A dash means the window holds no rows, so there is no ratio to give: it is not zero.';

function payHealth(hours: 24 | 168): { standing: ReadSpec; oneOff: ReadSpec; bills: ReadSpec } {
  const when = hours === 24 ? 'last 24 hours' : 'last 7 days';
  const key = hours === 24 ? '24h' : '7d';
  const base = {
    module: 'bank',
    procedure: 'ops.transferHealth',
    input: { windowHours: hours },
    shape: 'record',
    emptyText: '',
    forbiddenText: FORBID_PAY_READ,
    refusals: TRANSFER_REFUSALS,
  } as const;
  return {
    standing: {
      ...base,
      id: `pay.standing-${key}`,
      title: `Standing orders attempted, ${when}`,
      note: `Executions of standing orders whose attempt time falls in the ${when}. Counts only; no money total is given. ${RATE_NOTE}`,
      plainName: `standing-order health (${when})`,
      columns: [
        time('asOf', 'Computed by svc-bank at'),
        int('standingOrders.total', 'Attempts'),
        int('standingOrders.settled', 'Settled'),
        int('standingOrders.pending', 'Pending'),
        int('standingOrders.rejected', 'Rejected'),
        int('standingOrders.skipped', 'Skipped'),
        text('standingOrders.failureRate', 'Rejected out of attempts', { nullable: true }),
        col(
          'standingOrders.oldestPendingAgeSeconds',
          'Oldest pending among attempts in this window (older ones are not counted; a dash means none in this window is pending)',
          'seconds',
          {
            nullable: true,
          },
        ),
      ],
    },
    oneOff: {
      ...base,
      id: `pay.oneoff-${key}`,
      title: `One-off sends created, ${when}`,
      note: `Person-to-person sends created in the ${when}. svc-bank stores only reserved and posted sends: a refused send deletes its reservation, so a failure count does not exist and the rate is a dash with that reason.`,
      plainName: `one-off send health (${when})`,
      columns: [
        time('asOf', 'Computed by svc-bank at'),
        bool('oneOff.available', 'svc-bank counts one-off sends', { mustBe: true }),
        int('oneOff.total', 'Created'),
        int('oneOff.posted', 'Posted'),
        int('oneOff.reserved', 'Reserved, not yet posted'),
        text('oneOff.failureRate', 'Failed out of created', { nullable: true, alwaysNull: true }),
        text('oneOff.failureRateReason', 'Why there is no failure figure', { mustBe: 'failures_not_recorded' }),
        col(
          'oneOff.oldestPendingAgeSeconds',
          'Oldest reserved among sends created in this window (older ones are not counted; a dash means none created in this window is still reserved)',
          'seconds',
          {
            nullable: true,
          },
        ),
      ],
    },
    bills: {
      ...base,
      id: `pay.bills-${key}`,
      title: `Bill payments created, ${when}`,
      note: `Bill payments created in the ${when}. Returned is its own count and is not folded into failed. ${RATE_NOTE}`,
      plainName: `bill payment health (${when})`,
      columns: [
        time('asOf', 'Computed by svc-bank at'),
        bool('bills.available', 'svc-bank counts bill payments', { mustBe: true }),
        int('bills.total', 'Created'),
        int('bills.paid', 'Paid'),
        int('bills.accepted', 'Accepted by the biller'),
        int('bills.submitted', 'Submitted, not yet accepted'),
        int('bills.failed', 'Failed'),
        int('bills.returned', 'Returned'),
        text('bills.failureRate', 'Failed out of created', { nullable: true }),
        col(
          'bills.oldestPendingAgeSeconds',
          'Oldest submitted among payments created in this window (older ones are not counted; a dash means none created in this window is still waiting)',
          'seconds',
          {
            nullable: true,
          },
        ),
      ],
    },
  };
}

const health24 = payHealth(24);
const health7d = payHealth(168);

const payP2pPointer: ReadSpec = {
  id: 'pay.p2p-pointer',
  title: 'P2P transfers',
  note: 'svc-bank states that it does not count P2P trades and gives no number for them. They are counted by svc-p2p on the P2P desk.',
  module: 'bank',
  plainName: 'the P2P pointer',
  procedure: 'ops.transferHealth',
  input: { windowHours: 24 },
  shape: 'record',
  columns: [
    bool('p2p.available', 'svc-bank counts P2P trades', { mustBe: false }),
    text('p2p.reason', 'Where they are counted', { mustBe: 'served_by_p2p_ops' }),
  ],
  emptyText: '',
  forbiddenText: FORBID_PAY_READ,
  refusals: TRANSFER_REFUSALS,
};

const payFailedStanding: ReadSpec = {
  id: 'pay.failed-standing',
  title: 'Rejected standing-order transfers, last 7 days',
  note: 'Newest first. Rejected executions only: svc-bank records no failed one-off sends, so none are listed (see below). Fifty a page: when svc-bank says more exist, “Next 50” reads the next page; the 7-day figure under Transfer health is the count. A dash in a name column is explained in the column beside it. Open a row to read its full record.',
  cursorKey: 'nextCursor',
  module: 'bank',
  plainName: 'the rejected standing orders',
  procedure: 'ops.failedTransfers',
  input: { windowHours: 168, limit: 50 },
  shape: 'list',
  rowsKey: 'items',
  idKey: 'id',
  page: 50,
  rowAction: 'pay.transfer.detail',
  columns: [
    time('attemptedAt', 'Attempted'),
    amount('amount', 'Amount'),
    text('assetId', 'Asset'),
    text('reason', 'Why it was rejected'),
    text('sender.handle', 'Sender', { nullable: true }),
    text('sender.reason', 'Why no sender name', { nullable: true }),
    text('receiver.handle', 'Receiver', { nullable: true }),
    text('receiver.reason', 'Why no receiver name', { nullable: true }),
    text('rejectionCode', 'Rejection code (in words)', { detail: true }),
    text('status', 'Status', { detail: true, mustBe: 'rejected' }),
    text('kind', 'Kind', { detail: true, mustBe: 'standing_order' }),
    text('id', 'Execution id', { detail: true }),
  ],
  emptyText:
    'svc-bank lists no rejected standing-order execution in the last 7 days. That means none were rejected in that window, not that every transfer worked: one-off sends and bills are not in this list.',
  forbiddenText: FORBID_PAY_COMPLIANCE,
  refusals: TRANSFER_REFUSALS,
};

/**
 * One transfer's full record. Not part of any section: it is read on request (a row's Open, or the id box), because svc-bank
 * writes a log line with the reader and the id every time it hands one out.
 */
export const PAY_TRANSFER_DETAIL: ReadSpec = {
  id: 'pay.transfer-detail',
  title: 'Transfer record',
  note: 'One standing-order execution or one one-off send. A dash means svc-bank holds no value for that field for this kind of transfer: a one-off send has no schedule, occurrence, rejection code or settle time, and an unsettled transfer has no settle time or ledger transaction.',
  module: 'bank',
  plainName: 'the transfer record',
  procedure: 'ops.transferDetail',
  shape: 'record',
  columns: [
    text('kind', 'Kind'),
    text('status', 'Status'),
    amount('amount', 'Amount'),
    text('assetId', 'Asset'),
    time('attemptedAt', 'Attempted (created, for a one-off send)'),
    time('settledAt', 'Settled', { nullable: true }),
    text('reason', 'Why it was rejected', { nullable: true }),
    text('rejectionCode', 'Rejection code (in words)', { nullable: true }),
    text('senderUserId', 'Sender (account id)'),
    text('receiverUserId', 'Receiver (account id)'),
    text('ledgerTxId', 'Ledger transaction', { nullable: true }),
    text('scheduleId', 'Standing order (schedule id)', { nullable: true }),
    int('occurrence', 'Occurrence number', { nullable: true }),
    text('id', 'Transfer id'),
  ],
  emptyText: '',
  forbiddenText: FORBID_PAY_COMPLIANCE,
  refusals: TRANSFER_REFUSALS,
};

const FORBID_BANK_TREASURY =
  'svc-bank did not accept your founder session for this read (it needs the treasury permission admin:treasury, with a verified second factor).';

const CUSTOMER_BALANCE_REFUSALS: Readonly<Record<string, string>> = {
  'bank.ops_audit_unavailable':
    'svc-bank could not record that you asked, so it read nothing. It writes that record before it reads any figure, and refuses when it cannot.',
  'portfolio.entries_do_not_sum':
    'svc-bank read the customer’s entries and they do not add up to the balance it holds now. It refuses to show entries that disagree with the balance. Asking again can pass if a posting was landing at the same moment.',
  'bank.activity_lookup_bounded':
    'This customer’s history for this coin is longer than svc-bank will add up in one read, so it shows no entries rather than a partial list.',
};

/**
 * One customer's balances for the finance-treasury desk (PF-balances-01), asked for by the customer's account id. Not part of any
 * section: it is read on request, because svc-bank writes a log line with the operator and the customer before it reads any
 * figure. The split is the customer's own: total, available and one column per lock kind, from the ledger.
 */
export const BANK_CUSTOMER_BALANCES: ReadSpec = {
  id: 'bank.customer-balances',
  title: 'Customer balances',
  note: 'The customer’s balance per coin as the ledger holds it: the total, what is available, and what is locked by each kind of lock. Nothing here is summed or converted by this console.',
  module: 'bank',
  plainName: 'the customer’s balances',
  procedure: 'ops.customerBalances',
  shape: 'list',
  rowsKey: 'assets',
  idKey: 'assetId',
  columns: [
    text('assetId', 'Coin'),
    amount('total', 'Total'),
    amount('available', 'Available'),
    amount('hold', 'On hold'),
    amount('escrow', 'In escrow'),
    amount('stake', 'Staked'),
    amount('collateral', 'Collateral'),
  ],
  emptyText: 'The ledger holds no balance for this customer. That means no coin has ever been posted to them, not that the id is right.',
  forbiddenText: FORBID_BANK_TREASURY,
  refusals: CUSTOMER_BALANCE_REFUSALS,
};

/** The entries behind one coin's available balance, newest first, a page at a time. Shares one call with the sum check below. */
export const BANK_CUSTOMER_ENTRIES: ReadSpec = {
  id: 'bank.customer-entries',
  title: 'Entries behind the balance',
  note: 'Every posting that makes up the available balance of one coin, newest first. A debit counts as plus and a credit as minus, the way the ledger signs them.',
  module: 'bank',
  plainName: 'the customer’s entries',
  procedure: 'ops.customerBalanceEntries',
  shape: 'list',
  rowsKey: 'entries',
  anonymousRows: true,
  cursorKey: 'nextCursor',
  columns: [
    time('postedAt', 'Posted'),
    text('direction', 'Debit or credit'),
    amount('amount', 'Amount'),
    text('reason', 'Reason'),
    text('txId', 'Ledger transaction'),
    text('accountId', 'Account', { detail: true }),
    text('entryId', 'Entry id', { nullable: true, detail: true }),
  ],
  emptyText: 'The ledger holds no entry behind this coin for this customer.',
  forbiddenText: FORBID_BANK_TREASURY,
  refusals: CUSTOMER_BALANCE_REFUSALS,
};

export const BANK_CUSTOMER_ENTRIES_CHECK: ReadSpec = {
  id: 'bank.customer-entries-check',
  title: 'Do the entries add up to the balance',
  note: 'svc-bank adds the entries it holds and compares the sum with the balance it holds now. It only answers when the two agree.',
  module: 'bank',
  plainName: 'the entries check',
  procedure: 'ops.customerBalanceEntries',
  shape: 'record',
  columns: [
    bool('sumCheck.ok', 'Entries add up to the balance', { mustBe: true }),
    amount('sumCheck.entriesSum', 'Sum of all entries'),
    amount('sumCheck.balance', 'Balance now'),
    int('sumCheck.entryCount', 'Entries counted'),
  ],
  emptyText: '',
  forbiddenText: FORBID_BANK_TREASURY,
  refusals: CUSTOMER_BALANCE_REFUSALS,
};

const payBillsSummary: ReadSpec = {
  id: 'pay.bills-summary',
  title: 'Bill payments, all time',
  note: 'Counts by status over every bill payment, and whether each provider connection is set. "Unset" means no provider is connected, which is not the same as a rail that is up.',
  module: 'bank',
  plainName: 'the bill payment summary',
  procedure: 'bills.ops.summary',
  shape: 'record',
  columns: [
    time('asOf', 'Computed by svc-bank at'),
    int('counts.paid', 'Paid'),
    int('counts.accepted', 'Accepted by the biller'),
    int('counts.submitted', 'Submitted, not yet accepted'),
    int('counts.failed', 'Failed'),
    int('counts.returned', 'Returned'),
    text('rails.billerDirectory', 'Biller directory (unset: none connected)'),
    text('rails.lookup', 'Biller lookup (unset: none connected)'),
    text('rails.payRail', 'Pay rail (unset: none connected)'),
    text('rails.blocker', 'Waiting on'),
  ],
  emptyText: '',
  forbiddenText: FORBID_PAY_READ,
};

const payBillsVolumes: ReadSpec = {
  id: 'pay.bills-volumes',
  title: 'Bill payments by status and asset, all time',
  note: 'The amount is the service’s own sum for each status and asset. svc-bank gives these rows no id, so they have no detail.',
  module: 'bank',
  plainName: 'the bill payment volumes',
  procedure: 'bills.ops.summary',
  shape: 'list',
  rowsKey: 'volumes',
  anonymousRows: true,
  columns: [text('status', 'Status'), text('assetId', 'Asset'), int('count', 'Payments'), amount('amount', 'Total amount')],
  emptyText: 'svc-bank holds no bill payment, so there is no volume. That is not a statement that bill pay is healthy.',
  forbiddenText: FORBID_PAY_READ,
};

const payBillsFailed: ReadSpec = {
  id: 'pay.bills-failed',
  title: 'Failed bill payments',
  note: 'Newest first, status failed only (a returned payment is not in this list). Fifty a page: when svc-bank says more exist, “Next 50” reads the next page.',
  cursorKey: 'nextCursor',
  module: 'bank',
  plainName: 'the failed bill payments',
  procedure: 'bills.ops.failed',
  input: { limit: 50 },
  shape: 'list',
  rowsKey: 'items',
  idKey: 'id',
  page: 50,
  columns: [
    time('createdAt', 'Created'),
    text('billerId', 'Biller'),
    amount('amount', 'Amount'),
    text('assetId', 'Asset'),
    text('failureCode', 'Failure', { nullable: true }),
    text('failureBlocker', 'Waiting on', { nullable: true }),
    text('reference', 'Reference at the biller', { detail: true }),
    text('status', 'Status', { detail: true, mustBe: 'failed' }),
    text('userId', 'Payer (account id)', { detail: true }),
    text('fromSpaceId', 'Paid from (space id)', { detail: true }),
    text('providerRef', 'Provider reference', { nullable: true, detail: true }),
    text('ledgerTxId', 'Ledger transaction', { nullable: true, detail: true }),
    time('updatedAt', 'Last changed', { detail: true }),
    text('id', 'Payment id', { detail: true }),
  ],
  emptyText:
    'svc-bank lists no failed bill payment. That means none have failed, not that bill pay is working: a payment that was never attempted is not here.',
  forbiddenText: FORBID_PAY_READ,
  refusals: BILLS_REFUSALS,
};

const payGlobalSummary: ReadSpec = {
  id: 'pay.global-summary',
  title: 'Global sends, all time',
  note: 'Counts by status over every cross-border send, and whether each provider connection is set. "Unset" means no provider is connected; travel-rule "undecided" means no decision is recorded.',
  module: 'bank',
  plainName: 'the global send summary',
  procedure: 'global.ops.summary',
  shape: 'record',
  columns: [
    time('asOf', 'Computed by svc-bank at'),
    int('counts.arrived', 'Arrived'),
    int('counts.on_the_way', 'On the way'),
    int('counts.sent', 'Sent'),
    int('counts.submitted', 'Submitted, not yet sent'),
    int('counts.failed', 'Failed'),
    int('counts.held', 'On hold'),
    int('counts.cancelled', 'Cancelled while on hold'),
    int('counts.returned', 'Returned by the rail, not refunded'),
    int('counts.refunded', 'Returned and refunded'),
    text('rails.corridors', 'Corridors (unset: none connected)'),
    text('rails.fx', 'Exchange rates (unset: none connected)'),
    text('rails.payout', 'Payout (unset: none connected)'),
    text('rails.bic', 'Bank code directory (unset: none connected)'),
    text('rails.travelRule', 'Travel-rule decision'),
    text('rails.blocker', 'Waiting on'),
  ],
  emptyText: '',
  forbiddenText: FORBID_PAY_READ,
};

const payGlobalVolumes: ReadSpec = {
  id: 'pay.global-volumes',
  title: 'Global sends by status and asset, all time',
  note: 'The amount is the service’s own sum for each status and asset. svc-bank gives these rows no id, so they have no detail.',
  module: 'bank',
  plainName: 'the global send volumes',
  procedure: 'global.ops.summary',
  shape: 'list',
  rowsKey: 'volumes',
  anonymousRows: true,
  columns: [text('status', 'Status'), text('assetId', 'Asset'), int('count', 'Sends'), amount('amount', 'Total amount')],
  emptyText: 'svc-bank holds no global send, so there is no volume. That is not a statement that global send is healthy.',
  forbiddenText: FORBID_PAY_READ,
};

const payGlobalFailed: ReadSpec = {
  id: 'pay.global-failed',
  title: 'Failed global sends',
  note: 'Newest first, status failed only. The 50 newest. svc-bank gives this list no page marker, so when exactly 50 are shown more may exist and older failures cannot be reached from here.',
  module: 'bank',
  plainName: 'the failed global sends',
  procedure: 'global.ops.failed',
  input: { limit: 50 },
  shape: 'list',
  idKey: 'id',
  page: 50,
  columns: [
    time('createdAt', 'Created'),
    amount('amount', 'Amount'),
    text('assetId', 'Asset'),
    text('toCurrency', 'Pays out in'),
    text('country', 'Country'),
    text('deliveryMethod', 'Delivery'),
    text('failureCode', 'Failure', { nullable: true }),
    text('failureBlocker', 'Waiting on', { nullable: true }),
    text('status', 'Status', { detail: true, mustBe: 'failed' }),
    text('userId', 'Sender (account id)', { detail: true }),
    text('fromSpaceId', 'Sent from (space id)', { detail: true }),
    text('recipientId', 'Recipient (id)', { detail: true }),
    text('providerRef', 'Provider reference', { nullable: true, detail: true }),
    text('quoteRate', 'Quoted rate', { nullable: true, detail: true }),
    text('quoteFee', 'Quoted fee', { nullable: true, detail: true }),
    text('quoteFeeAsset', 'Quoted fee asset', { nullable: true, detail: true }),
    text('quoteReceive', 'Quoted amount received', { nullable: true, detail: true }),
    text('quoteValidUntil', 'Quote valid until', { nullable: true, detail: true }),
    text('quoteEta', 'Quoted arrival', { nullable: true, detail: true }),
    text('ledgerTxId', 'Ledger transaction', { nullable: true, detail: true }),
    time('updatedAt', 'Last changed', { detail: true }),
    text('id', 'Send id', { detail: true }),
  ],
  emptyText: 'svc-bank lists no failed global send. That means none have failed, not that global send is working.',
  forbiddenText: FORBID_PAY_READ,
  refusals: BILLS_REFUSALS,
};

const payGlobalRecalls: ReadSpec = {
  id: 'pay.global-recalls',
  title: 'Global sends their senders asked back',
  note: 'Oldest request first, refunded sends left out. The 50 oldest. A request moves nothing: the receiving bank decides, and a return is recorded and refunded by two different people.',
  module: 'bank',
  plainName: 'the global send recall requests',
  procedure: 'global.ops.recalls',
  input: { limit: 50 },
  shape: 'list',
  idKey: 'id',
  page: 50,
  columns: [
    time('recallRequestedAt', 'Asked back at'),
    text('recallReason', 'What the sender wrote'),
    amount('amount', 'Amount'),
    text('assetId', 'Asset'),
    text('status', 'Status'),
    text('returnRef', 'Rail return reference', { nullable: true }),
    time('createdAt', 'Sent', { detail: true }),
    text('userId', 'Sender (account id)', { detail: true }),
    text('recipientId', 'Recipient (id)', { detail: true }),
    text('providerRef', 'Provider reference', { nullable: true, detail: true }),
    text('ledgerTxId', 'Ledger transaction', { nullable: true, detail: true }),
    text('id', 'Send id', { detail: true }),
  ],
  emptyText: 'No sender has an open request to get a global send back.',
  forbiddenText: FORBID_PAY_READ,
  refusals: BILLS_REFUSALS,
};

const paySections: readonly DeskSection[] = [
  {
    id: 'failures',
    title: 'Rejected transfers and lookup',
    intro:
      'The standing-order executions svc-bank rejected, then any one transfer by id. Opening a record reads it from svc-bank on request.',
    reads: [payFailedStanding],
    unavailable: [
      un(
        'pay.pending-transfers',
        'List of pending standing-order executions and reserved one-off sends',
        'The counts under Transfer health give how many are pending and the age of the oldest, but svc-bank has no read that lists them, so a stuck transfer cannot be picked from a list. It can be read by id below. Those figures also count only rows created or attempted inside the window: a transfer older than the window that is still pending is in no figure at all, and the list that is needed must not be limited by a window (or must allow a long one).',
        41,
      ),
    ],
    disabledActions: [],
    sectionAction: 'pay.transfer.lookup',
    links: [],
  },
  {
    id: 'bills',
    title: 'Bill payments',
    intro: 'Bill payments across every payer, from svc-bank’s operator reads. Totals are all-time; there is no window on these.',
    reads: [payBillsFailed, payBillsSummary, payBillsVolumes],
    unavailable: [
      un(
        'pay.bills-returned',
        'List of returned bill payments, and a windowed bill summary',
        'The failed list holds status failed only, and the summary has no window, so a returned payment can be counted (under Transfer health, over the last 24 hours and 7 days) but not listed, and the volumes cannot be limited to a period.',
        42,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'global',
    title: 'Global sends',
    intro: 'Cross-border sends across every sender, from svc-bank’s operator reads. Totals are all-time; there is no window on these.',
    reads: [payGlobalFailed, payGlobalRecalls, payGlobalSummary, payGlobalVolumes],
    unavailable: [
      un(
        'pay.global-health',
        'Global sends in the transfer-health windows',
        'The transfer-health read covers standing orders, one-off sends and bills but not global sends, so there is no 24-hour or 7-day count, failure rate or oldest-pending age for them. The failed list also has no page marker, so only the newest 50 failures can be reached.',
        43,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'health',
    title: 'Transfer health',
    intro:
      'Counts of what personal transfers did in a window, from svc-bank’s own tables: standing orders, one-off sends and bill payments. Two windows are read, 24 hours and 7 days, ending when this console reads. Counts only; svc-bank gives no money total for these. An age is the oldest still-pending row among those created in the window: a transfer older than the window that is still pending is in no figure here (back-end need 41).',
    reads: [health24.standing, health24.oneOff, health24.bills, payP2pPointer, health7d.standing, health7d.oneOff, health7d.bills],
    unavailable: [
      un(
        'pay.oneoff-failures',
        'Failed one-off sends',
        'svc-bank stores a one-off send as reserved or posted only. A refused send deletes its reservation, so there is no failed count, no failure rate and no list of failed one-off sends to read.',
        40,
      ),
    ],
    disabledActions: [],
    links: [{ href: '/p2p-ops', label: 'P2P ops', why: 'P2P trades, disputes and the 24-hour dispute rate are counted there, not here.' }],
  },
  {
    id: 'actions',
    title: 'Actions',
    intro:
      'svc-bank has no operator action on a personal transfer, so none is offered here. Each is shown switched off with the reason. Jobs that run on a schedule are on Operator tools.',
    reads: [],
    unavailable: [],
    disabledActions: [
      {
        id: 'pay.standing-cancel',
        label: 'Cancel, pause or resume a standing order',
        reason:
          'svc-bank only lets the owner of a standing order cancel, pause or resume it, and refuses anyone else. It has no operator version, so a founder cannot do it for a customer.',
      },
      {
        id: 'pay.execution-retry',
        label: 'Retry one rejected standing-order execution',
        reason:
          'svc-bank has no procedure that re-runs a chosen execution. The only related control is the sweep of every due schedule, which is a treasury job on Operator tools and cannot be aimed at one failure.',
      },
      {
        id: 'pay.oneoff-reverse',
        label: 'Reverse or release a one-off send',
        reason:
          'svc-bank has no operator procedure to reverse a posted send or release a reservation, and a reversal moves money, so it would need a two-founder approval at the service that does not exist.',
      },
      {
        id: 'pay.bill-refund',
        label: 'Retry, refund or return a bill payment',
        reason:
          'svc-bank has no operator procedure that acts on one bill payment or one global send. Its operator reads for them are a summary, a failed list and one record; the only writer is the due-schedule job for recurring bills, which runs as a service job and cannot be aimed at one payment.',
      },
    ],
    links: [
      {
        href: '/tools',
        label: 'Operator tools: run due standing transfers',
        why: 'The sweep of every due standing order (bank.ops.runDueTransfers) runs as a treasury job there, with its own form.',
      },
      {
        href: '/accounts',
        label: 'Account controls',
        why: 'Restrict or restore one person’s account, with a reason, if a transfer pattern needs it.',
      },
    ],
  },
];

// ─── P2P ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_P2P_MOD =
  'svc-p2p did not accept your founder session for this read. Disputes are for moderators: your account must be on P2P_MODERATOR_USER_IDS or hold admin:compliance.';
const FORBID_P2P_COMPLIANCE = 'svc-p2p did not accept your founder session for this read (it needs admin:compliance).';

type OpsOfferStatus = 'active' | 'paused' | 'closed';
type OpsTradeStatus = 'created' | 'escrowed' | 'fiat_sent' | 'released' | 'cancelled' | 'disputed';

function p2pOffers(status: OpsOfferStatus, title: string, note: string): ReadSpec {
  return {
    id: `p2p.offers-${status}`,
    title,
    note: `${note} The 50 newest; the page may be full, so this is not a total (the counts above are).`,
    module: 'p2p',
    plainName: `${title.toLowerCase()}`,
    procedure: 'ops.offers',
    input: { status, limit: 50 },
    shape: 'list',
    rowsKey: 'offers',
    idKey: 'id',
    page: 50,
    columns: [
      text('side', 'Side'),
      text('asset', 'Asset'),
      text('fiatCurrency', 'Currency'),
      amount('price', 'Price'),
      amount('remainingAmount', 'Left to trade'),
      amount('minAmount', 'Minimum'),
      amount('maxAmount', 'Maximum'),
      time('createdAt', 'Created'),
      amount('totalAmount', 'Total offered', { detail: true }),
      list('methodIds', 'Payment methods (ids)', { detail: true }),
      text('makerId', 'Maker (account id)', { detail: true }),
      text('id', 'Offer id', { detail: true }),
    ],
    emptyText: `svc-p2p lists no ${status} offers. That means there are none, not that P2P is healthy.`,
    forbiddenText: FORBID_P2P_COMPLIANCE,
  };
}

function p2pTrades(status: OpsTradeStatus, title: string, note: string): ReadSpec {
  return {
    id: `p2p.trades-${status}`,
    title,
    note: `${note} The 50 newest; the page may be full, so this is not a total (the counts above are).`,
    module: 'p2p',
    plainName: title.toLowerCase(),
    procedure: 'ops.trades',
    input: { status, limit: 50 },
    shape: 'list',
    rowsKey: 'trades',
    idKey: 'id',
    page: 50,
    columns: [
      text('asset', 'Asset'),
      amount('amount', 'Amount'),
      text('fiatCurrency', 'Currency'),
      amount('fiatAmount', 'Fiat amount'),
      amount('price', 'Price'),
      text('method', 'Payment method'),
      text('resolution', 'Outcome', { nullable: true }),
      time('createdAt', 'Created'),
      text('buyerId', 'Buyer (account id)', { detail: true }),
      text('sellerId', 'Seller (account id)', { detail: true }),
      text('makerId', 'Maker (account id)', { detail: true }),
      text('takerId', 'Taker (account id)', { detail: true }),
      int('feeBps', 'Fee (basis points)', { detail: true }),
      text('offerId', 'Offer id', { detail: true }),
      text('status', 'Status', { detail: true }),
      text('id', 'Trade id', { detail: true }),
    ],
    emptyText: `svc-p2p lists no ${status.replace('_', ' ')} trades. That means there are none right now.`,
    forbiddenText: FORBID_P2P_COMPLIANCE,
  };
}

const p2pSections: readonly DeskSection[] = [
  {
    id: 'service',
    title: 'Service and posture',
    intro: 'Whether P2P is up and which of its safeguards are configured.',
    reads: [
      {
        id: 'p2p.health',
        title: 'Service health',
        note: '"Moderation configured" means someone is on the moderator list. svc-p2p cannot tell whether that person is actually watching the queue.',
        module: 'p2p',
        procedure: 'health',
        shape: 'record',
        columns: [
          bool('ok', 'Answering'),
          bool('moderationConfigured', 'Moderators configured'),
          text('moderation.code', 'Moderation status'),
          text('offerLimitsPosture', 'Offer limits'),
          bool('instrumentKmsConfigured', 'Payment details encrypted with a KMS'),
        ],
        emptyText: '',
        forbiddenText: 'svc-p2p did not answer this read.',
      },
      {
        id: 'p2p.fiat',
        title: 'Fiat currencies enabled',
        note: 'Currencies P2P can trade against, from configuration. Not a volume.',
        module: 'p2p',
        procedure: 'fiat.list',
        shape: 'list',
        idKey: 'code',
        columns: [text('code', 'Code'), text('name', 'Name'), text('symbol', 'Symbol'), int('minorUnits', 'Minor units')],
        collapsed: true,
        emptyText: 'No fiat currencies are enabled.',
        forbiddenText: 'svc-p2p did not answer this read.',
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
  {
    id: 'disputes',
    title: 'Disputes',
    intro: 'The moderator queue: open disputes, most overdue first. Open a row for the full case.',
    reads: [
      {
        id: 'p2p.backlog',
        title: 'Dispute backlog',
        note: 'Counts straight from svc-p2p. "Never seen" is open disputes no human has been served yet.',
        module: 'p2p',
        procedure: 'disputes.backlog',
        shape: 'record',
        columns: [
          int('open', 'Open'),
          int('overdue', 'Overdue'),
          int('escalated', 'Escalated'),
          int('neverSeen', 'Never seen by a moderator'),
          bool('moderationConfigured', 'Moderators configured'),
        ],
        emptyText: '',
        forbiddenText: FORBID_P2P_MOD,
      },
      {
        id: 'p2p.disputes',
        title: 'Open disputes',
        note: 'Reading this list does not mark a dispute as seen. The case detail is in the row: reason, who opened it, how it was opened and its escalations.',
        module: 'p2p',
        procedure: 'disputes.list',
        input: { status: 'open', limit: 50 },
        shape: 'list',
        rowsKey: 'disputes',
        idKey: 'tradeId',
        page: 50,
        rowAction: 'p2p.dispute.escalate',
        columns: [
          text('tradeId', 'Trade'),
          bool('overdue', 'Overdue'),
          time('deadlineAt', 'Deadline'),
          time('openedAt', 'Opened'),
          text('openedVia', 'Opened by'),
          int('escalations', 'Escalations'),
          time('escalatedAt', 'Last escalated', { nullable: true }),
          time('lastSeenByModeratorAt', 'Last seen by a moderator', { nullable: true }),
          text('reason', 'Reason given', { detail: true }),
          text('openedBy', 'Opened by (user id)', { detail: true }),
          text('moderatorId', 'Moderator', { detail: true, nullable: true }),
          text('escalatedBy', 'Escalated by (user id)', { detail: true, nullable: true }),
          text('escalationReason', 'Escalation reason', { detail: true, nullable: true }),
          text('status', 'Status', { detail: true }),
          text('id', 'Dispute id', { detail: true }),
        ],
        emptyText: 'svc-p2p returned no open disputes. That means none are open right now.',
        forbiddenText: FORBID_P2P_MOD,
      },
    ],
    unavailable: [],
    disabledActions: [
      {
        id: 'p2p.resolve',
        label: 'Release or refund escrow',
        reason:
          'This moves escrowed money. svc-p2p can now require a second person on a ruling, but ships with that switched off (P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL) and the console cannot tell whether it is on. Until that is decided, a ruling is made by an attributed moderator with the evidence open, not from this page.',
      },
    ],
    links: [],
  },
  {
    id: 'settlements',
    title: 'Late settlements',
    intro: 'Decisions already made whose ledger posting is late or has failed.',
    reads: [
      {
        id: 'p2p.late',
        title: 'Late or failed settlements',
        note: 'Trades resolved but not yet posted to the ledger. Age is in seconds since the decision.',
        module: 'p2p',
        procedure: 'ops.lateSettlements',
        input: { limit: 100 },
        shape: 'list',
        rowsKey: 'trades',
        idKey: 'tradeId',
        page: 100,
        columns: [
          text('tradeId', 'Trade'),
          text('status', 'Status'),
          text('resolution', 'Resolution', { nullable: true }),
          time('resolvedAt', 'Resolved'),
          int('ageSeconds', 'Age (s)'),
          text('lastSettleError', 'Last error', { nullable: true }),
          time('lastSettleErrorAt', 'Last error at', { nullable: true }),
          text('resolutionReason', 'Reason', { nullable: true, detail: true }),
        ],
        emptyText: 'No late settlements. Every resolved trade has posted.',
        forbiddenText: FORBID_P2P_COMPLIANCE,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
  {
    id: 'orders',
    title: 'Offers and trades',
    intro:
      'Every offer and every trade on the platform, newest first: counts by status, the share of trades that became disputes, then the offers and the trades still in flight. Rows name accounts by id only; payment details and chat are never in these reads.',
    reads: [
      {
        id: 'p2p.counts',
        title: 'Counts by status',
        note: 'Offers and trades in each status, counted by svc-p2p over all time. A status with none is a real zero.',
        module: 'p2p',
        plainName: 'P2P counts',
        procedure: 'ops.counts',
        shape: 'record',
        columns: [
          int('offers.active', 'Offers open'),
          int('offers.paused', 'Offers paused'),
          int('offers.closed', 'Offers closed'),
          int('trades.created', 'Trades created'),
          int('trades.escrowed', 'Trades in escrow'),
          int('trades.fiat_sent', 'Trades marked paid'),
          int('trades.released', 'Trades released'),
          int('trades.cancelled', 'Trades cancelled'),
          int('trades.disputed', 'Trades disputed'),
        ],
        emptyText: '',
        forbiddenText: FORBID_P2P_COMPLIANCE,
      },
      {
        id: 'p2p.dispute-rate',
        title: 'Disputes against trades, last 24 hours',
        note: 'Disputes opened and trades created in the last 24 hours, and their ratio as svc-p2p states it. With no trade in the window there is no ratio, and none is shown.',
        module: 'p2p',
        plainName: 'the dispute rate',
        procedure: 'ops.disputeRate24h',
        shape: 'record',
        columns: [
          int('disputesOpened24h', 'Disputes opened'),
          int('tradesCreated24h', 'Trades created'),
          text('rate', 'Disputes out of trades', { nullable: true }),
        ],
        emptyText: '',
        forbiddenText: FORBID_P2P_COMPLIANCE,
      },
      p2pOffers('active', 'Open offers', 'Offers that can be taken now.'),
      p2pOffers('paused', 'Paused offers', 'Offers their maker has paused.'),
      p2pTrades('disputed', 'Disputed trades', 'Trades in dispute. Their cases are under Disputes above.'),
      p2pTrades('escrowed', 'Trades in escrow', 'The seller’s coins are locked and the buyer has not yet marked paid.'),
      p2pTrades('fiat_sent', 'Trades marked paid', 'The buyer says they paid; the seller has not released yet.'),
      p2pTrades('released', 'Released trades', 'Completed trades, newest first.'),
    ],
    unavailable: [
      un(
        'p2p.volume',
        'Traded volume, cancel rate and release time over a period',
        'svc-p2p counts trades by status and the dispute share of the last 24 hours, but sums no volume and gives no cancel rate or release time over a period.',
        35,
      ),
    ],
    disabledActions: [],
    links: [],
  },
];

// ─── Academy ─────────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_ACADEMY_READ = 'svc-academy did not accept your founder session for this read (it needs academy:read).';
const FORBID_ACADEMY_ADMIN = 'svc-academy did not accept your founder session for this read (it needs admin:read).';

const academySections: readonly DeskSection[] = [
  {
    id: 'catalogue',
    title: 'Content and catalogue',
    intro: 'How much teaching content exists, how deep it is, and how it got there.',
    reads: [
      {
        id: 'academy.health',
        title: 'Service health',
        note: 'Whether svc-academy answers.',
        module: 'academy',
        procedure: 'health',
        shape: 'record',
        columns: [bool('ok', 'Answering'), text('service', 'Service')],
        emptyText: '',
        forbiddenText: 'svc-academy did not answer this read.',
      },
      {
        id: 'academy.courses',
        title: 'Courses',
        note: 'Courses staff created on the course desk, counted by state. The four shipped courses (the curriculum paths) are counted under Curriculum inventory, not here.',
        module: 'academy',
        procedure: 'admin.courses',
        input: { limit: 1 },
        shape: 'record',
        columns: [
          int('counts.draft', 'Drafts'),
          int('counts.published', 'Published'),
          int('counts.concluded', 'Concluded'),
          int('counts.archived', 'Archived'),
          int('counts.deleted', 'Deleted'),
        ],
        emptyText: '',
        forbiddenText: FORBID_ACADEMY_ADMIN,
      },
      {
        id: 'academy.inventory',
        title: 'Curriculum inventory',
        note: 'Counts of the content the service ships, against the promise made on the product (the "title target").',
        module: 'academy',
        procedure: 'curriculumInventory',
        shape: 'record',
        columns: [
          text('contentSource', 'Content source'),
          int('spine.total', 'Items in total'),
          int('spine.playbooks', 'Playbooks'),
          int('spine.workbooks', 'Workbooks'),
          int('spine.lessons', 'Lessons'),
          int('titleTarget.playbooks', 'Playbooks promised'),
          int('titleTarget.workbooks', 'Workbooks promised'),
          bool('titlePromiseMet', 'Promise met'),
          int('residualPlaybooks', 'Playbooks still to import'),
          int('residualWorkbooks', 'Workbooks still to import'),
        ],
        emptyText: '',
        forbiddenText: FORBID_ACADEMY_READ,
      },
      {
        id: 'academy.depth',
        title: 'Content depth',
        note: 'How many items are long enough to be worth reading. Thin items are named, not hidden.',
        module: 'academy',
        procedure: 'curriculumDepth',
        shape: 'record',
        columns: [
          int('total', 'Items'),
          int('deep', 'Deep'),
          int('thin', 'Thin'),
          int('minBodyChars', 'Minimum length (characters)'),
          int('shortestBodyChars', 'Shortest item (characters)'),
          int('totalBodyChars', 'All content (characters)'),
          bool('allDeep', 'All deep'),
          list('thinSlugs', 'Thin items'),
        ],
        emptyText: '',
        forbiddenText: FORBID_ACADEMY_READ,
      },
      {
        id: 'academy.import',
        title: 'Import status',
        note: 'Where the content import stands, and whether the substance bar is met.',
        module: 'academy',
        procedure: 'curriculumImportStatus',
        shape: 'record',
        columns: [
          text('contentSource', 'Content source'),
          bool('titlePromiseMet', 'Promise met'),
          bool('stage2CatalogExpanded', 'Catalogue expanded'),
          bool('stage3Polish.ready', 'Polish ready'),
          bool('substanceBarMet', 'Substance bar met'),
          list('theaterSlugs', 'Items that read as filler'),
        ],
        emptyText: '',
        forbiddenText: FORBID_ACADEMY_READ,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [
      {
        href: '/academy-ops/catalogue/courses',
        label: 'Courses',
        why: 'Create a course, set its price and publish it. Every course staff created is listed there.',
      },
      {
        href: '/academy-ops/catalogue/featured',
        label: 'Learn hub',
        why: 'The featured article as staff chose it, and the topic list courses are filed under.',
      },
    ],
  },
  {
    id: 'certificates',
    title: 'Certificates and grants',
    intro: 'Which certificates exist and whether granting one pays XP.',
    reads: [
      {
        id: 'academy.cert-defs',
        title: 'Certificate definitions',
        note: 'What each certificate requires. Definitions, not grants.',
        module: 'academy',
        procedure: 'certDefinitions',
        shape: 'list',
        idKey: 'id',
        columns: [text('id', 'Certificate'), text('title', 'Title'), list('requiredItemSlugs', 'Required items', { detail: true })],
        emptyText: 'svc-academy defines no certificates.',
        forbiddenText: FORBID_ACADEMY_READ,
      },
      {
        id: 'academy.cert-xp',
        title: 'XP on grant',
        note: 'Whether granting a certificate publishes XP to identity. "Off" is a deployment fact, not a ranking disagreement.',
        module: 'academy',
        procedure: 'certXpPlane',
        shape: 'record',
        columns: [bool('emitEnabled', 'XP publishing on'), text('publisherId', 'Publisher'), text('rankWriter', 'Rank written by')],
        emptyText: '',
        forbiddenText: FORBID_ACADEMY_READ,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [{ href: '/academy-ops/grants', label: 'Grants', why: 'Who was granted which certificate, and when.' }],
  },
  {
    id: 'programmes',
    title: 'Seasons and paper trading',
    intro: 'Competitive seasons and the simulated trading used for practice.',
    reads: [
      {
        id: 'academy.seasons',
        title: 'Seasons',
        note: 'Season windows and status, as the service lists them.',
        module: 'academy',
        procedure: 'seasons',
        input: { limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
        columns: [
          text('title', 'Season'),
          text('status', 'Status'),
          time('startsAt', 'Starts'),
          time('endsAt', 'Ends', { nullable: true }),
          text('slug', 'Slug', { detail: true }),
          text('rulesSummary', 'Rules', { detail: true }),
          text('id', 'Season id', { detail: true }),
        ],
        emptyText: 'svc-academy lists no seasons.',
        forbiddenText: FORBID_ACADEMY_READ,
      },
      {
        id: 'academy.paper',
        title: 'Paper trading',
        note: 'Practice trading is simulated and must never read as real money.',
        module: 'academy',
        procedure: 'paperOpsStatus',
        shape: 'record',
        columns: [
          bool('enabled', 'Enabled'),
          bool('simulated', 'Simulated'),
          bool('realMoney', 'Real money'),
          text('venue', 'Venue'),
          bool('liveTradeUnaffected', 'Live trading unaffected'),
        ],
        emptyText: '',
        forbiddenText: FORBID_ACADEMY_READ,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
  {
    id: 'ambassadors',
    title: 'Ambassadors and residencies',
    intro:
      'The people who carry the Academy role, and applications waiting for a decision. Appointing an ambassador and deciding a residency are two-founder requests.',
    reads: [
      {
        id: 'academy.ambassadors',
        title: 'Ambassadors',
        note: 'Every ambassador and whether they are active or frozen. Freezing and lifting a freeze are two-founder requests.',
        module: 'academy',
        procedure: 'ambassadors',
        input: { limit: 100 },
        shape: 'list',
        idKey: 'userId',
        page: 100,
        rowAction: 'academy.ambassador',
        columns: [
          text('userId', 'Ambassador'),
          text('status', 'Status'),
          time('appointedAt', 'Appointed'),
          time('frozenAt', 'Frozen at', { nullable: true }),
          text('freezeReason', 'Freeze reason', { nullable: true, detail: true }),
          text('appointedBy', 'Appointed by', { detail: true }),
          text('frozenBy', 'Frozen by', { nullable: true, detail: true }),
        ],
        emptyText: 'svc-academy lists no ambassadors.',
        forbiddenText: FORBID_ACADEMY_ADMIN,
      },
      {
        id: 'academy.residencies',
        title: 'Residency applications awaiting a decision',
        note: 'Open applications, as svc-academy lists them. Accept or reject each as a two-founder request.',
        module: 'academy',
        procedure: 'openResidencies',
        input: { limit: 100 },
        shape: 'list',
        idKey: 'id',
        page: 100,
        rowAction: 'academy.residency',
        columns: [
          text('userId', 'Applicant'),
          text('cohortSlug', 'Cohort'),
          text('status', 'Status'),
          time('appliedAt', 'Applied'),
          text('statement', 'Statement', { detail: true }),
          text('id', 'Application id', { detail: true }),
        ],
        emptyText: 'No residency applications are waiting.',
        forbiddenText: FORBID_ACADEMY_ADMIN,
      },
    ],
    unavailable: [],
    disabledActions: [],
    sectionAction: 'academy.ambassador.appoint',
    links: [],
  },
  {
    id: 'grants',
    title: 'Grants and enrolments',
    intro: 'Who was granted a certificate, and how many people enrolled in each course, as svc-academy records them.',
    reads: [
      {
        id: 'academy.grant-audit',
        title: 'Certificate grants',
        note: 'Newest first, fifty a page. A grant is the learner’s own record: this list reads it, nothing here grants or takes one away.',
        module: 'academy',
        procedure: 'admin.grantAudit',
        input: { limit: 50 },
        shape: 'list',
        rowsKey: 'items',
        idKey: 'reference',
        page: 50,
        cursorKey: 'nextCursor',
        columns: [
          text('accountId', 'Learner'),
          text('certificateId', 'Certificate'),
          time('grantedAt', 'Granted'),
          text('status', 'Status'),
          text('reference', 'Reference', { detail: true }),
        ],
        emptyText: 'svc-academy records no certificate grants.',
        forbiddenText: FORBID_ACADEMY_ADMIN,
      },
      {
        id: 'academy.enrolments',
        title: 'Enrolments, last 30 UTC days',
        note: 'New enrolments per course in the window, as svc-academy counts them.',
        module: 'academy',
        procedure: 'admin.enrolments',
        windowDays: 30,
        windowInUtcDays: true,
        shape: 'list',
        rowsKey: 'paths',
        idKey: 'pathSlug',
        columns: [text('pathSlug', 'Course'), int('count', 'Enrolments')],
        emptyText: 'Nobody enrolled in a course in this window.',
        forbiddenText: FORBID_ACADEMY_ADMIN,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
];

/** The Academy desk's sections, each also on a page of its own (IA-SPEC 2.12: catalogue, certificates, programmes, ambassadors, grants). */
export const ACADEMY_PAGES: readonly DeskPage[] = [
  { id: 'catalogue', title: 'Catalogue', href: '/academy-ops/catalogue' },
  { id: 'certificates', title: 'Certificates', href: '/academy-ops/certificates' },
  { id: 'programmes', title: 'Programmes', href: '/academy-ops/programmes' },
  { id: 'ambassadors', title: 'Ambassadors', href: '/academy-ops/ambassadors' },
  { id: 'grants', title: 'Grants', href: '/academy-ops/grants' },
];

// ─── More ────────────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_TOKEN_READ =
  'Your console session does not have token read permission: svc-token did not accept your founder session for this read (it needs token:read).';
const FORBID_MARKET_OPS = 'svc-market did not accept your founder session for this read (it needs market:ops).';
const FORBID_MINING = 'svc-mining-pool did not accept your founder session for this read (it needs admin:read).';
const FORBID_MINING_TERMS =
  'svc-mining-pool did not accept your founder session for this read (the pool terms need only a signed-in session, so this is a sign-in or connection problem, not a missing permission).';

const moreSections: readonly DeskSection[] = [
  {
    id: 'agents',
    title: 'Agents',
    intro: 'The AI agent service: which tasks it can run and at what price.',
    reads: [
      {
        id: 'agents.routes',
        title: 'Task routes and prices',
        note: 'Each task the gateway serves, its output ceiling and its metered price per million tokens. A route table, not usage.',
        module: 'agents',
        procedure: 'routes.list',
        shape: 'list',
        idKey: 'task',
        columns: [
          text('task', 'Task'),
          text('capability', 'Capability'),
          int('maxOutputTokens', 'Output ceiling (tokens)'),
          amount('inputPerMillion', 'Input per million'),
          amount('outputPerMillion', 'Output per million'),
          text('assetId', 'Billed in'),
        ],
        emptyText: 'svc-agents serves no task routes.',
        forbiddenText: 'svc-agents did not accept your founder session for this read (it needs agents:read).',
      },
    ],
    unavailable: [
      un(
        'agents.sessions',
        'Agent sessions: open, actions taken, spend',
        'session.open, close and log are the user’s own (agents:execute). There is no operator list of sessions.',
        21,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'quant',
    title: 'Quant',
    intro: 'Strategy studio, backtests and the sandbox.',
    reads: [
      {
        id: 'quant.health',
        title: 'Service health',
        note: 'Whether svc-quant answers. Nothing about runs.',
        module: 'quant',
        procedure: 'health',
        shape: 'record',
        columns: [bool('ok', 'Answering'), text('service', 'Service')],
        emptyText: '',
        forbiddenText: 'svc-quant did not answer this read.',
      },
      {
        id: 'quant.strategies',
        title: 'Saved strategies',
        note: 'Every saved strategy across accounts, newest as the service orders them: name and labels only. The code and blocks are never in this read. Everything here is paper or a historical simulation; the two flags below are pinned, so a strategy claiming to be live is refused as unreadable. The service also limits this read by jurisdiction, so a console with no country may be refused.',
        module: 'quant',
        plainName: 'saved strategies',
        procedure: 'studio.operatorList',
        input: { limit: 50 },
        shape: 'list',
        rowsKey: 'strategies',
        idKey: 'id',
        page: 50,
        columns: [
          text('name', 'Strategy'),
          text('environment', 'Environment'),
          text('kind', 'Kind'),
          text('claimLabel', 'Label it carries'),
          bool('simulated', 'Simulated', { mustBe: true }),
          bool('live', 'Live trading', { mustBe: false }),
          text('accountId', 'Account id', { nullable: true, detail: true }),
          text('id', 'Strategy id', { detail: true }),
        ],
        emptyText: 'svc-quant lists no saved strategy. That means nobody has saved one, not that Quant is healthy.',
        forbiddenText:
          'svc-quant did not accept your founder session for this read (it needs an admin permission such as admin:read, and it is limited by jurisdiction).',
      },
    ],
    unavailable: [
      un(
        'quant.runs',
        'Backtest and sandbox runs: counts, durations, failures',
        'svc-quant lists saved strategies to an operator (above) but keeps backtest and sandbox runs per user, with no read of run counts, durations or failures.',
        22,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'mining',
    title: 'Mining pool',
    intro:
      'Pool terms, workers, shares and payout windows, as svc-mining-pool reports them. No window is paid today: the payout job refuses until emission is published, so a window showing "open" is expected.',
    reads: [
      {
        id: 'mining.terms',
        title: 'Pool terms',
        note: 'The fee and window size from the pool’s configuration. There is no default: an unset value is blank with its reason, not zero.',
        module: 'mining',
        plainName: 'mining pool terms',
        procedure: 'terms',
        shape: 'record',
        columns: [
          bps('feeBps', 'Pool fee', { nullable: true }),
          text('feeReason', 'Why no fee', { nullable: true }),
          int('windowSize', 'Window size', { nullable: true }),
          text('windowSizeReason', 'Why no window size', { nullable: true }),
        ],
        emptyText: '',
        forbiddenText: FORBID_MINING_TERMS,
      },
      {
        id: 'mining.windows',
        title: 'Payout windows',
        note: 'Every window, newest first: its reward and fee as stored on the window, how many shares and how much weight it holds, and when it was paid. A blank reward or fee is blank, never zero.',
        module: 'mining',
        plainName: 'mining windows',
        procedure: 'ops.windows',
        shape: 'list',
        rowsKey: 'windows',
        idKey: 'windowId',
        columns: [
          text('windowId', 'Window'),
          text('assetId', 'Asset'),
          text('status', 'Status'),
          amount('reward', 'Reward', { nullable: true }),
          bps('feeBps', 'Fee', { nullable: true }),
          int('shareCount', 'Shares'),
          amount('totalWeight', 'Total weight', { nullable: true }),
          time('paidAt', 'Paid', { nullable: true }),
        ],
        emptyText: 'svc-mining-pool has opened no window.',
        forbiddenText: FORBID_MINING,
      },
      {
        id: 'mining.shares',
        title: 'Shares by window',
        note: 'Shares accepted and refused in each window, and the accepted weight. Refusals are counted only where the miner could be identified.',
        module: 'mining',
        plainName: 'mining shares',
        procedure: 'ops.shares',
        sendEmptyInput: true,
        shape: 'list',
        rowsKey: 'windows',
        idKey: 'windowId',
        columns: [
          text('windowId', 'Window'),
          int('acceptedCount', 'Accepted'),
          int('rejectedCount', 'Refused'),
          amount('acceptedWeight', 'Accepted weight', { nullable: true }),
        ],
        emptyText: 'svc-mining-pool has recorded no share in any window.',
        forbiddenText: FORBID_MINING,
      },
      {
        id: 'mining.workers',
        title: 'Workers',
        note: 'Registered workers across accounts, newest first. Registration is refused because no write permission is chosen for it, so this list is expected to be empty.',
        module: 'mining',
        plainName: 'mining workers',
        procedure: 'ops.workers',
        input: { limit: 50 },
        shape: 'list',
        rowsKey: 'workers',
        idKey: 'id',
        page: 50,
        columns: [
          text('name', 'Worker'),
          time('createdAt', 'Registered'),
          text('userId', 'Account id', { detail: true }),
          text('id', 'Worker id', { detail: true }),
        ],
        emptyText: 'svc-mining-pool has no registered worker. Registration is refused until a write permission is chosen.',
        forbiddenText: FORBID_MINING,
      },
    ],
    unavailable: [
      un(
        'mining.payouts',
        'Payouts made and hashrate of the pool',
        'No window is marked paid because the payout job refuses until emission is published, and the operator reads give no hashrate (that is per account). Nothing here is estimated.',
        38,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'launch',
    title: 'Launch and issuers',
    intro: 'Token launches and who issued them.',
    reads: [],
    unavailable: [
      un(
        'launch.predict',
        'Predict markets',
        'Predict stays on Protocol. The P1 GO is recorded, but no INTACORE or svc-predict service runs on this stack, and whether they run is an owner decision. Nothing here reads a chain.',
        null,
      ),
    ],
    disabledActions: [],
    links: [
      {
        href: '/launch',
        label: 'Launch issuers',
        why: 'svc-token keeps the issuers and every launch, drafts included: review an issuer, save a draft and move a launch, each with two founders.',
      },
    ],
  },
  {
    id: 'market',
    title: 'Market: vendors and listings',
    intro: 'Vendor applications, who is listed, and what is on sale.',
    reads: [
      {
        id: 'market.applications',
        title: 'Vendor applications awaiting a decision',
        note: 'Applied and not yet decided, oldest first. Approve, reject or suspend each as a two-founder request.',
        module: 'market',
        procedure: 'listApplications',
        input: { status: 'applied', limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
        rowAction: 'market.vendor.vet',
        columns: [
          text('displayName', 'Vendor'),
          text('status', 'Status'),
          time('createdAt', 'Applied'),
          text('description', 'Description', { detail: true }),
          text('userId', 'User id', { detail: true }),
          text('id', 'Vendor id', { detail: true }),
        ],
        emptyText: 'No vendor applications are waiting.',
        forbiddenText: FORBID_MARKET_OPS,
      },
      {
        id: 'market.approved',
        title: 'Approved vendors',
        note: 'Vendors currently approved. Suspend one here if it must stop selling.',
        module: 'market',
        procedure: 'listApplications',
        input: { status: 'approved', limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
        rowAction: 'market.vendor.vet',
        columns: [
          text('displayName', 'Vendor'),
          text('status', 'Status'),
          time('updatedAt', 'Decided'),
          text('description', 'Description', { detail: true }),
          text('userId', 'User id', { detail: true }),
          text('id', 'Vendor id', { detail: true }),
        ],
        emptyText: 'No vendors are approved.',
        forbiddenText: FORBID_MARKET_OPS,
      },
      {
        id: 'market.suspended',
        title: 'Suspended vendors',
        note: 'Vendors taken out of the market. A suspended vendor can be approved again.',
        module: 'market',
        procedure: 'listApplications',
        input: { status: 'suspended', limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
        rowAction: 'market.vendor.vet',
        columns: [
          text('displayName', 'Vendor'),
          text('status', 'Status'),
          time('updatedAt', 'Suspended'),
          text('description', 'Description', { detail: true }),
          text('userId', 'User id', { detail: true }),
          text('id', 'Vendor id', { detail: true }),
        ],
        emptyText: 'No vendors are suspended.',
        forbiddenText: FORBID_MARKET_OPS,
      },
      {
        id: 'market.listings',
        title: 'Public listings',
        note: 'What a shopper can see today. svc-market refuses to publish a listing while the house commission is blank (see Commerce programme on this desk), so a blank rate also means an empty list.',
        module: 'market',
        procedure: 'listings',
        input: { limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
        rowAction: 'market.listing.takedown',
        columns: [
          text('title', 'Listing'),
          text('offerType', 'Type'),
          amount('price', 'Price'),
          text('assetId', 'Asset'),
          text('status', 'Status'),
          int('periodSeconds', 'Period (s)', { nullable: true }),
          time('createdAt', 'Created'),
          text('description', 'Description', { detail: true }),
          text('vendorId', 'Vendor id', { detail: true }),
          text('id', 'Listing id', { detail: true }),
        ],
        emptyText:
          'No listings are public. If Commerce programme below says Configured yes, no vendor has published a listing; if it says no, svc-market refuses every listing until the rate is set.',
        forbiddenText: 'svc-market did not answer this read.',
      },
      {
        id: 'market.sales',
        title: 'Sales by vendor, last 30 days',
        note: 'Settled volume, settled count and the house commission for each vendor and asset, for sales settled in the window. The commission is each purchase’s own rate at the time, so changing the rate later changes nothing here. Refused purchases are not in the volume. The 50 first rows; a full page is not a total.',
        module: 'market',
        plainName: 'market sales',
        procedure: 'ops.sales',
        input: { limit: 50 },
        windowDays: 30,
        shape: 'list',
        rowsKey: 'rows',
        anonymousRows: true,
        page: 50,
        columns: [
          text('vendorId', 'Vendor id'),
          text('assetId', 'Asset'),
          amount('settledVolume', 'Settled volume'),
          text('settledCount', 'Settled purchases'),
          amount('commission', 'House commission'),
        ],
        emptyText: 'svc-market recorded no settled sale in this window. That means none settled, not that the market is healthy.',
        forbiddenText: FORBID_MARKET_OPS,
      },
      {
        id: 'market.sales-counts',
        title: 'Purchases not settled, last 30 days',
        note: 'Purchases that were refused and purchases still pending in the same window, counted over the whole window and not just the page above.',
        module: 'market',
        plainName: 'market purchase counts',
        procedure: 'ops.sales',
        input: { limit: 50 },
        windowDays: 30,
        shape: 'record',
        columns: [text('refusedCount', 'Refused'), text('pendingCount', 'Pending')],
        emptyText: '',
        forbiddenText: FORBID_MARKET_OPS,
      },
      {
        id: 'market.commerce',
        title: 'Commerce programme',
        note: 'The house commission. Blank means listings and purchases refuse.',
        module: 'market',
        procedure: 'commerceProgramme',
        shape: 'record',
        columns: [bps('commissionBps', 'House commission', { nullable: true }), bool('commissionConfigured', 'Configured')],
        emptyText: '',
        forbiddenText: 'svc-market did not answer this read.',
      },
    ],
    unavailable: [
      un(
        'market.subscriptions',
        'Subscriptions and refunds per vendor',
        'Subscribing and recurring purchases refuse by design, and svc-market has no refund path, so there is nothing to read.',
        null,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'token',
    title: 'Token',
    intro:
      'Governance proposals, the burned supply and the next emission epoch, as svc-token reports them. Reads only: nothing here mints, burns, stakes or votes.',
    reads: [
      {
        id: 'token.proposals',
        title: 'Governance proposals',
        note: 'Proposals as svc-token lists them, with their window. The free-form proposal body and each proposal’s vote tally are separate reads (getProposal, one proposal at a time) that this desk does not make, so neither is shown.',
        module: 'token',
        plainName: 'governance proposals',
        procedure: 'listProposals',
        input: { limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
        columns: [
          text('kind', 'Kind'),
          text('status', 'Status'),
          time('opensAt', 'Opens'),
          time('closesAt', 'Closes'),
          time('createdAt', 'Created'),
          text('id', 'Proposal id', { detail: true }),
        ],
        emptyText: 'svc-token lists no proposals. That means none exist, not that governance is healthy.',
        forbiddenText: FORBID_TOKEN_READ,
      },
      {
        id: 'token.burned',
        title: 'Burned supply',
        note: 'Tokens burned so far, as a decimal exactly as svc-token formats it. A burn total, not the circulating supply.',
        module: 'token',
        plainName: 'burned supply',
        procedure: 'burnedSupply',
        shape: 'record',
        columns: [amount('burned', 'Burned')],
        emptyText: '',
        forbiddenText: FORBID_TOKEN_READ,
      },
      {
        id: 'token.epoch',
        title: 'Next emission epoch',
        note: 'The epoch number the next emission would use. A read: it mints nothing, and minting stays behind its own switch in svc-token.',
        module: 'token',
        plainName: 'the next emission epoch',
        procedure: 'nextEmissionEpoch',
        shape: 'record',
        columns: [int('epoch', 'Next epoch')],
        emptyText: '',
        forbiddenText: FORBID_TOKEN_READ,
      },
    ],
    unavailable: [
      un(
        'token.supply',
        'Total and circulating supply, total staked, number of stakers',
        'svc-token answers stakes only for the signed-in holder (listStakes, stakeOf) and has no supply read beyond the burn total. There is no operator aggregate.',
        29,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'campaigns',
    title: 'Campaigns',
    intro: 'Customer campaigns and who took part.',
    reads: [],
    unavailable: [
      un(
        'campaigns.participation',
        'Campaign participation',
        'svc-campaigns has no operator read of who joined a campaign (its participations are read per customer). The campaigns desk shows every campaign, its state and its budget.',
        26,
      ),
    ],
    disabledActions: [],
    links: [
      {
        href: '/more-ops/campaigns',
        label: 'Campaigns desk and builder',
        why: 'Every campaign in svc-campaigns, the builder, the two-founder approval and the calendar.',
      },
      {
        href: '/more-ops/campaigns/waves',
        label: 'Waitlist waves',
        why: 'The waitlist queue in svc-identity and the two-founder release of the next wave.',
      },
      { href: '/crm', label: 'CRM outreach campaigns', why: 'Enquiries, sources and outreach campaigns that do exist.' },
    ],
  },
];

// ─── Protocol ────────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_PROTOCOL = 'svc-protocol did not accept your founder session for this read. Nothing is shown rather than a guess.';
const FORBID_INDEXER = 'svc-indexer did not accept your founder session for this read. Nothing is shown rather than a guess.';
const FORBID_DEX = 'svc-dex did not accept your founder session for this read. Nothing is shown rather than a guess.';

const protocolSections: readonly DeskSection[] = [
  {
    id: 'chain',
    title: 'Chain status',
    intro:
      'What svc-protocol finds when it asks the chain it is configured for. "Reachable" and "deployed" are read from the chain; "configured" is only an address in settings.',
    reads: [
      {
        id: 'protocol.chain',
        title: 'Chain status',
        note: 'A probe, not a heartbeat: it says whether a chain answered and whether the contracts hold code. The chain id below decides the network label in the blockers; it is never assumed to be INTACHAIN.',
        module: 'protocol',
        plainName: 'chain status',
        procedure: 'chainStatus',
        shape: 'record',
        columns: [
          bool('reachable', 'A chain answered'),
          int('configuredChainId', 'Configured chain id'),
          int('observedChainId', 'Chain id the node reported', { nullable: true }),
          text('blockNumber', 'Latest block', { nullable: true }),
          bool('suiteConfigured', 'Smart-account contracts configured'),
          bool('suiteDeployed', 'Smart-account contracts deployed (read from the chain)'),
          bool('tokenFactoryConfigured', 'Token factory configured'),
          bool('tokenFactoryDeployed', 'Token factory deployed (read from the chain)'),
          bool('usable', 'Smart accounts usable'),
          bool('launchUsable', 'Token launch usable'),
          text('refusalCode', 'Refusal code', { nullable: true }),
          text('reason', 'Reason', { nullable: true }),
        ],
        emptyText: '',
        forbiddenText: FORBID_PROTOCOL,
      },
    ],
    unavailable: [
      un(
        'protocol.validators',
        'Blocks, validators and staking for INTACHAIN',
        'No INTACHAIN chain service or validator set exists yet, so there is nothing to read. svc-protocol talks to a configured test chain and says nothing about validators.',
        30,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'audit',
    title: 'Audit status',
    intro: 'Where the smart-account audit stands, as svc-protocol states it. Passing tests is not an audit.',
    reads: [
      {
        id: 'protocol.audit',
        title: 'Audit status',
        note: 'The committed internal review package. "Audited by an outside firm" must be no: a service answer that says otherwise is refused as unreadable instead of shown.',
        module: 'protocol',
        plainName: 'audit status',
        procedure: 'auditStatus',
        shape: 'record',
        columns: [
          text('id', 'Package'),
          text('kind', 'Kind', { mustBe: 'internal' }),
          text('packagePath', 'Path'),
          text('artifactHash', 'Artifact hash'),
          text('signedBy', 'Signed by', { nullable: true }),
          time('signedAt', 'Signed at', { nullable: true }),
          bool('audited', 'Audited by an outside firm', { mustBe: false }),
        ],
        emptyText: '',
        forbiddenText: FORBID_PROTOCOL,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
  {
    id: 'indexer',
    title: 'Indexer finality',
    intro: 'How far the indexer has read and how much of it is final. Nothing below the finalized height can change; above it, it can.',
    reads: [
      {
        id: 'protocol.indexer',
        title: 'Indexer status',
        note: 'Live per request. A blank height means the indexer has none yet, not zero. "Blocks behind" is blank when the chain tip or the indexer cursor is unknown.',
        module: 'indexer',
        plainName: 'indexer finality',
        procedure: 'status',
        shape: 'record',
        columns: [
          int('chainId', 'Chain id'),
          text('chainSource', 'Chain source'),
          bool('ingestEnabled', 'Reading blocks'),
          int('indexedHeight', 'Indexed height', { nullable: true }),
          int('finalityDepth', 'Finality depth (blocks)'),
          int('finalizedHeight', 'Finalized height', { nullable: true }),
          int('behindBy', 'Blocks behind the chain', { nullable: true }),
          bool('chain.reachable', 'Chain reachable from the indexer', { nullable: true, parentNullable: true }),
          int('chain.chainHeight', 'Chain height seen by the indexer', { nullable: true, parentNullable: true }),
          text('halted.reason', 'Halted because', { nullable: true, parentNullable: true }),
          time('halted.at', 'Halted at', { nullable: true, parentNullable: true }),
          text('lastError.message', 'Last error', { nullable: true, parentNullable: true }),
          time('lastError.at', 'Last error at', { nullable: true, parentNullable: true }),
          bool('clob.live', 'Order-book venue live'),
          text('clob.kind', 'Order-book venue state'),
        ],
        emptyText: '',
        forbiddenText: FORBID_INDEXER,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
  {
    id: 'dex',
    title: 'DEX health',
    intro: 'Which venues the DEX service has wired. It quotes and builds unsigned calls; it holds no balances and submits nothing.',
    reads: [
      {
        id: 'protocol.dex',
        title: 'DEX health',
        note: 'Configuration facts from svc-dex. A venue that is not wired is not a venue that is down.',
        module: 'dex',
        plainName: 'DEX health',
        procedure: 'health',
        shape: 'record',
        columns: [
          bool('ammVenueWired', 'AMM venue wired'),
          bool('externalVenueWired', 'External venue wired'),
          bool('internalBook.enabled', 'Internal order book enabled'),
        ],
        emptyText: '',
        forbiddenText: FORBID_DEX,
      },
      {
        id: 'protocol.health',
        title: 'Protocol service health',
        note: 'Process-level facts from svc-protocol: whether relaying is switched on and whether the account factory is set. Says nothing about the chain.',
        module: 'protocol',
        plainName: 'protocol service health',
        procedure: 'health',
        shape: 'record',
        columns: [bool('relayEnabled', 'Relaying switched on'), bool('factoryConfigured', 'Account factory configured')],
        emptyText: '',
        forbiddenText: FORBID_PROTOCOL,
      },
    ],
    unavailable: [],
    disabledActions: [],
    links: [],
  },
  {
    id: 'blockers',
    title: 'What is blocking each action',
    intro:
      'The same named blockers the customer Protocol rooms show, worked out here from the reads above. Every action has at least one, because nothing is audited and no customer execution path is wired.',
    reads: [],
    unavailable: [],
    disabledActions: [],
    links: [],
    panel: 'protocol.blockers',
  },
  {
    id: 'listing',
    title: 'Pool and market control',
    intro:
      'Hide or restore a pool, delist or relist a market. Each is a listing decision that two founders sign; nothing on chain changes. The DEX refuses to quote a delisted market.',
    reads: [],
    unavailable: [],
    disabledActions: [],
    links: [
      {
        href: '/protocol-ops/listing',
        label: 'Pool and market control',
        why: 'What is hidden now, and the two-founder request to hide, restore, delist or relist.',
      },
    ],
  },
];

export const DESKS: Readonly<Record<OpsDeskId, DeskSpec>> = {
  bank: {
    id: 'bank',
    module: 'bank-ops',
    endpoint: '/api/bank-ops',
    title: 'Bank operations',
    intro:
      'Pools, loans, cards, ramps and business approvals, as svc-bank reports them. The one action here is an operator card freeze, which a second founder must approve. Bank money jobs stay on Operator tools.',
    sections: bankSections,
    commonSet: 'bank',
  },
  pay: {
    id: 'pay',
    module: 'pay-ops',
    endpoint: '/api/pay-ops',
    title: 'Personal Pay operations',
    intro:
      'How personal transfers are doing, from svc-bank’s operator reads: standing orders, one-off sends, bill payments and global sends, each with the time it was read. Lists lead to a record; counts say which window they cover. This desk changes nothing: svc-bank has no operator action on a personal transfer, and each one is shown switched off with the reason.',
    sections: paySections,
    commonSet: 'pay',
  },
  p2p: {
    id: 'p2p',
    module: 'p2p-ops',
    endpoint: '/api/p2p-ops',
    title: 'P2P operations',
    intro:
      'Disputes, late settlements, offers, trades and posture. A moderator can escalate an open dispute from here. Rulings move escrow and stay with an attributed moderator, not this page.',
    sections: p2pSections,
  },
  academy: {
    id: 'academy',
    module: 'academy-ops',
    endpoint: '/api/academy-ops',
    title: 'Academy operations',
    intro: 'Content and catalogue health, certificates, seasons, and ambassador control.',
    sections: academySections,
    commonSet: 'academy',
    pages: ACADEMY_PAGES,
  },
  more: {
    id: 'more',
    module: 'more-ops',
    endpoint: '/api/more-ops',
    title: 'More modules',
    intro: 'Agents, Quant, Mining, Launch, Market, Token and Campaigns. What can be read is shown; what cannot is named.',
    sections: moreSections,
  },
  protocol: {
    id: 'protocol',
    module: 'protocol-ops',
    endpoint: '/api/protocol-ops',
    title: 'Protocol operations',
    intro:
      'Chain, audit, indexer and DEX status as the protocol services report them, with the time each was read. The one write is the two-founder pool and market control. The network label comes from the chain id a service reports: nothing here is INTACHAIN until a service says so, and nothing is audited.',
    sections: protocolSections,
  },
};

export const DESK_IDS = Object.keys(DESKS) as OpsDeskId[];

/**
 * Mining has its own desk page (`/more-ops/mining`) so it carries the common section set like bank, pay and academy. Its reads
 * stay on the More modules desk and its API: this is that desk's mining section alone, not a second copy of the reads.
 */
export const MINING_DESK: DeskSpec = {
  ...DESKS.more,
  title: 'Mining operations',
  intro:
    'Pool terms, payout windows, shares and workers, as svc-mining-pool reports them, each with the time it was read. This desk changes nothing: the pool has no operator action, and payouts refuse until emission is published.',
  sections: moreSections.filter((s) => s.id === 'mining'),
  commonSet: 'mining',
};

/**
 * One Academy section on its own page: the overview desk's reads for that section alone, through the same API, with the
 * five section pages in its navigation.
 */
export function academySectionDesk(sectionId: string): DeskSpec {
  const page = ACADEMY_PAGES.find((p) => p.id === sectionId);
  const section = academySections.find((s) => s.id === sectionId);
  if (!page || !section) throw new Error(`no Academy section ${sectionId}`);
  return {
    ...DESKS.academy,
    title: `Academy: ${page.title.toLowerCase()}`,
    intro: section.intro,
    sections: [section],
    commonSet: undefined,
  };
}

export function allReads(desk: DeskSpec): ReadSpec[] {
  return desk.sections.flatMap((s) => [...s.reads]);
}

export function readSpecFor(deskId: OpsDeskId, readId: string): ReadSpec | undefined {
  return allReads(DESKS[deskId]).find((r) => r.id === readId);
}
