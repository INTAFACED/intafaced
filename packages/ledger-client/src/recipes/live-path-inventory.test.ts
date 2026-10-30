/**
 * D26-P2-11 — Ledger recipe matrix closed for live paths.
 *
 * Done bar: every money path → named recipe or explicit §13.
 * Executed inventory tests (not a docs tip-bump): build the matrix, pin
 * live/socket partitions, prove socket recipes still conserve on MemoryLedger,
 * and scan services/ so a socket cannot silently gain a production caller
 * (or a live proof go missing) without this suite turning red.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, insuranceFund, marketMaker, orderHoldAccount, railBoundary, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { recipes, type RecipeName } from './index.js';
import { RECIPE_MATRIX, buildRecipeMatrixInventory, countByKind, liveRecipeKeys, socketRecipeKeys } from './live-path-inventory.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const repoRoot = join(packageRoot, '..', '..');

/** Stable pin for socket reasons — same 12-hex shape as event-wiring. */
function reasonFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Collect `recipes.<name>` references from production (non-test) TypeScript under services/. */
function scanProductionRecipeCallers(): Map<string, string[]> {
  const servicesRoot = join(repoRoot, 'services');
  const found = new Map<string, string[]>();
  if (!existsSync(servicesRoot)) return found;

  const stack = [servicesRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (ent === 'node_modules' || ent === 'dist' || ent === 'coverage') continue;
        stack.push(full);
        continue;
      }
      if (!ent.endsWith('.ts') || ent.endsWith('.test.ts') || ent.endsWith('.d.ts')) continue;
      // Comments are not callers. `length`/`has` are Array/Set methods on a local.
      const src = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const rel = relative(repoRoot, full).replace(/\\/g, '/');
      for (const match of src.matchAll(/\brecipes\.([A-Za-z][A-Za-z0-9]*)\b/g)) {
        const name = match[1]!;
        if (name === 'length' || name === 'has') continue;
        const list = found.get(name) ?? [];
        if (!list.includes(rel)) list.push(rel);
        found.set(name, list);
      }
    }
  }
  return found;
}

/** Frozen 12-hex digests. Editing a socket reason must change reasonFingerprint(row.reason) and fail the pin. */
const PINNED_SOCKETS: readonly { name: RecipeName; fingerprint: string }[] = [
  { name: 'marketMakerSeedFund', fingerprint: 'f0ed307f9c4c' },
  { name: 'tradeFillFeeCorrection', fingerprint: '1948c544d9f1' },
  { name: 'orderHoldAmend', fingerprint: 'eb8454c78c05' },
  { name: 'marketListingFee', fingerprint: 'c6b5159bbd35' },
  { name: 'marketPremiumPlacement', fingerprint: 'ef52f37a4786' },
  { name: 'buybackOrderHold', fingerprint: '30408fba090e' },
  { name: 'buybackOrderHoldRelease', fingerprint: '10956b0267e4' },
  { name: 'buybackTakerFill', fingerprint: 'feb69e826223' },
  { name: 'payReceivedHold', fingerprint: 'd38b34fa6dff' },
  { name: 'payReceivedRelease', fingerprint: '7d6896cf46f5' },
  { name: 'payReceivedReturn', fingerprint: '8ccf8023ca20' },
  { name: 'bankTransferReversal', fingerprint: '56a8770216cd' },
];

/**
 * S2S `/trpc/post` catalog (`services/svc-ledger/src/recipe-gate.ts`) samples
 * every registry recipe to freeze (module, reason, legs) signatures. It never
 * `ledger.post` — not a second chargeback door (or any money writer).
 * `chargeback-ledger.ts` posts `chargebackOpen`, `chargebackShortfall`,
 * `chargebackWon`, and `chargebackShortfallRecovered`.
 */
const RECIPE_GATE_CATALOG = 'services/svc-ledger/src/recipe-gate.ts';

const SOCKET_CALLER_ALLOWLIST: ReadonlyMap<RecipeName, readonly string[]> = new Map([
  ['marketMakerSeedFund', [RECIPE_GATE_CATALOG]],
  ['tradeFillFeeCorrection', [RECIPE_GATE_CATALOG]],
  ['orderHoldAmend', [RECIPE_GATE_CATALOG]],
  ['marketListingFee', [RECIPE_GATE_CATALOG]],
  ['marketPremiumPlacement', [RECIPE_GATE_CATALOG]],
  ['buybackOrderHold', [RECIPE_GATE_CATALOG]],
  ['buybackOrderHoldRelease', [RECIPE_GATE_CATALOG]],
  ['buybackTakerFill', [RECIPE_GATE_CATALOG]],
  ['payReceivedHold', [RECIPE_GATE_CATALOG]],
  ['payReceivedRelease', [RECIPE_GATE_CATALOG]],
  ['payReceivedReturn', [RECIPE_GATE_CATALOG]],
  ['bankTransferReversal', [RECIPE_GATE_CATALOG]],
]);

