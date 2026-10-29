import { BANK_CUSTOMER_BALANCES } from '@/lib/ops-desk/catalog';
import type { Column, ReadSpec, Unavailable } from '@/lib/ops-desk/types';
import type { CustomerTab } from './tabs';

export {
  CUSTOMER_TABS,
  INDICATOR_STRIP,
  RECORD_SOURCE_UNWIRED,
  RISK_CARD,
  TAB_LABELS,
  customerId,
  customerTab,
  type CustomerTab,
} from './tabs';

/**
 * One customer's record across money, trade, pay, cards, documents and tickets (OPS-founder-01, ops-console-founder-002), at
 * `/accounts/:userId`. Each tab reads the owning service's own operator read for this one account, as the signed-in founder,
 * and each read loads or refuses on its own: one service down refuses its own block, never the tab beside it.
 *
 * The spec puts the fan-out in svc-ops (`ops.customers.get`); svc-ops has no such read yet, so the console makes the same reads
 * itself, through contracts and svc-edge. A later svc-ops read can replace `tabReads` without changing the page.
 *
 * What no service can answer for one account is listed per tab with the reason, never left out or shown as empty.
 */

const col = (key: string, label: string, kind: Column['kind'], extra: Partial<Column> = {}): Column => ({ key, label, kind, ...extra });

const CONTROL_HISTORY_LIMIT = 50;
const DOCUMENT_LIMIT = 50;
/** identity's own cap on one selfie list (`kyc.selfie.listFor`, max 50). */
const SELFIE_LIMIT = 50;

/** An account-control history for one target: every restrict or restore attempt, newest first, as the owning service logged it. */
function controlHistory(id: string, module: 'identity' | 'trade', area: 'identity' | 'trading', userId: string, service: string): ReadSpec {
  return {
    id,
    title: area === 'trading' ? 'Trading restrictions' : 'Account restrictions',
    note: `Every restrict or restore of this account’s ${area === 'trading' ? 'trading' : 'access'} that ${service} logged, with its outcome. Changing it is on Account controls, with a second founder.`,
    module,
    plainName: `${service}’s restriction history`,
    procedure: 'accountControls.history',
    input: { target: { area, userId }, limit: CONTROL_HISTORY_LIMIT },
    shape: 'list',
    idKey: 'auditId',
    page: CONTROL_HISTORY_LIMIT,
    columns: [
      col('occurredAt', 'When', 'time'),
      col('action', 'Asked for', 'text'),
      col('outcome', 'Outcome', 'text'),
      col('auditId', 'Audit id', 'text', { detail: true }),
    ],
    emptyText: `${service} has no restriction logged for this account: it has never been restricted or restored here.`,
    forbiddenText: `${service} did not accept your founder session for this read (account controls need an enabled founder with a confirmed second factor).`,
  };
}

function allowlistRead(id: string, title: string, procedure: string, note: string, columns: readonly Column[], userId: string): ReadSpec {
  return {
    id,
    title,
    note,
    module: 'pay',
    plainName: `svc-pay’s ${title.toLowerCase()}`,
    procedure,
    input: { userId },
    shape: 'record',
    columns,
    emptyText: 'svc-pay holds no setting for this account.',
    forbiddenText: 'svc-pay did not accept your founder session for this read (the withdrawal allowlist reads are for enabled founders).',
  };
}

const FREEZE_HISTORY_LIMIT = 50;

