#!/usr/bin/env python3
"""One-shot: wire PayService crypto payout to stored EVM dest. Dest store already on branch."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def patch(rel: str, replacements: list[tuple[str, str]]) -> None:
    path = ROOT / rel
    text = path.read_text()
    for old, new in replacements:
        if old not in text:
            raise SystemExit(f'missing needle in {rel}: {old[:80]!r}')
        text = text.replace(old, new, 1)
    path.write_text(text)
    print('patched', rel)


patch(
    'services/svc-pay/src/payment-service.ts',
    [
        (
            "import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';\n",
            "import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';\nimport {\n  assertOnlyPayoutDestinations,\n  PayoutDestinationMissingError,\n  type MerchantPayoutDestinations,\n} from './merchant-payout-destination.js';\n",
        ),
        (
            "  | 'pay.destination_kind_mismatch'\n  | 'pay.invalid_destination_ref'\n",
            "  | 'pay.destination_kind_mismatch'\n  | 'pay.invalid_destination_ref'\n  /** Crypto payout has no stored EVM dest — refused BEFORE withdrawHold. */\n  | 'pay.payout_destination_missing'\n",
        ),
        (
            "  readonly affiliateAccrue?: AffiliateAccruePort;\n}\n",
            "  readonly affiliateAccrue?: AffiliateAccruePort;\n\n  /**\n   * Persisted merchant payout destinations. Crypto-native payout requires a\n   * stored EVM dest before withdrawHold. Default refuses closed (no invented ref).\n   */\n  readonly payoutDestinations?: MerchantPayoutDestinations;\n}\n",
        ),
        (
            "  private readonly affiliateAccrue: AffiliateAccruePort;\n",
            "  private readonly affiliateAccrue: AffiliateAccruePort;\n  private readonly payoutDestinations: MerchantPayoutDestinations;\n",
        ),
        (
            "    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();\n  }\n",
            "    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();\n    this.payoutDestinations = options.payoutDestinations ?? assertOnlyPayoutDestinations();\n  }\n",
        ),
        (
            "    destination: { kind: string; ref: string };\n  }): Promise<SettlementRecord> {",
            "    destination?: { kind: string; ref: string };\n  }): Promise<SettlementRecord> {",
        ),
        (
            """        const merchant = await this.getMerchant(settlement.merchantId);

        // Destination kind must match the rail BEFORE any hold posts. Crypto
        // used to accept kind:'bank' + an IBAN and hand it to chain.send —
        // MemoryChain would "succeed"; live EVM would fail after the hold.
        try {
          assertPayoutDestinationKind(adapter.id, input.destination);
        } catch (err) {
          if (err instanceof DestinationKindError) {
            throw new PayError(err.message, err.code);
          }
          throw err;
        }
""",
            """        const merchant = await this.getMerchant(settlement.merchantId);

        // Crypto-native pays the stored EVM dest. Refuse if none stored —
        // BEFORE withdrawHold. Caller dest is persisted first, then required.
        // Other rails still take the caller dest. Does not live-wire bank-payout.
        const destination = await this.resolvePayoutDestination(adapter.id, merchant.id, input.destination);
