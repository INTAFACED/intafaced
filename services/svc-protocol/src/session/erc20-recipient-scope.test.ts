/**
 * Unit card — a session key cannot route pool-swap output to a stranger
 *
 * 1. Promise: a session granted a pool-swap selector can only swap for the
 *    account that granted it.
 * 2. Break: scope checked target, selector and native value only; swapExactIn's
 *    `to` was never read, so with the owner's ERC20 allowance in place a
 *    compromised key could swap the whole balance at minOut 0 to itself.
 * 3. Done bar: swapExactIn (pool and router) and every other call that names a
 *    recipient is refused when the recipient is not the account, and when the
 *    calldata ends before the recipient; a call to the account itself is
 *    allowed. SessionKeyLib enforces the same rule (spec.test.ts pins the
 *    selectors and offsets to the Solidity source; test/forge/SessionKey.t.sol
 *    runs it).
 * 4. Class M
 * 5. Paths: services/svc-protocol/src/session/spec.ts, contracts/SessionKeyLib.sol
 * 6. RED on 94403f7a: foreign recipient, minOut 0 → allowed "Within session scope"
 *
 * Also here: the router's `pool` argument must be one of the session's targets
 * (a fake pool takes the account's approved tokens while `to` is the account),
 * and every non-view function in the compiled ABIs with an address input is
 * classified (recipient-scoped, must-be-target, forbidden, or exempt with a
 * reason).
 *
 * Not in this card: an owner-chosen ERC20 amount cap (a spec-format change; a
 * separate follow-up).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbiItem, toFunctionSelector } from 'viem';
import type { Abi, AbiFunction, AbiParameter, Address, Hex } from 'viem';
import { buildSwapExactIn } from '../amm/build.js';
import {
  createSessionSpec,
  evaluateSessionCall,
  FORBIDDEN_SIGNATURES,
  readSwapExactInCall,
  isOutboundTransferSelector,
  RECIPIENT_OFFSETS,
  RECIPIENT_SCOPED_CALLS,
  SessionScopeError,
  TARGET_ARG_CALLS,
  TARGET_ARG_OFFSETS,
} from './spec.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const KEY = '0x5555555555555555555555555555555555555555';
const ROUTER = '0x6666666666666666666666666666666666666666';
const NOW = 1_000_000;

function specFor(selectors: Hex[], target: Address = POOL, extraTargets: Address[] = []) {
  return createSessionSpec(
    { key: KEY, validAfter: 0, validUntil: NOW + 1000, spendLimitWei: '0', targets: [target, ...extraTargets], selectors },
    { account: ACCOUNT, now: NOW },
  );
}

/** Router calls need the pool they name in the session's targets; direct pool calls do not. */
function decide(data: Hex, target: Address = POOL, account: Address = ACCOUNT, extraTargets: Address[] = target === ROUTER ? [POOL] : []) {
  const selector = data.slice(0, 10) as Hex;
  // Recipient tests are not slippage tests. A positive minAmountOut is placed
  // exactly on a zero-tolerance floor so the swap is bounded; minAmountOut 0
  // stays unbounded and is refused by the spec.
  const parsed = readSwapExactInCall(data);
  const swapBound =
    parsed && parsed !== 'truncated' && parsed.minAmountOut > 0n ? { quoteOut: parsed.minAmountOut, slippageBps: 0 } : undefined;
  return evaluateSessionCall({
    spec: specFor([selector], target, extraTargets),
    account,
    target,
    value: 0n,
    data,
    spentWei: 0n,
    now: NOW,
    ...(swapBound ? { swapBound } : {}),
  });
}

function routerSwap(to: Address, minAmountOut = 1n): Hex {
  return encodeFunctionData({
    abi: [parseAbiItem('function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)')],
    args: [POOL, TOKEN, 1_000_000_000n, minAmountOut, to],
  });
}

/** Calldata for any listed signature: `recipient` in the recipient slot, POOL in other address slots (a session target), 7 in every uint. */
function callFor(signature: string, recipientArg: number, recipient: Address): Hex {
  const item = parseAbiItem(`function ${signature}`) as AbiFunction;
  const args = item.inputs.map((input: AbiParameter, i: number) => (i === recipientArg ? recipient : input.type === 'address' ? POOL : 7n));
  return encodeFunctionData({ abi: [item] as Abi, args });
}

