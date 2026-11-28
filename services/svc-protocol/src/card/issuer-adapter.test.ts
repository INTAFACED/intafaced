import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadArtifact } from '../chain/artifacts.js';
import { buildKillCalldata, buildPullExactCalldata, ISSUER_SECRET_ENV, refuseIssuerSecrets } from './issuer-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const ifaceSrc = readFileSync(join(here, '..', '..', 'contracts/interfaces/ICardPull.sol'), 'utf8');
const pullSrc = readFileSync(join(here, '..', '..', 'contracts/card/CardPull.sol'), 'utf8');

describe('S-E3 CardIssuer on-chain adapter — no keys', () => {
  it('CardPull implements ICardPull and ICardPull has no issuer-key surface', () => {
    expect(pullSrc).toMatch(/contract CardPull is ICardPull/);
    expect(ifaceSrc).toMatch(/function pullExact\(uint256 amount\)/);
    expect(ifaceSrc).not.toMatch(/function\s+pause/);
    expect(ifaceSrc).not.toMatch(/privateKey|mnemonic|issuerKey/i);
  });

  it('CardPull ABI covers the ICardPull selectors', () => {
    const names = loadArtifact('CardPull')
      .abi.filter((item) => item.type === 'function')
      .map((item) => item.name);
    for (const fn of ['owner', 'token', 'settlement', 'killed', 'pullExact', 'setSettlement', 'kill']) {
      expect(names, `missing ${fn}`).toContain(fn);
    }
  });

  it('builds pullExact / kill calldata without a key', () => {
    const pull = buildPullExactCalldata(1n);
    expect(pull.startsWith('0x')).toBe(true);
    expect(buildKillCalldata().startsWith('0x')).toBe(true);
  });

  it('refuses a zero amount (no invent)', () => {
    expect(() => buildPullExactCalldata(0n)).toThrow('card.bad_amount');
  });

  it('refuses issuer secret env keys', () => {
    expect(() => refuseIssuerSecrets({ ISSUER_PRIVATE_KEY: '0xabc' })).toThrow('card.issuer_key_forbidden');
    refuseIssuerSecrets({});
    expect(ISSUER_SECRET_ENV.length).toBeGreaterThan(0);
    for (const key of ISSUER_SECRET_ENV) {
      expect(() => refuseIssuerSecrets({ [key]: 'set' }), key).toThrow('card.issuer_key_forbidden');
    }
  });

  it('reads no process env at import or in any export, and builds the same calldata whatever the env holds', async () => {
    const before = [buildPullExactCalldata(7n), buildKillCalldata()];
    // Every read of process.env (a key, `in`, or a listing) while the module loads fresh and each export runs.
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy(realEnv, {
      get: (target, key, receiver) => (reads.push(`get ${String(key)}`), Reflect.get(target, key, receiver)),
      has: (target, key) => (reads.push(`has ${String(key)}`), Reflect.has(target, key)),
      ownKeys: (target) => (reads.push('ownKeys'), Reflect.ownKeys(target)),
      getOwnPropertyDescriptor: (target, key) => (reads.push(`descriptor ${String(key)}`), Reflect.getOwnPropertyDescriptor(target, key)),
    });
    for (const key of ISSUER_SECRET_ENV) realEnv[key] = '0x' + 'ab'.repeat(32);
    try {
      vi.resetModules();
      const adapter = await import('./issuer-adapter.js');
      // Each export, called: a new export has to be added here, so none goes unchecked.
      const calls: Record<string, () => unknown> = {
        ISSUER_SECRET_ENV: () => adapter.ISSUER_SECRET_ENV,
        refuseIssuerSecrets: () => adapter.refuseIssuerSecrets({}),
        buildPullExactCalldata: () => adapter.buildPullExactCalldata(7n),
        buildKillCalldata: () => adapter.buildKillCalldata(),
      };
      expect(Object.keys(adapter).sort()).toEqual(Object.keys(calls).sort());
      const answers = Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, call()]));
      expect(reads).toEqual([]);
      expect([answers.buildPullExactCalldata, answers.buildKillCalldata]).toEqual(before);
    } finally {
      process.env = realEnv;
      for (const key of ISSUER_SECRET_ENV) delete realEnv[key];
    }
  });
});