""",
        ),
        (
            "          destinationKind: input.destination.kind,\n",
            "          destinationKind: destination.kind,\n",
        ),
        (
            "            destination: input.destination,\n",
            "            destination,\n",
        ),
        (
            "  async getSettlement(settlementId: string): Promise<SettlementRecord> {",
            """  /**
   * Crypto-native: persist offered dest (if any), then require the stored EVM
   * dest. Refuse closed if none stored. Other rails: caller dest + kind gate.
   * Does not invent a PSP. Does not live-wire bank-payout.
   */
  private async resolvePayoutDestination(
    railId: string,
    merchantId: string,
    offered?: { kind: string; ref: string },
  ): Promise<{ kind: string; ref: string }> {
    if (railId === 'crypto-native') {
      try {
        if (offered) {
          await this.payoutDestinations.persist({
            merchantId,
            railId,
            kind: offered.kind,
            ref: offered.ref,
          });
        }
        const stored = await this.payoutDestinations.require({ merchantId, railId });
        assertPayoutDestinationKind(railId, stored);
        return stored;
      } catch (err) {
        if (err instanceof PayoutDestinationMissingError) {
          throw new PayError(err.message, 'pay.payout_destination_missing', { merchantId, railId });
        }
        if (err instanceof DestinationKindError) {
          throw new PayError(err.message, err.code);
        }
        throw err;
      }
    }

    if (!offered) {
      throw new PayError(
        `Merchant ${merchantId} has no payout destination for rail ${railId}`,
        'pay.payout_destination_missing',
        { merchantId, railId },
      );
    }
    try {
      assertPayoutDestinationKind(railId, offered);
    } catch (err) {
      if (err instanceof DestinationKindError) {
        throw new PayError(err.message, err.code);
      }
      throw err;
    }
    return offered;
  }

  async getSettlement(settlementId: string): Promise<SettlementRecord> {""",
        ),
    ],
)

patch(
    'services/svc-pay/src/index.ts',
    [
        (
            "const pay = new PayService(sql, ledger, rails, {\n  defaultFeeBps: env.PAY_DEFAULT_FEE_BPS,\n",
            "const payoutDestinations = new MerchantPayoutDestinationStore(sql);\nconst pay = new PayService(sql, ledger, rails, {\n  payoutDestinations,\n  defaultFeeBps: env.PAY_DEFAULT_FEE_BPS,\n",
        ),
        (
            "  createPayRouter(pay, rails, userMoney, subMerchants, new MerchantPayoutDestinationStore(sql)),",
            "  createPayRouter(pay, rails, userMoney, subMerchants, payoutDestinations),",
        ),
    ],
)

patch(
    'services/svc-pay/src/router.ts',
    [
        (
            "      case 'pay.routing_no_rail':\n        return 'PRECONDITION_FAILED' as const;\n",
            "      case 'pay.routing_no_rail':\n      case 'pay.payout_destination_missing':\n        return 'PRECONDITION_FAILED' as const;\n",
        )
    ],
)

patch(
    'services/svc-pay/src/payment-service.test.ts',
    [
        (
            "import { PayService, PayError, type PaymentView } from './payment-service.js';\n",
            "import { PayService, PayError, type PaymentView } from './payment-service.js';\nimport { memoryPayoutDestinations } from './merchant-payout-destination.js';\n",
        ),
        (
            "  let pay: PayService;\n",
            "  let pay: PayService;\n  let dests: ReturnType<typeof memoryPayoutDestinations>;\n",
        ),
        (
            "    pay = new PayService(sql, ledger, rails, { checkoutRiskBand: 'low' });\n",
            "    dests = memoryPayoutDestinations();\n    pay = new PayService(sql, ledger, rails, { checkoutRiskBand: 'low', payoutDestinations: dests });\n",
        ),
        (
            """      expect(chain.outboundTransfers()).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });
""",
            """      expect(chain.outboundTransfers()).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses crypto payout when no EVM dest is stored — nothing held', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '9');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-no-dest');
      const journalBefore = ledger.journal().map((tx) => tx.idempotencyKey);

      await expect(
        pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' }),
      ).rejects.toMatchObject({ code: 'pay.payout_destination_missing' });

      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(await availableOf(MERCHANT_USER)).toBe('9');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
      expect(chain.totalSent('USDT')).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('pays crypto to the stored EVM dest through ledger-client', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '11');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-stored');
      await dests.persist({
        merchantId: m.id,
        railId: 'crypto-native',
        kind: 'crypto',
        ref: '0x000000000000000000000000000000000000dEaD',
      });

      const paid = await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' });
      expect(paid.status).toBe('paid_out');
      expect(chain.totalSent('USDT')).toBe('11');
      expect(chain.outboundTransfers()[0]?.to).toBe('0x000000000000000000000000000000000000dEaD');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });
""",
        ),
    ],
)

print('wired')