describe('session scope for pool swaps', () => {
  it('refuses a swap whose output goes to someone other than the account', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1_000_000_000n, 0n, STRANGER);
    const spec = specFor([call.data.slice(0, 10) as Hex]);
    const decision = evaluateSessionCall({ spec, account: ACCOUNT, target: POOL, value: 0n, data: call.data, spentWei: 0n, now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.recipient_not_account');
  });

  it('allows a swap whose output comes back to the account', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1_000_000_000n, 1n, ACCOUNT);
    const decision = decide(call.data);
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('allowed');
  });

  it('matches the account regardless of address casing', () => {
    const account = getAddress('0xabcdef0123456789abcdef0123456789abcdef01');
    const call = buildSwapExactIn(POOL, TOKEN, 1n, 1n, account);
    expect(decide(call.data, POOL, account).allowed).toBe(true);
    expect(decide(call.data, POOL, account.toLowerCase() as Address).allowed).toBe(true);
    expect(decide(call.data, POOL, `0x${account.slice(2).toUpperCase()}` as Address).allowed).toBe(true);
  });

  it('refuses the zero address as the recipient', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1n, 0n, '0x0000000000000000000000000000000000000000');
    expect(decide(call.data).code).toBe('session.recipient_not_account');
  });
});

describe('session scope for the router swap', () => {
  it('refuses a router swap to a stranger', () => {
    const decision = decide(routerSwap(STRANGER), ROUTER);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.recipient_not_account');
  });

  it('allows a router swap to the account', () => {
    expect(decide(routerSwap(ACCOUNT), ROUTER).allowed).toBe(true);
  });

  it('does not mistake the router pool argument for the recipient', () => {
    // swapExactIn(pool, tokenIn, ..., to): ACCOUNT as the pool and STRANGER as `to` is still refused.
    const data = encodeFunctionData({
      abi: [parseAbiItem('function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)')],
      args: [ACCOUNT, ACCOUNT, 1n, 0n, STRANGER],
    });
    expect(decide(data, ROUTER).code).toBe('session.recipient_not_account');
  });
});

describe('the router only routes through pools the session may call', () => {
  // The review PoC: recipient == account passes the recipient rule, but the pool
  // is an attacker contract that takes the account's approved tokens.
  const FAKE_POOL = '0x7777777777777777777777777777777777777777';
  const fakePoolSwap = (to: Address) =>
    encodeFunctionData({
      abi: [parseAbiItem('function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)')],
      args: [FAKE_POOL, TOKEN, 1_000_000_000n, 1n, to],
    });

  it('refuses a router swap through a pool that is not one of the targets, even with the account as recipient', () => {
    const decision = decide(fakePoolSwap(ACCOUNT), ROUTER);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.target_arg_not_allowed');
  });

  it('allows it once the owner has put that pool in the session targets', () => {
    expect(decide(fakePoolSwap(ACCOUNT), ROUTER, ACCOUNT, [FAKE_POOL]).allowed).toBe(true);
  });

  it('refuses the router itself and the zero address as the pool unless they are targets', () => {
    for (const pool of [ROUTER, '0x0000000000000000000000000000000000000000'] as Address[]) {
      const data = encodeFunctionData({
        abi: [parseAbiItem('function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)')],
        args: [pool, TOKEN, 1n, 1n, ACCOUNT],
      });
      // ROUTER is the session target, so it is allowed as the pool arg; zero is not.
      expect(decide(data, ROUTER).code).toBe(pool === ROUTER ? 'allowed' : 'session.target_arg_not_allowed');
    }
  });

  it('refuses a pool word with dirty high bytes even when its low 20 bytes are a target', () => {
    const clean = routerSwap(ACCOUNT);
    const dirty = `${clean.slice(0, 10)}ff${clean.slice(12)}` as Hex;
    expect(decide(dirty, ROUTER).code).toBe('session.target_arg_not_allowed');
  });

  it('refuses calldata that ends before the pool word', () => {
    expect(decide('0x7b32b50e' as Hex, ROUTER).code).toBe('session.recipient_calldata_too_short');
    // The recipient check runs first; a router call truncated inside the pool word is refused by it too.
    expect(decide(routerSwap(ACCOUNT).slice(0, 10 + 40) as Hex, ROUTER).code).toBe('session.recipient_calldata_too_short');
  });

  it('keeps the offset table in step with the list', () => {
    for (const { signature, targetArg } of TARGET_ARG_CALLS) {
      expect(TARGET_ARG_OFFSETS.get(toFunctionSelector(signature).toLowerCase() as Hex)).toBe(4 + 32 * targetArg);
    }
  });
});

