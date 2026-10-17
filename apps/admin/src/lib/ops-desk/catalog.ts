import type { Column, DeskSpec, DeskSection, OpsDeskId, ReadSpec, Unavailable } from './types';

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
    ],
    unavailable: [
      un(
        'bank.pool-totals',
        'Pool balances, depositors and utilisation',
        'svc-bank has no operator read of what is held in a pool or how many people hold it. Every balance read is scoped to the signed-in owner.',
        13,
      ),
    ],
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
    intro: 'The loan products and the thresholds a borrower is held to.',
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
    ],
    unavailable: [
      un(
        'bank.loan-book',
        'Loans open, outstanding principal, loans near margin call or liquidation',
        'svc-bank has no operator read of the loan book. loans.list and loans.health are scoped to one borrower.',
        14,
      ),
    ],
    disabledActions: [
      {
        id: 'bank.seize-loan',
        label: 'Seize or liquidate a loan',
        reason:
          'Moves collateral. It is a treasury procedure on Operator tools and is not repeated here without a loan list to choose from (need 14).',
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
    ],
    unavailable: [
      un(
        'bank.cards-issued',
        'Cards issued, active and frozen; authorisation volumes and declines',
        'svc-bank has no operator read of cards. cards.list and cards.authorizations are scoped to one owner.',
        15,
      ),
    ],
    disabledActions: [
      {
        id: 'bank.card-freeze',
        label: 'Freeze a card',
        reason:
          'cards.setStatus acts as the card owner (bank:write). An operator freeze of someone else’s card does not exist in svc-bank (need 15).',
      },
    ],
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
    ],
    unavailable: [
      un(
        'bank.ramp-health',
        'Provider health, ramp volumes and failures by provider',
        'svc-bank has no operator read of ramps. ramps.onramps and ramps.offramps are scoped to one owner, and no provider heartbeat is exposed.',
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
    ],
    unavailable: [
      un(
        'bank.business-queue',
        'Pending business approvals across all businesses',
        'business.pending lists the approvals of the businesses the signed-in person belongs to. There is no operator queue across businesses.',
        17,
      ),
    ],
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

// ─── P2P ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_P2P_MOD =
  'svc-p2p did not accept your founder session for this read. Disputes are for moderators: your account must be on P2P_MODERATOR_USER_IDS or hold admin:compliance.';
const FORBID_P2P_COMPLIANCE = 'svc-p2p did not accept your founder session for this read (it needs admin:compliance).';

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
        id: 'p2p.escalate',
        label: 'Escalate a dispute',
        reason:
          'svc-p2p escalates by itself: its timeout sweep re-arms an overdue dispute and counts it above. It has no manual escalate procedure (need 19).',
      },
      {
        id: 'p2p.resolve',
        label: 'Release or refund escrow',
        reason:
          'This moves escrowed money and svc-p2p has no two-person approval on it (need 19), so the console offers no one-click ruling. A ruling is made by an attributed moderator with the evidence open.',
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
    title: 'Offers and orders',
    intro: 'Every offer and every trade on the platform.',
    reads: [],
    unavailable: [
      un(
        'p2p.offers',
        'Offers: open, paused, closed; by asset and currency',
        'offers.list and offers.get are scoped to the signed-in merchant. svc-p2p has no operator-wide offers read.',
        19,
      ),
      un(
        'p2p.trades',
        'Orders and trades: counts by status, volume, cancel and dispute rates',
        'trades.list and trades.get are scoped to the two parties. The only operator views are disputes and late settlements above.',
        19,
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
    unavailable: [
      un(
        'academy.enrolments',
        'Enrolments, lesson completions and completion rate',
        'svc-academy keeps progress per learner and answers only for the signed-in learner (certProgress, myCerts). There is no aggregate read.',
        20,
      ),
    ],
    disabledActions: [],
    links: [],
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
    unavailable: [
      un(
        'academy.grant-audit',
        'Certificate grant audit: who was granted what and when',
        'grantCert is the learner’s own door and myCerts answers only for the signed-in learner. No operator read lists grants.',
        20,
      ),
    ],
    disabledActions: [],
    links: [],
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
    intro: 'The people who carry the Academy role, and applications waiting for a decision.',
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
        note: 'Open applications, as svc-academy lists them.',
        module: 'academy',
        procedure: 'openResidencies',
        input: { limit: 100 },
        shape: 'list',
        idKey: 'id',
        page: 100,
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
    disabledActions: [
      {
        id: 'academy.decide-residency',
        label: 'Decide a residency',
        reason: 'svc-academy has decideResidency (admin:write) but this console does not carry it yet, so decisions are made outside it.',
      },
      {
        id: 'academy.appoint',
        label: 'Appoint an ambassador',
        reason: 'svc-academy has appointAmbassador (two-person approval) but this console does not carry it yet.',
      },
    ],
    links: [],
  },
];

// ─── More ────────────────────────────────────────────────────────────────────────────────────────────────────────

const FORBID_MARKET_OPS = 'svc-market did not accept your founder session for this read (it needs market:ops).';

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
    ],
    unavailable: [
      un(
        'quant.runs',
        'Backtest and sandbox runs: counts, durations, failures',
        'svc-quant keeps studio and runs per user and exposes only health to an operator.',
        22,
      ),
    ],
    disabledActions: [],
    links: [],
  },
  {
    id: 'mining',
    title: 'Mining pool',
    intro: 'Shares, workers and payout windows.',
    reads: [],
    unavailable: [
      un(
        'mining.shares',
        'Workers, shares accepted and rejected, payout windows',
        'svc-mining-pool answers only /health and /ready over plain HTTP (it has no tRPC), so the edge has no typed read to forward and no share counter is exposed.',
        23,
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
        'launch.issuers',
        'Issuer state: applications, launches in progress, deployer standing',
        'No service keeps an issuer registry. agents.launch.assess scores one deployer you name; svc-market and svc-token have no launch list.',
        24,
      ),
      un(
        'launch.predict',
        'Predict markets',
        'Predict stays on Protocol. The P1 GO is recorded, but INTACORE and svc-predict do not run yet. Nothing here reads a chain.',
        null,
      ),
    ],
    disabledActions: [],
    links: [],
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
        note: 'What a shopper can see today. Empty when no house commission is configured: svc-market will not invent a rate.',
        module: 'market',
        procedure: 'listings',
        input: { limit: 50 },
        shape: 'list',
        idKey: 'id',
        page: 50,
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
        emptyText: 'No listings are public. That is expected when no house commission is configured.',
        forbiddenText: 'svc-market did not answer this read.',
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
        'market.volume',
        'Purchases, volume and subscriptions per vendor',
        'purchase and myPurchases are the buyer’s own. There is no operator read of sales.',
        25,
      ),
    ],
    disabledActions: [
      {
        id: 'market.takedown',
        label: 'Take down a listing',
        reason: 'archiveListing belongs to the vendor. svc-market has no operator takedown; suspending the vendor is the lever (need 25).',
      },
    ],
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
        'No campaign service exists: the customer Campaigns room says so too. The nearest real data is the CRM outreach campaigns.',
        26,
      ),
    ],
    disabledActions: [],
    links: [{ href: '/crm', label: 'CRM outreach campaigns', why: 'Enquiries, sources and outreach campaigns that do exist.' }],
  },
];

