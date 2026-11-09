/**
 * A small, exact MessagePack encoder for Hyperliquid action hashing.
 *
 * Hyperliquid's L1 action hash is keccak256 over `msgpack.packb(action)` (the
 * official Python SDK, `msgpack-python` defaults) followed by the nonce and the
 * vault flag. One byte different is a different hash, so a signature the
 * venue rejects. This encoder writes exactly what `msgpack.packb` writes for
 * the values an action holds:
 *
 *   · `null` → nil; booleans → true / false;
 *   · integers → the smallest form (positive fixint, uint8/16/32/64, negative
 *     fixint, int8/16/32/64), as msgpack-python picks it;
 *   · strings → UTF-8 as fixstr / str8 / str16 / str32;
 *   · arrays → fixarray / array16 / array32;
 *   · plain objects → fixmap / map16 / map32, KEYS IN INSERTION ORDER. Never
 *     sorted: the SDK packs a Python dict in its insertion order, and the
 *     venue hashes what it was sent.
 *
 * Refused (throws): a non-integer `number` (prices and sizes travel as decimal
 * strings, never floats), an integer `number` outside the safe range (pass a
 * bigint), an integer-like object key (JavaScript would silently reorder it),
 * and anything else (Date, Map, undefined, functions). No float path exists.
 *
 * Why not an npm package: the hash depends on these exact bytes, the surface
 * needed is about a hundred lines, and every line here is checked against the
 * SDK's published vectors (`signing.test.ts`).
 */

export type MsgpackValue = null | boolean | number | bigint | string | readonly MsgpackValue[] | { readonly [key: string]: MsgpackValue };

export class MsgpackEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MsgpackEncodeError';
  }
}

const INTEGER_LIKE_KEY = /^(0|[1-9]\d*)$/;

class Writer {
  private chunks: number[] = [];
  byte(b: number): void {
    this.chunks.push(b & 0xff);
  }
  bytes(bs: Uint8Array): void {
    for (const b of bs) this.chunks.push(b);
  }
  /** Big-endian unsigned integer of `width` bytes. */
  uint(value: bigint, width: number): void {
    for (let i = width - 1; i >= 0; i -= 1) this.byte(Number((value >> BigInt(i * 8)) & 0xffn));
  }
  /** Big-endian two's complement of `width` bytes. */
  int(value: bigint, width: number): void {
    const mod = 1n << BigInt(width * 8);
    this.uint(value < 0n ? value + mod : value, width);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function writeInteger(w: Writer, v: bigint): void {
  if (v >= 0n) {
    if (v < 0x80n) w.byte(Number(v));
    else if (v <= 0xffn) {
      w.byte(0xcc);
      w.uint(v, 1);
    } else if (v <= 0xffffn) {
      w.byte(0xcd);
      w.uint(v, 2);
    } else if (v <= 0xffff_ffffn) {
      w.byte(0xce);
      w.uint(v, 4);
    } else if (v <= 0xffff_ffff_ffff_ffffn) {
      w.byte(0xcf);
      w.uint(v, 8);
    } else throw new MsgpackEncodeError(`integer ${v} does not fit uint64`);
    return;
  }
  if (v >= -32n) w.byte(Number(v + 0x100n));
  else if (v >= -0x80n) {
    w.byte(0xd0);
    w.int(v, 1);
  } else if (v >= -0x8000n) {
    w.byte(0xd1);
    w.int(v, 2);
  } else if (v >= -0x8000_0000n) {
    w.byte(0xd2);
    w.int(v, 4);
  } else if (v >= -0x8000_0000_0000_0000n) {
    w.byte(0xd3);
    w.int(v, 8);
  } else throw new MsgpackEncodeError(`integer ${v} does not fit int64`);
}

function writeLength(w: Writer, n: number, fix: { base: number; max: number } | null, codes: readonly [number, number, number]): void {
  if (fix && n <= fix.max) w.byte(fix.base | n);
  else if (codes[0] !== 0 && n <= 0xff) {
    w.byte(codes[0]);
    w.uint(BigInt(n), 1);
  } else if (n <= 0xffff) {
    w.byte(codes[1]);
    w.uint(BigInt(n), 2);
  } else if (n <= 0xffff_ffff) {
    w.byte(codes[2]);
    w.uint(BigInt(n), 4);
  } else throw new MsgpackEncodeError(`length ${n} is too long for msgpack`);
}

const utf8 = new TextEncoder();

function writeValue(w: Writer, value: MsgpackValue, path: string): void {
  if (value === null) {
    w.byte(0xc0);
    return;
  }
  switch (typeof value) {
    case 'boolean':
      w.byte(value ? 0xc3 : 0xc2);
      return;
    case 'bigint':
      writeInteger(w, value);
      return;
    case 'number':
      if (!Number.isInteger(value)) throw new MsgpackEncodeError(`${path}: ${value} is not an integer; send decimals as strings`);
      if (!Number.isSafeInteger(value)) throw new MsgpackEncodeError(`${path}: ${value} is outside the safe integer range; pass a bigint`);
      writeInteger(w, BigInt(value));
      return;
    case 'string': {
      const bytes = utf8.encode(value);
      // str8 (0xd9) exists in the msgpack spec msgpack-python writes with use_bin_type=True (its default).
      writeLength(w, bytes.length, { base: 0xa0, max: 31 }, [0xd9, 0xda, 0xdb]);
      w.bytes(bytes);
      return;
    }
    case 'object': {
      if (Array.isArray(value)) {
        writeLength(w, value.length, { base: 0x90, max: 15 }, [0, 0xdc, 0xdd]);
        value.forEach((item, i) => writeValue(w, item, `${path}[${i}]`));
        return;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new MsgpackEncodeError(`${path}: only plain objects are encoded, not ${(value as object).constructor?.name ?? 'this value'}`);
      }
      const keys = Object.keys(value);
      for (const key of keys) {
        if (INTEGER_LIKE_KEY.test(key)) throw new MsgpackEncodeError(`${path}: key "${key}" is integer-like; JavaScript would reorder it`);
      }
      writeLength(w, keys.length, { base: 0x80, max: 15 }, [0, 0xde, 0xdf]);
      for (const key of keys) {
        writeValue(w, key, `${path}.<key>`);
        writeValue(w, (value as Record<string, MsgpackValue>)[key]!, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new MsgpackEncodeError(`${path}: a ${typeof value} cannot be encoded`);
  }
}

/** Encode `value` exactly as msgpack-python's `packb` does for the same Python value. */
export function encodeMsgpack(value: MsgpackValue): Uint8Array {
  const w = new Writer();
  writeValue(w, value, '$');
  return w.done();
}