/** The account's deposit addresses with any compliance freeze (W-compliance-notices-03). Open a row to freeze or lift it. */
function depositAddresses(userId: string): ReadSpec {
  return {
    id: 'money.deposit-addresses',
    title: 'Deposit addresses',
    note: 'Every deposit address svc-pay issued to this account, and whether compliance froze it. A deposit to a frozen address that is not credited yet is on hold and is never credited until a second founder lifts the freeze. Open a row to freeze it, or to ask for the lift.',
    module: 'pay',
    plainName: 'svc-pay’s deposit addresses',
    procedure: 'founderAdmin.depositFreezes.addresses',
    input: { userId },
    shape: 'list',
    idKey: 'id',
    columns: [
      col('assetId', 'Coin', 'text'),
      col('networkId', 'Network', 'text'),
      col('address', 'Address', 'text'),
      col('frozen', 'Frozen', 'bool'),
      col('held', 'Deposits on hold', 'int'),
      col('freezeReason', 'Why frozen', 'text', { nullable: true }),
      col('frozenAt', 'Frozen at', 'time', { nullable: true }),
      col('frozenBy', 'Frozen by', 'text', { nullable: true, detail: true }),
      col('expiresAt', 'Expires', 'time', { nullable: true, detail: true }),
      col('freezeId', 'Freeze id', 'text', { nullable: true, detail: true }),
      col('userId', 'Account id', 'text', { detail: true }),
    ],
    rowAction: 'pay.deposit_address',
    emptyText: 'svc-pay has issued no deposit address to this account: it has never opened Deposit for a coin.',
    forbiddenText: 'svc-pay did not accept your founder session for this read (deposit address freezes are for enabled founders).',
  };
}

/** Every freeze placed on the account's deposit addresses, open and lifted, newest first, with who froze, approved and lifted it. */
function depositFreezeHistory(userId: string): ReadSpec {
  return {
    id: 'money.deposit-freezes',
    title: 'Deposit address freezes',
    note: 'Every compliance freeze on this account’s deposit addresses, newest first: who placed it and why, and for a lifted one who lifted it, which founder approved, and why.',
    module: 'pay',
    plainName: 'svc-pay’s deposit address freezes',
    procedure: 'founderAdmin.depositFreezes.history',
    input: { userId, limit: FREEZE_HISTORY_LIMIT },
    shape: 'list',
    idKey: 'id',
    page: FREEZE_HISTORY_LIMIT,
    columns: [
      col('frozenAt', 'Frozen at', 'time'),
      col('networkId', 'Network', 'text'),
      col('address', 'Address', 'text'),
      col('reason', 'Why frozen', 'text'),
      col('frozenBy', 'Frozen by', 'text'),
      col('unfrozenAt', 'Lifted at', 'time', { nullable: true }),
      col('unfrozenBy', 'Lifted by', 'text', { nullable: true }),
      col('unfreezeApprover', 'Approved by', 'text', { nullable: true }),
      col('unfreezeReason', 'Why lifted', 'text', { nullable: true, detail: true }),
      col('id', 'Freeze id', 'text', { detail: true }),
    ],
    emptyText: 'No deposit address of this account has ever been frozen.',
    forbiddenText: 'svc-pay did not accept your founder session for this read (deposit address freezes are for enabled founders).',
  };
}

const TRAVEL_RULE_LIMIT = 50;

/** Deposits held for the inbound travel rule (W-deposit-07). Open a row to wait on the sending platform or to release it. */
function depositTravelRule(userId: string): ReadSpec {
  return {
    id: 'money.deposit-travel-rule',
    title: 'Deposits held for the travel rule',
    note: 'Every deposit of this account at or above the owner’s inbound travel-rule threshold, newest first. It is not credited while held. The depositor declares where it came from (sealed in svc-pay, never shown here); a founder releases it, and svc-pay credits it once. A wait on the sending platform that runs out leaves it held.',
    module: 'pay',
    plainName: 'svc-pay’s travel-rule holds',
    procedure: 'founderAdmin.depositTravelRule.list',
    input: { userId, limit: TRAVEL_RULE_LIMIT },
    shape: 'list',
    idKey: 'depositId',
    page: TRAVEL_RULE_LIMIT,
    columns: [
      col('openedAt', 'Held since', 'time'),
      col('assetId', 'Coin', 'text'),
      col('amount', 'Amount', 'amount'),
      col('threshold', 'Threshold', 'amount'),
      col('state', 'State', 'text'),
      col('walletType', 'Sent from', 'text', { nullable: true }),
      col('declaredAt', 'Declared at', 'time', { nullable: true }),
      col('waitDeadline', 'Wait ends', 'time', { nullable: true }),
      col('lastActor', 'Last step by', 'text'),
      col('lastReason', 'Last reason', 'text', { nullable: true, detail: true }),
      col('requiredFields', 'Fields asked', 'list', { detail: true }),
      col('networkId', 'Network', 'text', { detail: true }),
      col('txHash', 'Transaction', 'text', { detail: true }),
      col('ruleVersion', 'Rule version', 'int', { detail: true }),
      col('depositId', 'Deposit id', 'text', { detail: true }),
    ],
    rowAction: 'pay.deposit_travel_rule',
    emptyText: 'No deposit of this account has been held for the travel rule.',
    forbiddenText: 'svc-pay did not accept your founder session for this read (travel-rule holds are for enabled founders).',
  };
}