describe('protocol calls that pay out or hand over control cannot be put in a session', () => {
  const SELECTORS: Record<string, string> = {
    'open(address,address,uint128,address,address,uint16,uint32,uint8)': '0x492284ae',
    'lock(uint256)': '0xdd467064',
    'release(uint256)': '0x37bdc99b',
    'dispute(uint256)': '0x86d6282c',
    'approveSpend(uint256)': '0xad453b6f',
  };

  it.each(Object.entries(SELECTORS))('refuses to build a session that can call %s (%s)', (signature, selector) => {
    expect(toFunctionSelector(signature)).toBe(selector);
    expect(FORBIDDEN_SIGNATURES).toContain(signature);
    try {
      specFor([selector as Hex]);
      throw new Error('a session was built with a payout selector');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionScopeError);
      expect((err as SessionScopeError).code).toBe('session.outbound_transfer_forbidden');
    }
  });

  it('keeps escrow refund and settleTimeout allowed, for the reasons written here', () => {
    // refund(uint256): seller-only (msg.sender == deal.seller) and returns funds to the seller, i.e. the account;
    // settleTimeout(uint256): permissionless, so a session adds no power by calling it.
    // dispute is forbidden above because it is what makes settleTimeout able to pay the buyer.
    for (const signature of ['refund(uint256)', 'settleTimeout(uint256)']) {
      expect(isOutboundTransferSelector(toFunctionSelector(signature))).toBe(false);
      expect(() => specFor([toFunctionSelector(signature)])).not.toThrow();
    }
  });

  it('also refuses it per call, if a stored spec somehow held it', () => {
    const spec = { ...specFor([toFunctionSelector('placeOrder(address,bool,uint256,uint256)')]), selectors: ['0xad453b6f' as Hex] };
    const decision = evaluateSessionCall({
      spec,
      account: ACCOUNT,
      target: POOL,
      value: 0n,
      data: '0xad453b6f' as Hex,
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.code).toBe('session.outbound_transfer_forbidden');
  });
});

describe.each(RECIPIENT_SCOPED_CALLS)('every recipient-bearing call: $signature', ({ signature, recipientArg }) => {
  it('is refused for a stranger and allowed for the account', () => {
    expect(decide(callFor(signature, recipientArg, STRANGER)).code).toBe('session.recipient_not_account');
    expect(decide(callFor(signature, recipientArg, ACCOUNT)).allowed).toBe(true);
  });

  it('is refused when the calldata ends before the recipient word', () => {
    const full = callFor(signature, recipientArg, ACCOUNT);
    const offset = 4 + 32 * recipientArg;
    // Selector only, mid-recipient (one byte short), and exactly at the end of the recipient word.
    expect(decide(full.slice(0, 10) as Hex).code).toBe('session.recipient_calldata_too_short');
    expect(decide(full.slice(0, 2 + (offset + 31) * 2) as Hex).code).toBe('session.recipient_calldata_too_short');
    expect(decide(full.slice(0, 2 + (offset + 32) * 2) as Hex).allowed).toBe(true);
  });

  it('is refused when the recipient word has dirty high bytes, even if its low 20 bytes are the account', () => {
    const full = callFor(signature, recipientArg, ACCOUNT);
    const start = 2 + (4 + 32 * recipientArg) * 2;
    const dirty = `${full.slice(0, start)}ff${full.slice(start + 2)}` as Hex;
    expect(decide(dirty).code).toBe('session.recipient_not_account');
  });

  it('keeps its offset in the lookup the evaluator uses', () => {
    expect(RECIPIENT_OFFSETS.get(toFunctionSelector(signature).toLowerCase() as Hex)).toBe(4 + 32 * recipientArg);
  });
});

