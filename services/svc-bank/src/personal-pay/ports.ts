/**
 * Partner ports for personal bill pay and global send.
 *
 * Production constructs the empty ports. An empty port is not a catalogue,
 * not a rate and not a rail. Callers must read `status()` and refuse before
 * they ask for data. The live methods exist so a deployment that has been
 * handed a real provider can be wired without a second money path.
 */

export type PortStatus = 'unset' | 'live';

export interface Biller {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly category: string;
}

export interface BillLookup {
  readonly amountDue: string;
  readonly dueDate: string;
  readonly payeeName: string;
  readonly currency: string;
}

export type BillRailAnswer =
  { readonly ok: true; readonly providerRef: string; readonly status: 'accepted' | 'paid' } | { readonly ok: false };

export interface BillerDirectoryPort {
  status(): PortStatus;
  search(input: { readonly query: string; readonly country?: string }): Promise<readonly Biller[]>;
}

export interface BillLookupPort {
  status(): PortStatus;
  lookup(input: { readonly billerId: string; readonly reference: string }): Promise<BillLookup | null>;
}

export interface BillPayRailPort {
  status(): PortStatus;
  /** Live rail id for the ledger boundary. Never a made-up partner name. */
  railId(): string;
  submit(input: {
    readonly paymentId: string;
    readonly idempotencyKey: string;
    readonly billerId: string;
    readonly reference: string;
    readonly amount: string;
    readonly assetId: string;
  }): Promise<BillRailAnswer>;
}

export interface Corridor {
  readonly country: string;
  readonly currency: string;
  readonly deliveryMethods: string[];
  readonly minAmount: string | null;
  readonly maxAmount: string | null;
  readonly cutOffTime: string | null;
}

export interface CorridorPort {
  status(): PortStatus;
  list(): Promise<readonly Corridor[]>;
}

export interface BicHit {
  readonly bic: string;
  readonly bankName: string;
}

export interface BicDirectoryPort {
  status(): PortStatus;
  lookup(bic: string): Promise<BicHit | null>;
}

export interface FxQuote {
  readonly rate: string;
  readonly fee: string;
  readonly feeAsset: string;
  readonly receiveAmount: string;
  readonly validUntil: string;
  readonly eta: string;
}

export interface FxPort {
  status(): PortStatus;
  quote(input: { readonly asset: string; readonly amount: string; readonly toCurrency: string }): Promise<FxQuote>;
}

export type PayoutStatus = 'sent' | 'on_the_way' | 'arrived';

export type PayoutAnswer = { readonly ok: true; readonly providerRef: string; readonly status: PayoutStatus } | { readonly ok: false };

export interface PayoutRailPort {
  status(): PortStatus;
  /**
   * Whether this partner pays out to one corridor of the catalogue. Absent, it pays out to every corridor. A corridor it
   * does not cover is refused `bank.global_payout_uncovered` before anything is posted, and the send's intent row is kept.
   */
  covers?(corridor: { readonly country: string; readonly currency: string; readonly deliveryMethod: string }): boolean;
  railId(): string;
  submit(input: {
    readonly sendId: string;
    readonly idempotencyKey: string;
    readonly amount: string;
    readonly assetId: string;
    readonly toCurrency: string;
    readonly recipientId: string;
    /** The rate lock the customer confirmed, and its figures: the partner pays exactly this or refuses. */
    readonly quoteId: string;
    readonly rate: string;
    readonly receiveAmount: string;
  }): Promise<PayoutAnswer>;
}

/** Owner-recorded travel-rule decision. Null means Nitro/Phantom have not decided. */
export interface TravelRuleDecision {
  readonly decidedBy: string;
  readonly requiredFields: readonly string[];
}

export interface TravelRulePort {
  decision(): TravelRuleDecision | null;
}

export interface BillPorts {
  readonly directory: BillerDirectoryPort;
  readonly lookup: BillLookupPort;
  readonly rail: BillPayRailPort;
}

export interface GlobalPorts {
  /** Set only by the TEST stand-in (`global-sim.ts`): its catalogue's TEST label, shown beside every number it gives. */
  readonly standIn?: { readonly label: string };
  /**
   * Set only by the TEST stand-in: whether a send is screened, put on hold before anything is posted
   * (`GlobalHoldService.screen`). Screened once: after its hold is released, the send carries on.
   */
  readonly review?: { readonly waits: (send: { readonly assetId: string; readonly amount: string }) => boolean };
  readonly corridors: CorridorPort;
  readonly bic: BicDirectoryPort;
  readonly fx: FxPort;
  readonly payout: PayoutRailPort;
  readonly travelRule: TravelRulePort;
}

const unset = (): PortStatus => 'unset';

export function emptyBillPorts(): BillPorts {
  return {
    directory: {
      status: unset,
      search() {
        return Promise.reject(new Error('biller directory is unset'));
      },
    },
    lookup: {
      status: unset,
      lookup() {
        return Promise.reject(new Error('bill lookup is unset'));
      },
    },
    rail: {
      status: unset,
      railId() {
        throw new Error('bill rail is unset');
      },
      submit() {
        return Promise.reject(new Error('bill rail is unset'));
      },
    },
  };
}

export function emptyGlobalPorts(): GlobalPorts {
  return {
    corridors: {
      status: unset,
      list() {
        return Promise.reject(new Error('corridor catalogue is unset'));
      },
    },
    bic: {
      status: unset,
      lookup() {
        return Promise.reject(new Error('BIC directory is unset'));
      },
    },
    fx: {
      status: unset,
      quote() {
        return Promise.reject(new Error('FX source is unset'));
      },
    },
    payout: {
      status: unset,
      railId() {
        throw new Error('payout rail is unset');
      },
      submit() {
        return Promise.reject(new Error('payout rail is unset'));
      },
    },
    travelRule: { decision: () => null },
  };
}
