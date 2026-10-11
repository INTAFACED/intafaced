/**
 * Minimal CBOR (RFC 8949) encode/decode for the WebAuthn surface only.
 *
 * WebAuthn needs maps, byte strings, text, integers, and arrays — nothing
 * more. Pulling a general CBOR library into the authentication path would be
 * trusting a large surface we cannot check against the few shapes we use.
 */

export type CborValue = number | bigint | string | Uint8Array | boolean | null | CborValue[] | CborMap;

export type CborMap = Map<CborValue, CborValue> | { [key: string]: CborValue };

/**
 * Maximum enclosing arrays or maps. WebAuthn COSE keys and attestation maps
 * are only a few levels deep. The cap sits far below the stack, so a nested
 * one-element array is rejected before the walk overflows.
 */
export const MAX_CBOR_NESTING_DEPTH = 32;

export function decodeCbor(input: Uint8Array): CborValue {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;

  function read(depth: number): CborValue {
    // Each array element and each map key and value calls read again.
    // A nested one-element array grows the stack with no bound. Stop first.
    if (depth > MAX_CBOR_NESTING_DEPTH) throw new Error('CBOR: nesting too deep');
    if (offset >= input.length) throw new Error('CBOR: unexpected end of input');
    const initial = input[offset++]!;
    const major = initial >> 5;
    const additional = initial & 0x1f;

    const argument = (): number | bigint => {
      if (additional < 24) return additional;
      if (additional === 24) {
        if (offset >= input.length) throw new Error('CBOR: truncated uint8');
        return input[offset++]!;
      }
      if (additional === 25) {
        const v = view.getUint16(offset);
        offset += 2;
        return v;
      }
      if (additional === 26) {
        const v = view.getUint32(offset);
        offset += 4;
        return v;
      }
      if (additional === 27) {
        const v = view.getBigUint64(offset);
        offset += 8;
        return v;
      }
      throw new Error(`CBOR: unsupported additional info ${additional}`);
    };

    const asLength = (n: number | bigint): number => {
      if (typeof n === 'bigint') {
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: length too large');
        return Number(n);
      }
      return n;
    };

    switch (major) {
      case 0:
        return argument();
      case 1: {
        const n = argument();
        return typeof n === 'bigint' ? -n - 1n : -n - 1;
      }
      case 2: {
        const len = asLength(argument());
        const view = input.subarray(offset, offset + len);
        if (view.length !== len) throw new Error('CBOR: truncated bytes');
        offset += len;
        // subarray shares the caller buffer. A reused request would rewrite
        // credential bytes already returned, so hand back a copy.
        return new Uint8Array(view);
      }
      case 3: {
        const len = asLength(argument());
        const slice = input.subarray(offset, offset + len);
        if (slice.length !== len) throw new Error('CBOR: truncated text');
        offset += len;
        // Replacement mode maps every ill-formed sequence to U+FFFD, so
        // distinct bad text keys collapse to one string. Reject them.
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(slice);
        } catch (err) {
          if (err instanceof TypeError) throw new Error('CBOR: ill-formed UTF-8');
          throw err;
        }
      }
      case 4: {
        const len = asLength(argument());
        const arr: CborValue[] = [];
        for (let i = 0; i < len; i++) arr.push(read(depth + 1));
        return arr;
      }
      case 5: {
        const len = asLength(argument());
        const map = new Map<CborValue, CborValue>();
        // A 64-bit argument is a bigint; a shorter argument of the same
        // integer is a number. Map treats those as different keys.
        const repeatsKey = (k: CborValue): boolean => {
          if (map.has(k)) return true;
          if (typeof k === 'number' && Number.isSafeInteger(k)) return map.has(BigInt(k));
          if (typeof k === 'bigint' && k >= BigInt(Number.MIN_SAFE_INTEGER) && k <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return map.has(Number(k));
          }
          return false;
        };
        for (let i = 0; i < len; i++) {
          const k = read(depth + 1);
          const v = read(depth + 1);
          if (repeatsKey(k)) throw new Error('CBOR: duplicate map key');
          map.set(k, v);
        }
        return map;
      }
      case 7:
        if (additional === 20) return false;
        if (additional === 21) return true;
        if (additional === 22) return null;
        throw new Error(`CBOR: unsupported simple value ${additional}`);
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }

  const value = read(0);
  if (offset !== input.length) throw new Error('CBOR: trailing bytes');
  return value;
}

export function encodeCbor(value: CborValue): Uint8Array {
  const chunks: number[] = [];

  const pushUint = (major: number, n: number): void => {
    if (!Number.isInteger(n) || n < 0) throw new Error('CBOR: length must be a non-negative integer');
    if (n < 24) {
      chunks.push((major << 5) | n);
    } else if (n < 256) {
      chunks.push((major << 5) | 24, n);
    } else if (n < 65536) {
      chunks.push((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
    } else if (n <= 0xffffffff) {
      chunks.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    } else {
      throw new Error('CBOR: integer too large for this encoder');
    }
  };

  const write = (v: CborValue): void => {
    if (v === null) {
      chunks.push((7 << 5) | 22);
      return;
    }
    if (v === false) {
      chunks.push((7 << 5) | 20);
      return;
    }
    if (v === true) {
      chunks.push((7 << 5) | 21);
      return;
    }
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('CBOR: floats not supported');
      if (v >= 0) pushUint(0, v);
      else pushUint(1, -v - 1);
      return;
    }
    if (typeof v === 'bigint') {
      if (v >= 0n) {
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: bigint too large');
        pushUint(0, Number(v));
      } else {
        const n = -v - 1n;
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: bigint too large');
        pushUint(1, Number(n));
      }
      return;
    }
    if (typeof v === 'string') {
      const bytes = new TextEncoder().encode(v);
      pushUint(3, bytes.length);
      for (const b of bytes) chunks.push(b);
      return;
    }
    if (v instanceof Uint8Array) {
      pushUint(2, v.length);
      for (const b of v) chunks.push(b);
      return;
    }
    if (Array.isArray(v)) {
      pushUint(4, v.length);
      for (const item of v) write(item);
      return;
    }
    if (v instanceof Map) {
      pushUint(5, v.size);
      for (const [k, val] of v) {
        write(k);
        write(val);
      }
      return;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v);
      pushUint(5, entries.length);
      for (const [k, val] of entries) {
        write(k);
        write(val);
      }
      return;
    }
    throw new Error('CBOR: unsupported value type');
  };

  write(value);
  return Uint8Array.from(chunks);
}

export function mapGet(map: CborValue, key: CborValue): CborValue | undefined {
  if (!(map instanceof Map)) return undefined;
  if (map.has(key)) return map.get(key);
  // Integer keys may arrive as bigint from major-type-0 with 64-bit argument;
  // normalise a few common cases.
  if (typeof key === 'number') {
    if (map.has(BigInt(key))) return map.get(BigInt(key));
  }
  return undefined;
}
