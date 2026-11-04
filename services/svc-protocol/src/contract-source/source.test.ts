import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, type Address, type Hex } from 'viem';
import {
  CONTRACT_ARGUMENT_INVALID,
  CONTRACT_CALL_REVERTED,
  CONTRACT_FUNCTION_UNKNOWN,
  CONTRACT_INTERFACE_UNKNOWN,
} from '@intafaced/contracts/protocol-contract-source';
import { createEdgeContext, type TRPCError } from '@intafaced/contracts';
import { loadArtifact } from '../chain/artifacts.js';
import {
  coerceArgs,
  EIP1967_IMPLEMENTATION_SLOT,
  findFunction,
  loadSources,
  matchSource,
  SOURCES,
  minimalProxyTarget,
  slotImplementation,
  withoutMetadata,
} from './source.js';
import { createContractSourceRouter, ranOutOfGas, revertReason, type ContractChain } from './router.js';

const sources = loadSources();
const token = loadArtifact('TestToken');

/** TestToken's runtime as a deployment writes it: the three immutables filled in (name, symbol, decimals 18). */
function deployedTestToken(): Hex {
  const code = Buffer.from(token.deployedBytecode.slice(2), 'hex');
  const fills = Object.values(token.immutableReferences ?? {});
  fills.forEach((ranges, i) => ranges.forEach(({ start, length }) => code.fill(0x12 + i, start, start + length)));
  return `0x${code.toString('hex')}`;
}

/** The same runtime with one byte of its metadata hash changed: the same program from a differently written source. */
function similarTestToken(): Hex {
  const code = Buffer.from(deployedTestToken().slice(2), 'hex');
  const tail = code.length - 2 - code.readUInt16BE(code.length - 2);
  code[tail + 12] = code[tail + 12]! ^ 0xff;
  return `0x${code.toString('hex')}`;
}

