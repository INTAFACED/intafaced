import type { Sql } from 'postgres';
import type { CustodyLayerState, LedgerClient } from '@intafaced/ledger-client';
import {
  bankCustodyLayer,
  custodyGuardedLedger,
  freezeGuardedCustody,
  type PartnerCustody,
  type PostingFreeze,
} from './partner/partner-bank.js';
import { testPartnerCustody, type TestPartner } from './partner/test-partner.js';
import { PartnerStopService, stopGuardedCustody, TEST_PARTNER_ID } from './partner/partner-stops.js';
import { PartnerRefusalCounts } from './partner/partner-refusals.js';
import { BusinessLookupLimiter, unconfiguredBusinessDirectory, type BusinessDirectoryPort } from './business/business-directory.js';
import type { AssetRegistryReads } from './assets/supported-assets.js';
import type { RecipientStatePort } from './recipient-state.js';
import type { LedgerHistory } from './analytics/ledger-history.js';

/**
 * What every area of svc-bank shares, made once before any area (`area-chain.ts`): the connection, the guarded ledger,
 * the partner's custody behind the posting freeze and the partner stop, and the owner's values more than one area reads.
 * A value only one area reads is that area's own option, in its own `compose.ts`, never here.
 */
export interface BankRoot {
  readonly sql: Sql;
  /** The ledger with the custody switch in front: with the custodial layer off no customer balance is posted. */
  readonly ledger: LedgerClient;
  readonly history: LedgerHistory;
  readonly custodyLayer: CustodyLayerState;
  readonly postingFreeze: PostingFreeze;
  readonly partnerStops: PartnerStopService;
  readonly partnerRefusals: PartnerRefusalCounts;
  /** The TEST partner's custody, asked behind the posting freeze and the partner stop. */
  readonly custody: PartnerCustody;
  readonly testPartner: TestPartner | null;
  readonly directory: BusinessDirectoryPort;
  /** One lookup budget per caller for every door that asks the directory for a person: business and shared pots. */
  readonly directoryLookups: BusinessLookupLimiter;
  readonly assetRegistry: AssetRegistryReads | null;
  readonly recipients: RecipientStatePort | undefined;
  readonly receiptSecret: string | undefined;
}

export interface BankRootOptions {
  /**
   * The custody switch as svc-bank reads it (`LEDGER_CUSTODY_LAYER`, OWNER 226). A value passed in wins; otherwise the
   * live env, where unset is off. Off: every customer-balance post refuses `bank.no_partner_bank` before svc-ledger,
   * and a card authorisation for a person whose money no partner holds refuses `bank.partner_unset`.
   */
  custodyLayer?: CustodyLayerState;
  /** svc-ledger's platform posting freeze, asked before every partner move (`ledgerPostingFreeze`). */
  postingFreeze?: PostingFreeze;
  /** The TEST partner bank and ramp (`BANK_TEST_PARTNER=test`); refused at boot outside dev/test. Unset: no switches. */
  testPartner?: TestPartner | null;
  /**
   * Public handles and exact recipient lookup. Unset refuses team, approval
   * history and recipient-space reads. It does not invent a handle.
   */
  directory?: BusinessDirectoryPort;
  /** Recipient-lookup budget. Default is 30 per minute per caller. */
  directoryLookups?: BusinessLookupLimiter;
  /**
   * svc-ledger's asset and network registry (W-balances-05). The customer's supported-asset list reads it, and the
   * deposit catalogue is narrowed to it. Unset refuses both with `bank.asset_registry_unavailable`.
   */
  assetRegistry?: AssetRegistryReads | null;
  /**
   * Who may be credited: asks svc-identity whether a recipient is frozen or closed.
   *
   * Not defaulted to "everyone may receive". With no port every credit to another
   * user refuses `bank.recipient_check_unset`; moves between a user's own spaces
   * need no check and still work. See `recipient-state.ts`.
   */
  recipients?: RecipientStatePort;
  /** The service secret a global-send or cash-out receipt's signing key is derived from. Blank, no receipt is made. */
  receiptSecret?: string;
}

/** No posting freeze wired: every partner move refuses `bank.posting_frozen`. */
const FREEZE_NOT_WIRED: PostingFreeze = Object.freeze({
  postingEnabled: async (): Promise<boolean> => false,
  read: async () => ({ postingEnabled: false, cause: 'not_wired' as const }),
});

export function composeBankRoot(sql: Sql, bookLedger: LedgerClient, history: LedgerHistory, options: BankRootOptions): BankRoot {
  const custodyLayer = bankCustodyLayer(options.custodyLayer);
  // With the custodial layer off no customer balance is posted from here: refused by name before svc-ledger is asked.
  const ledger = custodyGuardedLedger(bookLedger, custodyLayer);
  // A person the TEST partner holds money for (`custody: 'off'`) reads and moves it at the partner; everyone else, as before.
  // Every partner move first asks svc-ledger's posting freeze (floor 4). No freeze wired reads as frozen: a partner move
  // is refused, never made unguarded.
  const postingFreeze = options.postingFreeze ?? FREEZE_NOT_WIRED;
  // The operator's partner stop is asked too (a stopped kind refuses `bank.partner_stopped`), and never instead of the freeze.
  // Every refusal by either is counted for the desk, by cause and kind.
  const partnerStops = new PartnerStopService(sql);
  const partnerRefusals = new PartnerRefusalCounts(sql);
  const custody = stopGuardedCustody(
    freezeGuardedCustody(testPartnerCustody(options.testPartner), postingFreeze, partnerRefusals.note),
    TEST_PARTNER_ID,
    partnerStops,
    partnerRefusals.note,
  );
  return {
    sql,
    ledger,
    history,
    custodyLayer,
    postingFreeze,
    partnerStops,
    partnerRefusals,
    custody,
    testPartner: options.testPartner ?? null,
    directory: options.directory ?? unconfiguredBusinessDirectory(),
    directoryLookups: options.directoryLookups ?? new BusinessLookupLimiter(),
    assetRegistry: options.assetRegistry ?? null,
    recipients: options.recipients,
    receiptSecret: options.receiptSecret,
  };
}
