#!/usr/bin/env python3
from pathlib import Path
ROOT = Path(".")

def patch(path: str, replacements: list[tuple[str, str]]) -> None:
    p = ROOT / path
    t = p.read_text()
    for old, new in replacements:
        if old not in t:
            raise SystemExit(f"missing needle in {path}: {old[:80]!r}")
        t = t.replace(old, new)
    p.write_text(t)
    print("patched", path)

# ramp-service
p = ROOT / "services/svc-bank/src/ramps/ramp-service.ts"
t = p.read_text()
t = t.replace(
    "import { assertCryptoRamp, type RampProgramme, NO_RAMP_PROGRAMME } from './rails.js';\n",
    "import { assertCryptoRamp, type RampProgramme, NO_RAMP_PROGRAMME } from './rails.js';\nimport {\n  destKindForRamp,\n  UserWithdrawDestinationStore,\n  type UserWithdrawDestinations,\n} from '../withdraw-destination.js';\n",
)
t = t.replace(
    "  payFiat?: PayFiatRampPort;\n}\n",
    "  payFiat?: PayFiatRampPort;\n  /**\n   * Persisted user withdraw dest. Default is the SQL store. Tests may inject\n   * `assertOnlyWithdrawDestinations` so persist asserts and require refuses.\n   */\n  destinations?: UserWithdrawDestinations;\n}\n",
)
t = t.replace(
    """export class RampService {
  private readonly programme: RampProgramme;
  private readonly payFiat: PayFiatRampPort;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    options: RampServiceOptions = {},
  ) {
    this.programme = options.programme ?? NO_RAMP_PROGRAMME;
    this.payFiat = options.payFiat ?? emptyPayFiatRampPort;
  }
""",
    """export class RampService {
  private readonly programme: RampProgramme;
  private readonly payFiat: PayFiatRampPort;
  private readonly destinations: UserWithdrawDestinations;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    options: RampServiceOptions = {},
  ) {
    this.programme = options.programme ?? NO_RAMP_PROGRAMME;
    this.payFiat = options.payFiat ?? emptyPayFiatRampPort;
    this.destinations = options.destinations ?? new UserWithdrawDestinationStore(sql);
  }
""",
)
t = t.replace(
    """  programmeInfo(): RampProgramme {
    return this.programme;
  }
""",
    """  programmeInfo(): RampProgramme {
    return this.programme;
  }

  /** Persist a user withdraw dest (IBAN/IFSC/EVM) so a later offramp has a real ref. */
  setWithdrawDestination(input: { userId: string; kind: string; ref: string }) {
    return this.destinations.persist(input);
  }
""",
)
old = """  async offramp(input: {
    offrampId: string;
    userId: string;
    assetId: string;
    amount: Amount;
    kind: RampKind;
    destinationRef: string;
    clientRef: string;
  }): Promise<OfframpRecord> {
    if (input.amount <= 0n) {
      throw new BankError('Off-ramp amount must be positive', 'bank.ramp_invalid_amount');
    }
    assertRampAssetId(input.assetId);
    if (!input.destinationRef.trim()) {
      throw new BankError('Off-ramp destination is required', 'bank.ramp_invalid_destination');
    }
    const rail = input.kind === 'fiat' ? await resolvePayFiatRailId(this.payFiat, 'offramp') : assertCryptoRamp(this.programme);

    return withMoneySpan(
      'bank.ramp.offramp',
      { operation: 'offramp', amount: formatAmount(input.amount), userId: input.userId, assetId: input.assetId },
      async () => {
        const claimed = await this.claimOfframp({ ...input, rail });
"""
new = """  async offramp(input: {
    offrampId: string;
    userId: string;
    assetId: string;
    amount: Amount;
    kind: RampKind;
    destinationRef?: string;
    clientRef: string;
  }): Promise<OfframpRecord> {
    if (input.amount <= 0n) {
      throw new BankError('Off-ramp amount must be positive', 'bank.ramp_invalid_amount');
    }
    assertRampAssetId(input.assetId);
    const rail = input.kind === 'fiat' ? await resolvePayFiatRailId(this.payFiat, 'offramp') : assertCryptoRamp(this.programme);
    const destKind = destKindForRamp(input.kind);
    const dest = input.destinationRef?.trim()
      ? await this.destinations.persist({ userId: input.userId, kind: destKind, ref: input.destinationRef })
      : await this.destinations.require({ userId: input.userId, kind: destKind });

    return withMoneySpan(
      'bank.ramp.offramp',
      { operation: 'offramp', amount: formatAmount(input.amount), userId: input.userId, assetId: input.assetId },
      async () => {
        const claimed = await this.claimOfframp({ ...input, rail, destinationRef: dest.ref });
"""
if old not in t:
    raise SystemExit("offramp block not found")
t = t.replace(old, new)
p.write_text(t)
print("patched ramp-service")

