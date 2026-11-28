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

  it('builds the same calldata whatever the process env holds: it reads no key from it', () => {
    const before = [buildPullExactCalldata(7n), buildKillCalldata()];
    for (const key of ISSUER_SECRET_ENV) vi.stubEnv(key, '0x' + 'ab'.repeat(32));
    try {
      expect([buildPullExactCalldata(7n), buildKillCalldata()]).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
