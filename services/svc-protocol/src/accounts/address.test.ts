import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, concat, slice, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { PROTOCOL_DEFAULT_USER_SALT } from '@intafaced/contracts/protocol-procedures';
import {
  accountSalt,
  computeAccountAddress,
  DEFAULT_USER_SALT,
  minimalProxyInitCode,
  MINIMAL_PROXY_LENGTH_BYTES,
  AddressDerivationError,
} from './address.js';

const FACTORY: Address = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION: Address = '0x2222222222222222222222222222222222222222';
const OWNER: Address = '0x3333333333333333333333333333333333333333';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '..', '..', 'contracts');

describe('deterministic address derivation (§17.4)', () => {
  it('builds a 55-byte EIP-1167 creation code with the implementation in the middle', () => {
    const initCode = minimalProxyInitCode(IMPLEMENTATION);
    expect((initCode.length - 2) / 2).toBe(MINIMAL_PROXY_LENGTH_BYTES);
    expect(initCode.toLowerCase()).toContain(IMPLEMENTATION.slice(2).toLowerCase());
    expect(initCode.startsWith('0x3d602d80600a3d3981f3363d3d373d3d3d363d73')).toBe(true);
    expect(initCode.endsWith('5af43d82803e903d91602b57fd5bf3')).toBe(true);
  });

  it('matches the CREATE2 rule computed independently', () => {
    // Recomputed here by hand rather than by calling the same helper, so this
    // test would fail if `computeAccountAddress` drifted to a different rule.
    const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [OWNER, DEFAULT_USER_SALT]));
    const initCodeHash = keccak256(minimalProxyInitCode(IMPLEMENTATION));
    const expected = getAddress(slice(keccak256(concat(['0xff', FACTORY, salt, initCodeHash])), 12) as Hex);

    expect(computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: OWNER })).toBe(expected);
  });

  it('is deterministic: the same inputs always give the same address', () => {
    const a = computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: OWNER });
    const b = computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: OWNER });
    expect(a).toBe(b);
    // Pinned. If a refactor changes this string, an address a user was shown
    // has moved, and that is a funds-stranding bug, not a formatting change.
    expect(a).toBe('0x8C517F9BAae6BC080CC08F572E86945B8ca49f3f');
  });

  it('binds the owner into the salt, so two owners never share an address', () => {
    const other: Address = '0x4444444444444444444444444444444444444444';
    expect(accountSalt(OWNER)).not.toBe(accountSalt(other));
    expect(computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: OWNER })).not.toBe(
      computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: other }),
    );
  });

  it('gives one owner distinct accounts per user salt (§23 named spaces)', () => {
    const second = `0x${'00'.repeat(31)}01` as Hex;
    expect(computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: OWNER })).not.toBe(
      computeAccountAddress({
        factory: FACTORY,
        implementation: IMPLEMENTATION,
        owner: OWNER,
        userSalt: second,
      }),
    );
  });

  it('changes with the implementation — a different code base is a different account', () => {
    const otherImpl: Address = '0x5555555555555555555555555555555555555555';
    expect(computeAccountAddress({ factory: FACTORY, implementation: IMPLEMENTATION, owner: OWNER })).not.toBe(
      computeAccountAddress({ factory: FACTORY, implementation: otherImpl, owner: OWNER }),
    );
  });

  it('refuses malformed input rather than deriving a plausible wrong address', () => {
    expect(() => computeAccountAddress({ factory: 'not-an-address' as Address, implementation: IMPLEMENTATION, owner: OWNER })).toThrow(
      AddressDerivationError,
    );

    expect(() =>
      computeAccountAddress({
        factory: FACTORY,
        implementation: IMPLEMENTATION,
        owner: OWNER,
        userSalt: '0xdeadbeef' as Hex,
      }),
    ).toThrow(AddressDerivationError);
  });
});

describe('the Solidity factory derives it the same way', () => {
  const source = readFileSync(join(contractsDir, 'AccountFactory.sol'), 'utf8');

  // Without a Solidity compiler in this toolchain (§13 socket
  // `socket.contract-toolchain`), these assertions are what keeps the two
  // derivations from silently diverging: they pin the exact byte constants the
  // assembly writes against the ones TypeScript concatenates.
  it('uses the same EIP-1167 prefix constant', () => {
    expect(source).toContain('0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000');
  });

  it('uses the same EIP-1167 suffix constant', () => {
    expect(source).toContain('0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000');
  });

  it('hashes 0x37 (55) bytes of creation code, as the TypeScript side does', () => {
    expect(source).toContain('create2(0, ptr, 0x37, salt)');
    expect(source).toContain('keccak256(ptr, 0x37)');
  });

  it('binds the owner into the salt', () => {
    expect(source).toContain('keccak256(abi.encode(owner, userSalt))');
  });
});

describe('DEFAULT_USER_SALT', () => {
  it('is the record default, kept literal so the dev deploy script loads before any package build', () => {
    expect(DEFAULT_USER_SALT).toBe(PROTOCOL_DEFAULT_USER_SALT);
  });
});
