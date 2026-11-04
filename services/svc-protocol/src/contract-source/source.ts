import { readdirSync, readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeFunctionData, getAddress, type Abi, type AbiFunction, type AbiParameter, type Hex } from 'viem';
import {
  CONTRACT_ARGUMENT_INVALID,
  CONTRACT_FUNCTION_UNKNOWN,
  type ContractFunction,
  type ContractSource,
} from '@intafaced/contracts/protocol-contract-source';
import type { ContractArtifact } from '../chain/artifacts.js';
import { MINIMAL_PROXY_PREFIX, MINIMAL_PROXY_SUFFIX } from '../accounts/address.js';

/**
 * Source status, proxies and the Read/Write interface (D-explorer-06). Pure: no chain, no clock.
 *
 * The sources on file are the builds this service compiled and committed (`contracts/out/`), read once at import
 * (`SOURCES`) so a missing or broken artefact fails the service at boot, as `chain/artifacts.ts` asks of request-path
 * callers. Nothing
 * here claims more than those builds: a contract that matches none of them is unverified, said so, with the reason.
 */
const outDir = new URL('../../contracts/out/', import.meta.url);

/**
 * One committed build, its runtime decoded and masked once: the immutables zeroed and, for a library, the PUSH20 of its
 * own address that solc leaves as zeros in the build and the deployment fills in.
 */
export interface Source {
  artifact: ContractArtifact;
  masks: ReadonlyArray<readonly [number, number]>;
  /** The masked runtime, and the same without its metadata tail (null when it has none). */
  runtime: Buffer;
  body: Buffer | null;
}

/** solc's library guard: the runtime starts PUSH20 <address>, all zeros in the build. */
const LIBRARY_HEAD = /^0x73(?:00){20}/;

function prepare(artifact: ContractArtifact): Source {
  const masks: Array<readonly [number, number]> = [];
  for (const ranges of Object.values(artifact.immutableReferences ?? {}))
    for (const { start, length } of ranges) masks.push([start, length]);
  if (LIBRARY_HEAD.test(artifact.deployedBytecode)) masks.push([1, 20]);
  const runtime = applyMasks(masks, Buffer.from(artifact.deployedBytecode.slice(2), 'hex'));
  return { artifact, masks, runtime, body: withoutMetadata(runtime) };
}

/** Every committed build with runtime code, in name order. */
export function loadSources(dir: URL = outDir): Source[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as ContractArtifact)
    .filter((artifact) => artifact.deployedBytecode && artifact.deployedBytecode.length > 2)
    .map(prepare);
}

/** The committed builds, read at import: a missing or broken artefact fails the service at boot. */
export const SOURCES: readonly Source[] = loadSources();

/**
 * The runtime code without the compiler's CBOR metadata tail, or null when the code ends in none. solc ends the runtime
 * with a CBOR map (first byte 0xa1 to 0xa5) followed by its length in two bytes; the map holds the metadata hash, which
 * changes with any change to the source text, comments and names included.
 */
export function withoutMetadata(code: Buffer): Buffer | null {
  if (code.length < 4) return null;
  const length = code.readUInt16BE(code.length - 2);
  const start = code.length - 2 - length;
  if (length === 0 || start < 0) return null;
  const head = code[start]!;
  if (head < 0xa1 || head > 0xa5) return null;
  return code.subarray(0, start);
}

function applyMasks(masks: Source['masks'], code: Buffer): Buffer {
  const out = Buffer.from(code);
  for (const [start, length] of masks) if (start + length <= out.length) out.fill(0, start, start + length);
  return out;
}

/**
 * Exact: the build byte for byte once the immutables (and a library's own address) are masked on both sides; a different
 * length is a different contract (`deployedCodeMatches` in `chain/artifacts.ts` is the same check without the library mask).
 */
export function exactTo(source: Source, code: Buffer): boolean {
  return code.length === source.runtime.length && applyMasks(source.masks, code).equals(source.runtime);
}

/**
 * Similar: the same once the metadata tails are cut from both, with a tail on both sides. That is the same compiled
 * program from a source whose text differs.
 */
export function similarTo(source: Source, code: Buffer): boolean {
  if (!source.body || source.body.length === 0) return false;
  const body = withoutMetadata(applyMasks(source.masks, code));
  return body !== null && body.equals(source.body);
}