# router
p = ROOT / "services/svc-bank/src/router.ts"
t = p.read_text()
t = t.replace(
    "      case 'bank.fiat_ramp_socket':\n      case 'bank.earn_rate_unset':",
    "      case 'bank.fiat_ramp_socket':\n      case 'bank.withdraw_destination_missing':\n      case 'bank.earn_rate_unset':",
)
t = t.replace(
    "          destinationRef: z.string().min(1).max(256),\n          clientRef: z.string().min(1).max(128),",
    "          destinationRef: z.string().min(1).max(256).optional(),\n          clientRef: z.string().min(1).max(128),",
)
old = """    /**
     * User off-ramp. `offrampId` + `clientRef` are client-supplied so a retry
     * is the same withdrawal (§5). Fiat refuses before any hold is posted.
     */
    offramp:"""
new = """    /**
     * Persist a user withdraw dest (IBAN/IFSC/EVM) so a later offramp has a
     * real ref before withdrawHold. Does not move value and does not invent a PSP.
     */
    setWithdrawDestination: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ kind: z.enum(['crypto', 'bank']), ref: z.string().min(1).max(256) }))
      .output(z.object({ kind: z.string(), ref: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => bank.ramps.setWithdrawDestination({ userId: ctx.principal.userId, kind: input.kind, ref: input.ref })),
      ),

    /**
     * User off-ramp. `offrampId` + `clientRef` are client-supplied so a retry
     * is the same withdrawal (§5). Fiat refuses before any hold is posted.
     * Destination is persisted (or loaded) before withdrawHold.
     */
    offramp:"""
if old not in t:
    raise SystemExit("router offramp comment not found")
t = t.replace(old, new)
p.write_text(t)
print("patched router")

EVM = "0x000000000000000000000000000000000000dEaD"
IBAN = "GB82WEST12345698765432"

# ramps.test
p = ROOT / "services/svc-bank/src/ramps/ramps.test.ts"
t = p.read_text()
t = t.replace(
    "await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.spaces RESTART IDENTITY CASCADE`;",
    "await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations, bank.spaces RESTART IDENTITY CASCADE`;",
)
t = t.replace("destinationRef: 'IBAN-TEST'", f"destinationRef: '{IBAN}'")
t = t.replace("destinationRef: '0xout'", f"destinationRef: '{EVM}'")
insert = f"""
  describe('user withdraw destination persist before withdrawHold', () => {{
    it('refuses a gibberish dest before any hold is posted', async () => {{
      await ramps.creditOnramp({{
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'dest-garbage',
        creditedBy: OPERATOR,
      }});
      await expect(
        ramps.offramp({{
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('5'),
          kind: 'crypto',
          destinationRef: '0xdead',
          clientRef: 'garbage-dest',
        }}),
      ).rejects.toMatchObject({{ code: 'bank.ramp_invalid_destination' }});
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('20');
      const holds = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
      expect(holds[0]!.n).toBe(0);
    }});

    it('refuses a later withdraw when no dest was persisted', async () => {{
      await ramps.creditOnramp({{
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'dest-missing',
        creditedBy: OPERATOR,
      }});
      await expect(
        ramps.offramp({{
          offrampId: randomUUID(),
          userId: USER,
          assetId: 'USDT',
          amount: amt('5'),
          kind: 'crypto',
          clientRef: 'missing-dest',
        }}),
      ).rejects.toMatchObject({{ code: 'bank.withdraw_destination_missing' }});
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('20');
    }});

    it('loads a persisted dest so a later withdraw has a real ref', async () => {{
      await ramps.setWithdrawDestination({{ userId: USER, kind: 'crypto', ref: '{EVM}' }});
      await ramps.creditOnramp({{
        userId: USER,
        assetId: 'USDT',
        amount: amt('20'),
        kind: 'crypto',
        railRef: 'dest-persist',
        creditedBy: OPERATOR,
      }});
      const id = randomUUID();
      const row = await ramps.offramp({{
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('8'),
        kind: 'crypto',
        clientRef: 'from-store',
      }});
      expect(row.destinationRef).toBe('{EVM}');
      expect(row.status).toBe('settled');
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('12');
    }});
  }});

"""
needle = "  describe('conservation', () => {"
if needle not in t:
    raise SystemExit("conservation describe missing")
t = t.replace(needle, insert + needle)
p.write_text(t)
print("patched ramps.test")

patch("services/svc-bank/src/ramps/ramps.reachable.test.ts", [
    ("destinationRef: '0xdest'", f"destinationRef: '{EVM}'"),
    (
        "TRUNCATE bank.ramp_offramps, bank.ramp_onramps RESTART IDENTITY CASCADE",
        "TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE",
    ),
])
patch("services/svc-bank/src/ramps/ramps-fiat-product.test.ts", [
    ("destinationRef: 'IBAN-PUBLIC-DOOR'", f"destinationRef: '{IBAN}'"),
    (
        "TRUNCATE bank.ramp_offramps, bank.ramp_onramps RESTART IDENTITY CASCADE",
        "TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE",
    ),
])
patch("services/svc-bank/src/promise-falsify-public-doors.test.ts", [
    (
        "TRUNCATE bank.ramp_onramps, bank.ramp_offramps RESTART IDENTITY CASCADE",
        "TRUNCATE bank.ramp_onramps, bank.ramp_offramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE",
    ),
])
patch("services/svc-bank/src/bank-service.test.ts", [
    (
        "bank.ramp_offramps, bank.ramp_onramps",
        "bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations",
    ),
])
print("all patches applied")