export interface CustomerTabPlan {
  readonly reads: readonly ReadSpec[];
  /** What this tab cannot show for one account, and why. */
  readonly unwired: readonly Unavailable[];
}

const un = (id: string, label: string, reason: string): Unavailable => ({ id, label, reason, need: null });

/** What a tab reads for `userId`, and what it says it cannot read. */
export function tabPlan(tab: CustomerTab, userId: string): CustomerTabPlan {
  switch (tab) {
    case 'money':
      return {
        reads: [
          { ...BANK_CUSTOMER_BALANCES, input: { userId } },
          depositAddresses(userId),
          depositFreezeHistory(userId),
          depositTravelRule(userId),
        ],
        unwired: [
          un(
            'money.deposits',
            'Each deposit and withdrawal of this account',
            'svc-pay has no operator read that lists one customer’s deposits or withdrawals one by one. How many deposits a freeze holds is on Deposit addresses; the entries behind each coin are on the Bank desk’s customer balances.',
          ),
        ],
      };
    case 'trade':
      return {
        reads: [controlHistory('trade.controls', 'trade', 'trading', userId, 'svc-trade')],
        unwired: [
          un(
            'trade.orders',
            'Open orders and trade history',
            'svc-trade and svc-matching have no operator read of one customer’s orders or fills; their reads answer only the signed-in owner.',
          ),
          un('trade.positions', 'Positions and margin', 'svc-trade has no operator read of one customer’s positions or margin.'),
        ],
      };
    case 'pay':
      return {
        reads: [
          allowlistRead(
            'pay.allowlist-mode',
            'Withdrawal allowlist',
            'founderAdmin.allowlist.mode',
            'Whether this account may withdraw crypto only to addresses on its allowlist, as svc-pay holds it now.',
            [col('enabled', 'Allowlist-only withdrawals', 'bool'), col('setAt', 'Set', 'time', { nullable: true })],
            userId,
          ),
          allowlistRead(
            'pay.allowlist-policy',
            'One-time sends policy',
            'founderAdmin.allowlist.policy',
            'Whether one send to an unlisted address is allowed while allowlist-only is on, and up to what amount.',
            [
              col('enabled', 'One-time sends allowed', 'bool'),
              col('assetId', 'Coin', 'text', { nullable: true }),
              col('maxAmount', 'Largest one-time send', 'amount', { nullable: true }),
              col('setAt', 'Set', 'time', { nullable: true }),
            ],
            userId,
          ),
        ],
        unwired: [
          un(
            'pay.payments',
            'Payments sent and received',
            'svc-pay has no operator read that lists one customer’s payments; its payment reads answer only the signed-in owner or a merchant.',
          ),
        ],
      };
    case 'cards':
      return {
        reads: [],
        unwired: [
          un(
            'cards.list',
            'Cards issued to this account',
            'svc-bank keeps each customer’s cards, but its card list answers only the signed-in owner; it has no operator read of one customer’s cards.',
          ),
        ],
      };
    case 'documents':
      return {
        reads: [
          {
            id: 'identity.documents',
            title: 'Identity documents',
            note: 'Every document identity’s vault holds for this account, newest first: what it is, when it was stored, and the status of the verification it is attached to. Only the description is read here; open a row to ask a second founder to approve opening its contents.',
            module: 'identity',
            plainName: 'identity’s document vault',
            procedure: 'kyc.listDocuments',
            input: { userId, limit: DOCUMENT_LIMIT },
            shape: 'list',
            idKey: 'id',
            page: DOCUMENT_LIMIT,
            columns: [
              col('createdAt', 'Stored', 'time'),
              col('contentType', 'Type', 'text'),
              col('reviewStatus', 'Status', 'text'),
              col('byteLength', 'Size (bytes)', 'int'),
              col('storedBy', 'Stored by', 'text', { nullable: true }),
              col('reviewTier', 'Verification level', 'text', { nullable: true, detail: true }),
              col('reviewRecordId', 'Verification id', 'text', { nullable: true, detail: true }),
              col('id', 'Document id', 'text', { detail: true }),
            ],
            rowAction: 'identity.kyc_document.open',
            emptyText: 'Identity’s vault holds no document for this account: none has been uploaded or stored for it.',
            forbiddenText:
              'Identity did not accept your founder session for this read (the document list is for an enabled founder with the compliance permission and a second factor).',
            refusals: {
              'kyc_doc.unwired':
                'Identity’s document vault is switched off on this deployment: its encryption key (IDENTITY_KYC_DOC_KEY) is not set, so no document can be stored or listed for anyone.',
              'kyc_doc.reviews_unwired':
                'Identity’s document vault is on, but its lookup of the verification each document is attached to is not wired, so it refuses the list rather than show every document as not attached.',
            },
          },
          {
            id: 'identity.selfies',
            title: 'Selfies',
            note: 'Every selfie this account sent for comparison with its ID photo, newest first: how it was taken, its status and when it was decided. The selfie’s photo is the document named in its row; open that document above to compare. A selfie that waits can be accepted or rejected here, with a second founder’s approval.',
            module: 'identity',
            plainName: 'identity’s selfie step',
            procedure: 'kyc.selfie.listFor',
            input: { userId, limit: SELFIE_LIMIT },
            shape: 'list',
            rowsKey: 'selfies',
            idKey: 'id',
            page: SELFIE_LIMIT,
            columns: [
              col('createdAt', 'Taken', 'time'),
              col('status', 'Status', 'text'),
              col('via', 'Taken on', 'text'),
              col('decidedAt', 'Decided', 'time', { nullable: true }),
              col('captureCheck', 'Automatic check', 'text', { detail: true }),
              col('documentId', 'Photo document id', 'text', { detail: true }),
              col('id', 'Selfie id', 'text', { detail: true }),
            ],
            rowAction: 'identity.kyc_selfie.decide',
            emptyText: 'This account has sent no selfie.',
            forbiddenText:
              'Identity did not accept your founder session for this read (the selfie list is for an enabled founder with the compliance permission).',
            refusals: {
              'kyc.selfie_unconfigured':
                'Identity’s selfie step is switched off on this deployment, so no selfie can be taken or listed for anyone.',
            },
          },
        ],
        unwired: [
          un(
            'documents.decisions',
            'Document decisions and requests',
            'Identity keeps no accept, reject or request-again decision per document, and no request to the customer for a new one (OPS-cases-07). A document’s status above is the review of the verification it is attached to; review decisions are on the Identity desk’s case queue.',
          ),
        ],
      };
    case 'tickets':
      return {
        reads: [],
        unwired: [
          un(
            'tickets.list',
            'Support requests from this account',
            'svc-support has no read of one customer’s requests for staff: its staff reads go by request id or the whole queue, and it refuses on purpose to answer about an arbitrary account. Find the request on the Support desk.',
          ),
        ],
      };
  }
}