export interface SourceMatch {
  source: ContractSource;
  artifact: ContractArtifact | null;
}

const described = (artifact: ContractArtifact) => ({
  name: artifact.contractName,
  sourceName: artifact.sourceName,
  compiler: `solc ${artifact.solcVersion}`,
  sourceHash: artifact.sourceHash,
});

/** Exact first, across every source; then similar; else unverified with its reason. */
export function matchSource(sources: readonly Source[], runtime: Hex | null): SourceMatch {
  if (!runtime || runtime === '0x') return { source: { status: 'unverified', reason: 'no_code' }, artifact: null };
  const code = Buffer.from(runtime.slice(2), 'hex');
  const exact = sources.find((source) => exactTo(source, code));
  if (exact) return { source: { status: 'exact', ...described(exact.artifact) }, artifact: exact.artifact };
  const similar = sources.find((source) => similarTo(source, code));
  if (similar) return { source: { status: 'similar', ...described(similar.artifact) }, artifact: similar.artifact };
  return { source: { status: 'unverified', reason: 'no_matching_source' }, artifact: null };
}

/** EIP-1167 minimal proxy runtime, the head and tail `accounts/address.ts` deploys smart accounts with. */
const EIP1167 = new RegExp(`^0x${MINIMAL_PROXY_PREFIX.slice(2 + 20)}([0-9a-f]{40})${MINIMAL_PROXY_SUFFIX}$`, 'i');
/** EIP-1967 implementation slot: keccak256('eip1967.proxy.implementation') - 1. */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

export function minimalProxyTarget(runtime: Hex | null): Hex | null {
  const found = runtime ? EIP1167.exec(runtime) : null;
  return found ? getAddress(`0x${found[1]}`) : null;
}

/** The implementation in an EIP-1967 slot word, or null when the slot is empty (zero) or holds more than an address. */
export function slotImplementation(word: Hex | null | undefined): Hex | null {
  if (!word || !/^0x[0-9a-fA-F]{1,64}$/.test(word)) return null;
  const value = BigInt(word);
  if (value === 0n || value >> 160n !== 0n) return null;
  return getAddress(`0x${value.toString(16).padStart(40, '0')}`);
}

const canonicalType = (param: AbiParameter): string =>
  param.type.startsWith('tuple')
    ? `(${((param as { components?: readonly AbiParameter[] }).components ?? []).map(canonicalType).join(',')})${param.type.slice(5)}`
    : param.type;

export const functionSignature = (fn: AbiFunction): string => `${fn.name}(${fn.inputs.map(canonicalType).join(',')})`;

const wireParam = (param: AbiParameter): { name: string; type: string; components?: unknown[] } => {
  const components = (param as { components?: readonly AbiParameter[] }).components;
  return { name: param.name ?? '', type: param.type, ...(components ? { components: components.map(wireParam) } : {}) };
};

function toWire(fn: AbiFunction): ContractFunction {
  return {
    name: fn.name,
    signature: functionSignature(fn),
    stateMutability: fn.stateMutability,
    inputs: fn.inputs.map(wireParam),
    outputs: fn.outputs.map(wireParam),
  };
}

const functionsOf = (abi: Abi): AbiFunction[] => abi.filter((item): item is AbiFunction => item.type === 'function');
const isRead = (fn: AbiFunction) => fn.stateMutability === 'view' || fn.stateMutability === 'pure';

/** The Read and Write tabs' functions, in the build's own order. */
export function interfaceOf(abi: Abi): { read: ContractFunction[]; write: ContractFunction[] } {
  const all = functionsOf(abi);
  return { read: all.filter(isRead).map(toWire), write: all.filter((fn) => !isRead(fn)).map(toWire) };
}

export class ContractCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ContractCallError';
  }
}

/** The function by its signature from the tab it was asked from: a read never runs a write, nor a write a read. */
export function findFunction(abi: Abi, signature: string, tab: 'read' | 'write'): AbiFunction {
  const fn = functionsOf(abi).find((entry) => functionSignature(entry) === signature);
  if (!fn || isRead(fn) !== (tab === 'read'))
    throw new ContractCallError(
      CONTRACT_FUNCTION_UNKNOWN,
      `${signature} is not a ${tab === 'read' ? 'read' : 'write'} function of this contract's interface.`,
    );
  return fn;
}