const IMPL = '0x1111111111111111111111111111111111111111' as Address;
const PROXY = '0x2222222222222222222222222222222222222222' as Address;
const CLONE = '0x3333333333333333333333333333333333333333' as Address;
const PLAIN = '0x4444444444444444444444444444444444444444' as Address;
const clone = (target: Address): Hex => `0x363d3d373d3d3d363d73${target.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

describe('source status against the committed builds', () => {
  it('reads every committed build with runtime code once, at import', () => {
    expect(sources.map((s) => s.artifact.contractName)).toContain('TestToken');
    expect(sources.every((s) => s.artifact.deployedBytecode.length > 2)).toBe(true);
    expect(SOURCES.map((s) => s.artifact.contractName)).toEqual(sources.map((s) => s.artifact.contractName));
  });

  it('a deployed library, its own address written into its code, is still its build', () => {
    const lib = loadArtifact('SessionKeyLib');
    const deployed = `0x73${'ab'.repeat(20)}${lib.deployedBytecode.slice(44)}` as Hex;
    expect(matchSource(sources, deployed).source).toMatchObject({ status: 'exact', name: 'SessionKeyLib' });
  });

  it('exact: the build byte for byte apart from its immutables, named with its file and compiler', () => {
    expect(matchSource(sources, deployedTestToken()).source).toEqual({
      status: 'exact',
      name: 'TestToken',
      sourceName: 'test/TestToken.sol',
      compiler: `solc ${token.solcVersion}`,
      sourceHash: token.sourceHash,
    });
  });

  it('similar: only the metadata hash differs', () => {
    expect(matchSource(sources, similarTestToken()).source).toMatchObject({ status: 'similar', name: 'TestToken' });
  });

  it('unverified: no code, or no source that compiles to the code, each with its reason', () => {
    expect(matchSource(sources, null).source).toEqual({ status: 'unverified', reason: 'no_code' });
    expect(matchSource(sources, '0x').source).toEqual({ status: 'unverified', reason: 'no_code' });
    expect(matchSource(sources, '0x600f600c600039600f6000f3').source).toEqual({ status: 'unverified', reason: 'no_matching_source' });
    // A change outside the metadata is a different program: not similar.
    const code = Buffer.from(deployedTestToken().slice(2), 'hex');
    code[40] = code[40]! ^ 0xff;
    expect(matchSource(sources, `0x${code.toString('hex')}`).source).toEqual({ status: 'unverified', reason: 'no_matching_source' });
  });

  it('cuts a CBOR metadata tail only when there is one', () => {
    const code = Buffer.from(token.deployedBytecode.slice(2), 'hex');
    expect(withoutMetadata(code)!.length).toBe(code.length - 2 - code.readUInt16BE(code.length - 2));
    expect(withoutMetadata(Buffer.from('6000600055', 'hex'))).toBeNull();
  });
});

describe('proxies', () => {
  it('reads an EIP-1167 clone’s target, and nothing from other code', () => {
    expect(minimalProxyTarget(clone(IMPL))).toBe(IMPL);
    expect(minimalProxyTarget(deployedTestToken())).toBeNull();
    expect(minimalProxyTarget(null)).toBeNull();
  });

  it('reads an EIP-1967 slot holding an address; empty or wider words are no implementation', () => {
    expect(slotImplementation(`0x${IMPL.slice(2).padStart(64, '0')}`)).toBe(IMPL);
    expect(slotImplementation(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(slotImplementation(`0x01${IMPL.slice(2).padStart(62, '0')}`)).toBeNull();
    expect(slotImplementation(null)).toBeNull();
  });
});

describe('arguments', () => {
  const abi = [
    {
      type: 'function',
      name: 'f',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'n', type: 'uint8' },
        { name: 'ok', type: 'bool' },
        { name: 'list', type: 'uint256[2]' },
        { name: 'raw', type: 'bytes4' },
      ],
      outputs: [],
    },
  ] as const;
  const fn = findFunction(abi, 'f(address,uint8,bool,uint256[2],bytes4)', 'write');

  it('takes each argument as its declared type wants it', () => {
    expect(coerceArgs(fn, [IMPL.toLowerCase(), '255', 'true', '["1", 2]', '0xdeadbeef'])).toEqual([
      IMPL,
      255n,
      true,
      [1n, 2n],
      '0xdeadbeef',
    ]);
  });

  it('refuses an argument that does not fit, naming it', () => {
    const refused = (args: string[]) => {
      try {
        coerceArgs(fn, args);
      } catch (err) {
        return (err as Error).message;
      }
      return 'accepted';
    };
    expect(refused([IMPL, '256', 'true', '[1,2]', '0xdeadbeef'])).toBe(
      `${CONTRACT_ARGUMENT_INVALID}: argument 2, n (uint8), is outside the range of uint8.`,
    );
    expect(refused(['0x12', '1', 'true', '[1,2]', '0xdeadbeef'])).toContain('argument 1, to (address), must be a 20-byte hex address');
    expect(refused([IMPL, '1', 'yes', '[1,2]', '0xdeadbeef'])).toContain('argument 3, ok (bool), must be true or false');
    expect(refused([IMPL, '1', 'true', '[1]', '0xdeadbeef'])).toContain('must hold exactly 2 items');
    expect(refused([IMPL, '1', 'true', '[1,2]', '0xdead'])).toContain('must be exactly 4 bytes');
    expect(refused([IMPL])).toContain('takes 5 arguments, not 1');
  });

  it('never runs a write from Read nor a read from Write', () => {
    expect(() => findFunction(token.abi, 'balanceOf(address)', 'write')).toThrow(CONTRACT_FUNCTION_UNKNOWN);
    expect(() => findFunction(token.abi, 'mint(address,uint256)', 'read')).toThrow(CONTRACT_FUNCTION_UNKNOWN);
    expect(() => findFunction(token.abi, 'nothing()', 'read')).toThrow(CONTRACT_FUNCTION_UNKNOWN);
  });
});

/** A TEST chain in memory: code per address, one storage slot per address, and answers per call data. */
function fakeChain(over: Partial<ContractChain> & { codes: Record<string, Hex>; slots?: Record<string, Hex> }): ContractChain {
  return {
    chainId: 84532,
    head: async () => 77n,
    code: async (address) => over.codes[address.toLowerCase()] ?? null,
    storage: async (address, slot) => (slot === EIP1967_IMPLEMENTATION_SLOT ? (over.slots?.[address.toLowerCase()] ?? null) : null),
    call: over.call ?? (async () => '0x'),
  };
}

const caller = (chain: ContractChain) =>
  createContractSourceRouter({ chain: () => chain, sources, toTrpcError: (err) => err as TRPCError }).createCaller(
    createEdgeContext({ secret: 'a-contract-source-test-edge-secret-len', serviceName: 'svc-protocol' })({
      headers: { 'x-intafaced-region': 'DE' },
      id: 'req',
    }),
  );

const codes = {
  [IMPL.toLowerCase()]: deployedTestToken(),
  [CLONE.toLowerCase()]: clone(IMPL),
  [PROXY.toLowerCase()]: '0x6001600155' as Hex,
  [PLAIN.toLowerCase()]: '0x600f600c600039600f6000f3' as Hex,
};
const slots = { [PROXY.toLowerCase()]: `0x${IMPL.slice(2).padStart(64, '0')}` as Hex };

describe('protocol.contract router', () => {
  it('inspect: a contract that matched carries its own interface at the block it was read', async () => {
    const out = await caller(fakeChain({ codes })).inspect({ address: IMPL });
    expect(out).toMatchObject({ chainId: 84532, blockNumber: '77', source: { status: 'exact', name: 'TestToken' }, proxy: null });
    expect(out.interface?.from).toBe('contract');
    expect(out.interface?.read.map((f) => f.signature)).toContain('balanceOf(address)');
    expect(out.interface?.write.map((f) => f.signature)).toContain('mint(address,uint256)');
    expect(out.interface?.read.every((f) => f.stateMutability === 'view' || f.stateMutability === 'pure')).toBe(true);
  });

  it('inspect: an EIP-1167 clone and an EIP-1967 proxy name their implementation and use its interface', async () => {
    for (const [address, standard] of [
      [CLONE, 'eip1167'],
      [PROXY, 'eip1967'],
    ] as const) {
      const out = await caller(fakeChain({ codes, slots })).inspect({ address });
      expect(out.source).toEqual({ status: 'unverified', reason: 'no_matching_source' });
      expect(out.proxy).toMatchObject({ standard, implementation: IMPL, source: { status: 'exact', name: 'TestToken' } });
      expect(out.interface).toMatchObject({ from: 'implementation', name: 'TestToken' });
    }
  });

  it('inspect: unverified with no interface; an address with no code reads no_code', async () => {
    const plain = await caller(fakeChain({ codes })).inspect({ address: PLAIN });
    expect(plain).toMatchObject({ source: { status: 'unverified', reason: 'no_matching_source' }, proxy: null, interface: null });
    const empty = await caller(fakeChain({ codes })).inspect({ address: '0x5555555555555555555555555555555555555555' });
    expect(empty.source).toEqual({ status: 'unverified', reason: 'no_code' });
  });

  it('read: calls the proxy’s own address with the implementation’s interface, at the inspected block', async () => {
    const seen: Array<{ to: string; data: Hex; block: bigint }> = [];
    const chain = fakeChain({
      codes,
      call: async (to, data, block) => {
        seen.push({ to, data, block });
        return encodeAbiParameters([{ type: 'uint256' }], [42n]);
      },
    });
    const out = await caller(chain).read({ address: CLONE, signature: 'balanceOf(address)', args: [PLAIN] });
    expect(out).toEqual({ blockNumber: '77', outputs: [{ name: '', type: 'uint256', value: '42' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.to).toBe(CLONE);
    expect(seen[0]!.block).toBe(77n);
    expect(decodeFunctionData({ abi: token.abi, data: seen[0]!.data })).toMatchObject({ functionName: 'balanceOf', args: [PLAIN] });
  });

  it('read: a wrongly checksummed address is still called, in its checksummed form', async () => {
    const seen: string[] = [];
    const chain = fakeChain({
      codes,
      call: async (to) => {
        seen.push(to);
        return encodeAbiParameters([{ type: 'uint256' }], [1n]);
      },
    });
    const upper = `0x${CLONE.slice(2).toUpperCase()}`;
    await caller(chain).read({ address: upper, signature: 'totalSupply()', args: [] });
    expect(seen).toEqual([CLONE]);
  });

  it('read: an answer that is not the declared one, and a read past the gas cap, each refuse by name', async () => {
    await expect(
      caller(fakeChain({ codes, call: async () => '0x' })).read({ address: IMPL, signature: 'totalSupply()', args: [] }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('protocol.contract_answer_unreadable: the contract answered nothing'),
    });
    expect(ranOutOfGas(Object.assign(new Error('call failed'), { cause: { details: 'out of gas' } }))).toBe(true);
    expect(ranOutOfGas(new Error('EVM error OutOfGas'))).toBe(true);
    expect(ranOutOfGas(new Error('execution reverted'))).toBe(false);
  });

  it('read: refused with no interface, and a revert names the contract’s own error', async () => {
    await expect(caller(fakeChain({ codes })).read({ address: PLAIN, signature: 'x()', args: [] })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(CONTRACT_INTERFACE_UNKNOWN),
    });
    const reverting = fakeChain({
      codes,
      call: async () => {
        throw Object.assign(new Error('execution reverted'), {
          code: 3,
          data: encodeErrorResult({ abi: token.abi, errorName: 'PermitExpired' }),
        });
      },
    });
    await expect(caller(reverting).read({ address: IMPL, signature: 'totalSupply()', args: [] })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `${CONTRACT_CALL_REVERTED}: the contract reverted: PermitExpired.`,
    });
  });

  it('buildWrite: the call for the wallet to the proxy’s address, never sent here; value only when payable', async () => {
    const out = await caller(fakeChain({ codes })).buildWrite({ address: CLONE, signature: 'mint(address,uint256)', args: [PLAIN, '5'] });
    expect(out).toMatchObject({ chainId: 84532, to: CLONE, value: '0x0' });
    expect(decodeFunctionData({ abi: token.abi, data: out.data as Hex })).toMatchObject({ functionName: 'mint', args: [PLAIN, 5n] });
    await expect(
      caller(fakeChain({ codes })).buildWrite({ address: CLONE, signature: 'mint(address,uint256)', args: [PLAIN, '5'], value: '1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('is not payable') });
    await expect(
      caller(fakeChain({ codes })).buildWrite({
        address: CLONE,
        signature: 'mint(address,uint256)',
        args: [PLAIN, '5'],
        value: '9'.repeat(78),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('larger than a transaction can carry') });
    await expect(
      caller(fakeChain({ codes })).buildWrite({ address: CLONE, signature: 'balanceOf(address)', args: [PLAIN] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining(CONTRACT_FUNCTION_UNKNOWN) });
  });

  it('revert reasons: Error(string), none, and data the interface does not know', () => {
    const errorString = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }],
      errorName: 'Error',
      args: ['nope'],
    });
    expect(revertReason(token.abi, { data: errorString })).toBe('nope');
    expect(revertReason(token.abi, { data: '0x' })).toBe('No reason returned');
    expect(revertReason(token.abi, new Error('x'))).toBe('No reason returned');
    expect(revertReason(token.abi, { cause: { data: '0x12345678' } })).toBe('Unrecognised revert data 0x12345678');
  });
});