describe('D26-P2-11 recipe matrix inventory (live path closure)', () => {
  const inventory = buildRecipeMatrixInventory();

  it('covers every registry key exactly once with no broken promises', () => {
    expect(inventory.brokenPromises).toEqual([]);
    expect(inventory.recipes).toEqual(Object.keys(recipes).sort());
    expect(inventory.rows).toHaveLength(Object.keys(recipes).length);
    expect(inventory.live.length + inventory.sockets.length).toBe(inventory.recipes.length);
  });

  it('pins live vs §13 socket counts on tip (88 = 76 live + 12 socket)', () => {
    const counts = countByKind(inventory);
    expect(counts).toEqual({ live: 76, socket: 12 });
    expect(inventory.recipes).toHaveLength(88);
    expect(liveRecipeKeys(inventory)).toHaveLength(76);
    expect(socketRecipeKeys(inventory)).toEqual(PINNED_SOCKETS.map((s) => s.name).sort());
  });

  it('every socket row is explicit §13 with a pinned reason fingerprint', () => {
    for (const { name, fingerprint } of PINNED_SOCKETS) {
      const row = RECIPE_MATRIX[name];
      expect(row.kind).toBe('socket');
      if (row.kind !== 'socket') continue;
      expect(row.socket).toBe('§13');
      expect(row.reason.length).toBeGreaterThan(40);
      expect(row.reason).toMatch(/§13/);
      expect(reasonFingerprint(row.reason)).toBe(fingerprint);
    }
  });

  it('every live row names a real proof file under services/', () => {
    for (const name of inventory.live) {
      const row = RECIPE_MATRIX[name];
      expect(row.kind).toBe('live');
      if (row.kind !== 'live') continue;
      const abs = join(repoRoot, row.proof);
      expect(existsSync(abs), `${name} proof missing: ${row.proof}`).toBe(true);
      const body = readFileSync(abs, 'utf8');
      expect(body, `${name} proof does not reference recipes.${name}`).toMatch(new RegExp(`\\brecipes\\.${name}\\b`));
    }
  });

  it('production scan: live recipes have callers; socket callers stay explicitly allowlisted', () => {
    const callers = scanProductionRecipeCallers();
    for (const name of inventory.live) {
      expect(callers.has(name), `live recipe ${name} has no production caller`).toBe(true);
    }
    for (const name of inventory.sockets) {
      expect([...(callers.get(name) ?? [])].sort(), `socket recipe ${name} has an unexpected production caller`).toEqual(
        [...(SOCKET_CALLER_ALLOWLIST.get(name) ?? [])].sort(),
      );
    }
    // No production caller outside the matrix (would mean a hand-named recipe).
    for (const name of callers.keys()) {
      expect(inventory.recipes, `unknown production recipes.${name}`).toContain(name);
    }
  });
});

describe('D26-P2-11 executed MemoryLedger for §13 socket recipes', () => {
  let ledger: MemoryLedger;
  const USER = '11111111-1111-4111-8111-111111111111';
  const MERCHANT = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    ledger = new MemoryLedger();
  });

  it('marketMakerSeedFund conserves (socket — ops seed door)', async () => {
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('100'), seedId: 'd26-mm' }));
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(railBoundary('mm-seed', 'USDT'))).amount)).toBe('-100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futuresMarginAdd conserves (live — isolated re-leverage extra lock)', async () => {
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('200'), rail: 'test', railRef: 'd26-add' }));
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-1', userId: USER, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(recipes.futuresMarginAdd({ positionId: 'pos-1', userId: USER, assetId: 'USDT', amount: amt('50'), sequence: 1 }));
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('orderHoldAmend conserves (socket — qty-up extra hold, same pot as orderHold)', async () => {
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('200'), rail: 'test', railRef: 'd26-amend' }));
    await ledger.post(recipes.orderHold({ orderId: 'o-1', userId: USER, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(recipes.orderHoldAmend({ orderId: 'o-1', userId: USER, assetId: 'USDT', amount: amt('50'), sequence: 1 }));
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');
    expect(formatAmount((await ledger.balance(orderHoldAccount(USER, 'USDT', 'o-1'))).amount)).toBe('150');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('futuresInsuranceTopup conserves (live — the trade operator desk top-up door)', async () => {
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('80'), rail: 'test', railRef: 'd26-ins' }));
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'd26-fee',
        userId: USER,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('80'),
      }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: 'd26-top', assetId: 'USDT', amount: amt('80') }));
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('80');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('chargebackOpen + shortfall conserves (live — svc-pay chargeback-ledger)', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-d26',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'card-sandbox',
        railRef: 'ch_d26',
      }),
    );
    // Seed insurance so shortfall has a pot (same pattern as chargeback.test.ts).
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'test', railRef: 'd26-cb-ins' }));
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'd26-cb-fee',
        userId: USER,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('40'),
      }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: 'd26-cb-top', assetId: 'USDT', amount: amt('40') }));

    await ledger.post(
      recipes.chargebackOpen({
        disputeId: 'disp-1',
        paymentId: 'pay-d26',
        merchantId: MERCHANT,
        merchantUserId: USER,
        assetId: 'USDT',
        fromClearing: amt('60'),
        fromMerchantBalance: amt('0'),
        rail: 'card-sandbox',
      }),
    );
    await ledger.post(
      recipes.chargebackShortfall({
        disputeId: 'disp-1',
        paymentId: 'pay-d26',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
      }),
    );
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('marketListingFee conserves (socket — D26-P1-M2 vendor fee)', async () => {
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('25'), rail: 'test', railRef: 'd26-list' }));
    await ledger.post(
      recipes.marketListingFee({
        listingId: 'listing-d26',
        vendorUserId: USER,
        assetId: 'USDT',
        amount: amt('25'),
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('25');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('marketPremiumPlacement conserves (socket — D26-P1-M2 placement fee)', async () => {
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('15'), rail: 'test', railRef: 'd26-prem' }));
    await ledger.post(
      recipes.marketPremiumPlacement({
        placementId: 'place-d26',
        listingId: 'listing-d26',
        vendorUserId: USER,
        assetId: 'USDT',
        amount: amt('15'),
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('15');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