class ArgumentError extends Error {}

function integer(type: string, raw: unknown): bigint {
  const text = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof text !== 'string' || !/^-?\d{1,78}$/.test(text.trim())) throw new ArgumentError('must be a whole number in digits');
  const value = BigInt(text.trim());
  const bits = BigInt(type.replace(/^u?int/, '') || '256');
  const [min, max] = type.startsWith('u') ? [0n, (1n << bits) - 1n] : [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
  if (value < min || value > max) throw new ArgumentError(`is outside the range of ${type}`);
  return value;
}

/** One argument as its declared type wants it. Lists and tuples are given as JSON. */
function coerce(param: AbiParameter, raw: unknown): unknown {
  const { type } = param;
  const list = /^(.*)\[(\d*)\]$/.exec(type);
  if (list || type === 'tuple') {
    let value = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        throw new ArgumentError('must be written as JSON');
      }
    }
    if (list) {
      if (!Array.isArray(value)) throw new ArgumentError('must be a JSON list');
      if (list[2] && value.length !== Number(list[2])) throw new ArgumentError(`must hold exactly ${list[2]} items`);
      const inner = { ...param, type: list[1]! } as AbiParameter;
      return value.map((item) => coerce(inner, item));
    }
    const components = (param as { components?: readonly AbiParameter[] }).components ?? [];
    if (Array.isArray(value)) {
      if (value.length !== components.length) throw new ArgumentError(`must hold exactly ${components.length} fields`);
      return components.map((component, i) => coerce(component, value[i]));
    }
    if (value && typeof value === 'object')
      return Object.fromEntries(components.map((c) => [c.name, coerce(c, (value as Record<string, unknown>)[c.name ?? ''])]));
    throw new ArgumentError('must be a JSON list or object');
  }
  if (type === 'address') {
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.trim())) throw new ArgumentError('must be a 20-byte hex address');
    return getAddress(raw.trim());
  }
  if (type === 'bool') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw new ArgumentError('must be true or false');
  }
  if (/^u?int\d*$/.test(type)) return integer(type, raw);
  if (type === 'string') {
    if (typeof raw !== 'string') throw new ArgumentError('must be text');
    return raw;
  }
  if (/^bytes\d*$/.test(type)) {
    const size = type === 'bytes' ? null : Number(type.slice(5));
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.trim())) throw new ArgumentError('must be hex bytes (0x…)');
    const value = raw.trim() as Hex;
    if (size !== null && value.length !== 2 + size * 2) throw new ArgumentError(`must be exactly ${size} bytes`);
    return value;
  }
  throw new ArgumentError(`has a type this tab does not take (${type})`);
}

export function coerceArgs(fn: AbiFunction, args: readonly string[]): unknown[] {
  if (args.length !== fn.inputs.length)
    throw new ContractCallError(
      CONTRACT_ARGUMENT_INVALID,
      `${functionSignature(fn)} takes ${fn.inputs.length} arguments, not ${args.length}.`,
    );
  return fn.inputs.map((param, i) => {
    try {
      return coerce(param, args[i]);
    } catch (err) {
      if (!(err instanceof ArgumentError)) throw err;
      const label = param.name ? `${param.name} (${param.type})` : param.type;
      throw new ContractCallError(CONTRACT_ARGUMENT_INVALID, `argument ${i + 1}, ${label}, ${err.message}.`);
    }
  });
}

export const encodeCall = (fn: AbiFunction, args: unknown[]): Hex =>
  encodeFunctionData({ abi: [fn], functionName: fn.name, args } as Parameters<typeof encodeFunctionData>[0]);

const asText = (value: unknown): string =>
  typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'string'
      ? value
      : typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner));

/** The call's answer, each output as text in order. */
export function decodeOutputs(fn: AbiFunction, data: Hex): Array<{ name: string; type: string; value: string }> {
  const values = decodeAbiParameters(fn.outputs, data);
  return fn.outputs.map((param, i) => ({ name: param.name ?? '', type: canonicalType(param), value: asText(values[i]) }));
}