describe('selectors with no recipient are unaffected', () => {
  it('still allows a bare selector of an unrelated call', () => {
    const selector = toFunctionSelector('placeOrder(address,bool,uint256,uint256)');
    expect(decide(selector as Hex).allowed).toBe(true);
  });

  it('still refuses a selector that is not allowlisted before it looks at a recipient', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1n, 0n, ACCOUNT);
    const spec = specFor([toFunctionSelector('placeOrder(address,bool,uint256,uint256)')]);
    const decision = evaluateSessionCall({ spec, account: ACCOUNT, target: POOL, value: 0n, data: call.data, spentWei: 0n, now: NOW });
    expect(decision.code).toBe('session.selector_not_allowed');
  });
});

describe('every function with an address input in the compiled contracts is classified', () => {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'out');
  const recipientListed = new Set(RECIPIENT_SCOPED_CALLS.map((c) => toFunctionSelector(c.signature).toLowerCase()));
  const targetListed = new Set(TARGET_ARG_CALLS.map((c) => toFunctionSelector(c.signature).toLowerCase()));

  type Param = AbiParameter & { components?: readonly Param[] };
  const format = (p: Param): string =>
    p.type.startsWith('tuple') ? `(${(p.components ?? []).map(format).join(',')})${p.type.slice(5)}` : p.type;
  const hasAddress = (p: Param): boolean => p.type.startsWith('address') || (p.components ?? []).some(hasAddress);

  /**
   * Functions with an address input that a session may still be given, and why
   * that is safe. Keyed `Contract.signature`. Everything else with an address
   * input is recipient-scoped, must-be-target, or in FORBIDDEN_SIGNATURES.
   */
  const EXEMPT: Record<string, string> = {
    'AccountFactory.createAccount(address,bytes32)': 'permissionless deploy; no asset of the calling account moves',
    'DeployerReputation.registerLock(address)': 'permissionless public registry; reads the beneficiary from the lock, moves nothing',
    'DeployerReputation.registerVesting(address)': 'permissionless public registry; reads the beneficiary from the vesting, moves nothing',
    'FailClosedOracle.report(address,uint256)': 'reporter-gated price feed; moves no funds',
    'IsolatedLendingMarket.liquidate(address,uint256)':
      'seized collateral is paid to msg.sender (the account); the borrower argument only picks whom to liquidate',
    'MerchantAccept.pay(address,uint256,bytes32)':
      'payout recipients are constructor-fixed (merchant, feeRecipient); amount is uncapped, which is the ERC20 spend-cap follow-up',
    'MerchantAccept.rescue(address,uint256)': 'merchant-only and pays the merchant',
    'MockERC20.mint(address,uint256)': 'test token faucet; not a deployed protocol surface',
    'TestToken.mint(address,uint256)': 'LOCAL TEST chain token faucet; not a deployed protocol surface',
    'MockERC20Dec.mint(address,uint256)': 'test token faucet; not a deployed protocol surface',
    'ReenteringBorrowToken.mint(address,uint256)': 'test fixture; not a deployed protocol surface',
    'ReenteringBorrowToken.arm(address,uint256)': 'test fixture; not a deployed protocol surface',
    'PoolFactory.createPool(address,address,uint16)': 'permissionless pool creation; no asset of the calling account moves',
    'RwaRegistry.register(address,bytes32)': 'registry entry keyed by msg.sender as issuer; moves no asset',
    'RwaRegistry.unlist(address)': 'issuer-only registry entry; moves no asset',
    'ScopedPaymaster.setAllowlisted(address,bool)': 'operator-gated paymaster policy; moves no funds',
    'ScopedPaymaster.validatePaymasterUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)':
      'EntryPoint-only; reserves the paymaster float and does not pay the userOp sender',
    'SmartAccount.initialize(address)': 'one-shot initializer; the account is never a session target (self-target is forbidden)',
    'SmartAccount.proposeOwner(address)': 'owner-only on the account; unreachable by a session (self-target is forbidden)',
    'SmartAccount.revokeSession(address)': 'account-only; unreachable by a session (self-target is forbidden)',
    'SmartAccount.execute(address,uint256,bytes)': 'account-only; unreachable by a session (self-target is forbidden)',
    'SmartAccount.executeBatch((address,uint256,bytes)[])': 'account-only; unreachable by a session (self-target is forbidden)',
    'SmartAccount.executeWithSession((address,uint48,uint48,uint128,address[],bytes4[]),address,uint256,bytes)':
      'the guarded entry itself; the scope is checked inside it',
    'SmartAccount.grantSession((address,uint48,uint48,uint128,address[],bytes4[]))':
      'owner-only; unreachable by a session (self-target is forbidden)',
    'SmartAccount.validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)':
      'EntryPoint-only; unreachable by a session (self-target is forbidden)',
    'SovereignNft.mint(address)': 'mints a NEW token; no asset of the account moves',
    'StealthAnnouncer.announce(uint256,address,bytes,bytes)': 'emits an event; moves nothing',
  };

  const functions = readdirSync(outDir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((file) => {
      const artifact = JSON.parse(readFileSync(join(outDir, file), 'utf8')) as {
        contractName: string;
        abi: Array<AbiFunction | { type: string }>;
      };
      return artifact.abi
        .filter((e): e is AbiFunction => e.type === 'function')
        .filter((fn) => fn.stateMutability !== 'view' && fn.stateMutability !== 'pure')
        .filter((fn) => (fn.inputs as readonly Param[]).some(hasAddress))
        .map((fn) => {
          const signature = `${fn.name}(${(fn.inputs as readonly Param[]).map(format).join(',')})`;
          return { contract: artifact.contractName, fn, signature, selector: toFunctionSelector(signature).toLowerCase() as Hex };
        });
    });

  it('finds the functions it is meant to classify', () => {
    expect(functions.length).toBeGreaterThan(40);
    expect(functions.map((f) => f.signature)).toContain('swapExactIn(address,address,uint256,uint256,address)');
    expect(functions.map((f) => f.signature)).toContain('setHeirs(address[],uint16[])'); // address[]
    expect(functions.map((f) => f.signature)).toContain('createToken(bytes32,(string,string,uint8,uint256,address))'); // tuple component
  });

  it('leaves none unclassified', () => {
    const unclassified = functions
      .filter(({ contract, signature, selector }) => {
        if (recipientListed.has(selector) || targetListed.has(selector) || isOutboundTransferSelector(selector)) return false;
        return !(`${contract}.${signature}` in EXEMPT);
      })
      .map(({ contract, signature }) => `${contract}.${signature}`);
    expect(unclassified).toEqual([]);
  });

  it('has no stale exemption (every one names a function that still exists and is not already refused)', () => {
    const present = new Map(functions.map((f) => [`${f.contract}.${f.signature}`, f]));
    for (const key of Object.keys(EXEMPT)) {
      const f = present.get(key);
      expect(f, `exemption ${key} matches no function`).toBeDefined();
      expect(
        isOutboundTransferSelector(f!.selector) || recipientListed.has(f!.selector) || targetListed.has(f!.selector),
        `${key} is exempt but also listed`,
      ).toBe(false);
    }
  });

  it('puts every listed recipient / trusted address at the argument position the compiled ABI declares', () => {
    const byName = (names: RegExp) => (signature: string) =>
      functions
        .find((f) => f.signature === signature && f.fn.inputs.some((i) => names.test(i.name ?? '')))
        ?.fn.inputs.findIndex((i) => names.test(i.name ?? ''));
    for (const { signature, recipientArg } of RECIPIENT_SCOPED_CALLS) {
      expect(byName(/^(to|recipient|receiver)$/i)(signature), `${signature}: recipient position`).toBe(recipientArg);
    }
    for (const { signature, targetArg } of TARGET_ARG_CALLS) {
      expect(byName(/^pool$/i)(signature), `${signature}: pool position`).toBe(targetArg);
    }
  });
});