export const DESKS: Readonly<Record<OpsDeskId, DeskSpec>> = {
  bank: {
    id: 'bank',
    module: 'bank-ops',
    endpoint: '/api/bank-ops',
    title: 'Bank operations',
    intro:
      'Pools, loans, cards, ramps and business approvals, as svc-bank reports them. Read-only: bank money jobs stay on Operator tools.',
    sections: bankSections,
  },
  p2p: {
    id: 'p2p',
    module: 'p2p-ops',
    endpoint: '/api/p2p-ops',
    title: 'P2P operations',
    intro: 'Disputes, late settlements and posture. Read-only: P2P rulings move escrow and have no console path.',
    sections: p2pSections,
  },
  academy: {
    id: 'academy',
    module: 'academy-ops',
    endpoint: '/api/academy-ops',
    title: 'Academy operations',
    intro: 'Content and catalogue health, certificates, seasons, and ambassador control.',
    sections: academySections,
  },
  more: {
    id: 'more',
    module: 'more-ops',
    endpoint: '/api/more-ops',
    title: 'More modules',
    intro: 'Agents, Quant, Mining, Launch, Market and Campaigns. What can be read is shown; what cannot is named.',
    sections: moreSections,
  },
};

export const DESK_IDS = Object.keys(DESKS) as OpsDeskId[];

export function allReads(desk: DeskSpec): ReadSpec[] {
  return desk.sections.flatMap((s) => [...s.reads]);
}

export function readSpecFor(deskId: OpsDeskId, readId: string): ReadSpec | undefined {
  return allReads(DESKS[deskId]).find((r) => r.id === readId);
}
