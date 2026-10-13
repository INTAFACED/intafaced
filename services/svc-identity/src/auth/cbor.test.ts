import { describe, expect, it } from 'vitest';
import { decodeCbor, mapGet, type CborValue } from './cbor.js';

const MAX_CBOR_NESTING_DEPTH = 32;

/** RFC 8949 definite-length bytes. Spaces are ignored. */
function bytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('decodeCbor definite-length maps', () => {
  it('throws when a key is repeated', () => {
    // map(2) { "fmt": "none", "fmt": "packed" }
    const duplicateText = bytes('a2 63 666d74 64 6e6f6e65 63 666d74 66 7061636b6564');
    expect(() => decodeCbor(duplicateText)).toThrow(/duplicate map key/);

    // map(2) { 1: 2, 1: 3 } — same short encoding twice
    const duplicateInt = bytes('a2 01 02 01 03');
    expect(() => decodeCbor(duplicateInt)).toThrow(/duplicate map key/);
  });

  it('throws when one integer is a number-sized argument and again a 64-bit argument', () => {
    // map(2) { 1: 2, uint64(1): 3 }
    const numberThenUint64 = bytes('a2 01 02 1b 0000000000000001 03');
    expect(() => decodeCbor(numberThenUint64)).toThrow(/duplicate map key/);

    // map(2) { uint64(1): 3, 1: 2 } — bigint first, so Map.set would keep both
    const uint64ThenNumber = bytes('a2 1b 0000000000000001 03 01 02');
    expect(() => decodeCbor(uint64ThenNumber)).toThrow(/duplicate map key/);

    // map(2) { -1: 2, int64(-1): 3 } — COSE integer keys take the same split
    const negativePair = bytes('a2 20 02 3b 0000000000000000 03');
    expect(() => decodeCbor(negativePair)).toThrow(/duplicate map key/);
  });

  it('decodes a map whose keys are distinct', () => {
    const decoded = decodeCbor(bytes('a2 01 02 03 04'));
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<unknown, unknown>).size).toBe(2);
    expect(mapGet(decoded, 1)).toBe(2);
    expect(mapGet(decoded, 3)).toBe(4);

    const attestation = decodeCbor(bytes('a2 63 666d74 64 6e6f6e65 68 6175746844617461 41 00'));
    expect(mapGet(attestation, 'fmt')).toBe('none');
    expect(mapGet(attestation, 'authData')).toEqual(new Uint8Array([0]));
  });

  it('returns the value of a single integer key', () => {
    expect(mapGet(decodeCbor(bytes('a1 01 02')), 1)).toBe(2);

    const wide = decodeCbor(bytes('a1 1b 0000000000000001 02'));
    expect(wide).toBeInstanceOf(Map);
    expect((wide as Map<unknown, unknown>).size).toBe(1);
    expect(mapGet(wide, 1)).toBe(2);
  });
});

describe('decodeCbor', () => {
  it('throws when bytes remain after one complete value', () => {
    expect(decodeCbor(bytes('01'))).toBe(1);

    // integer 1, then another integer
    expect(() => decodeCbor(bytes('01 02'))).toThrow(/trailing bytes/);
    // map(1) { 1: 2 }, then an extra byte
    expect(() => decodeCbor(bytes('a1 01 02 ff'))).toThrow(/trailing bytes/);
  });
});

describe('decodeCbor text strings', () => {
  it('decodes well-formed UTF-8', () => {
    expect(decodeCbor(bytes('60'))).toBe('');
    expect(decodeCbor(bytes('63 666d74'))).toBe('fmt');
    // text(5) "café"
    expect(decodeCbor(bytes('65 636166c3a9'))).toBe('café');
  });

  it('rejects ill-formed UTF-8 instead of accepting U+FFFD', () => {
    // text(1) lone continuation 0x80, and text(1) 0xFF
    expect(() => decodeCbor(bytes('61 80'))).toThrow(/ill-formed UTF-8/);
    expect(() => decodeCbor(bytes('61 ff'))).toThrow(/ill-formed UTF-8/);
    // overlong encoding of U+0000
    expect(() => decodeCbor(bytes('62 c0 80'))).toThrow(/ill-formed UTF-8/);
  });

  it('rejects distinct ill-formed text keys before they collapse to one string', () => {
    // map(2) { text(1) 0x80: 1, text(1) 0xFF: 2 }
    // Non-fatal decoding turns both keys into U+FFFD.
    expect(() => decodeCbor(bytes('a2 61 80 01 61 ff 02'))).toThrow(/ill-formed UTF-8/);
  });
});

/** `depth` array(1) headers, then integer 0. The integer has `depth` enclosures. */
function nestedOneElementArrays(depth: number): Uint8Array {
  const out = new Uint8Array(depth + 1);
  out.fill(0x81);
  out[depth] = 0x00;
  return out;
}

/** `depth` map(1) { 0: <next> } layers, then integer 0. */
function nestedOneEntryMaps(depth: number): Uint8Array {
  const out = new Uint8Array(depth * 2 + 1);
  for (let i = 0; i < depth; i++) {
    out[i * 2] = 0xa1;
    out[i * 2 + 1] = 0x00;
  }
  out[depth * 2] = 0x00;
  return out;
}

function innermostArray(value: CborValue, depth: number): CborValue {
  let current = value;
  for (let i = 0; i < depth; i++) {
    if (!Array.isArray(current) || current.length !== 1) {
      throw new Error(`expected a one-element array at enclosure ${i}`);
    }
    current = current[0]!;
  }
  return current;
}

function innermostMapValue(value: CborValue, depth: number): CborValue {
  let current = value;
  for (let i = 0; i < depth; i++) {
    if (!(current instanceof Map) || current.size !== 1) {
      throw new Error(`expected a one-entry map at enclosure ${i}`);
    }
    const next = mapGet(current, 0);
    if (next === undefined) throw new Error(`missing map value at enclosure ${i}`);
    current = next;
  }
  return current;
}

describe('decodeCbor nesting depth', () => {
  it('decodes a shallow array and map', () => {
    expect(decodeCbor(nestedOneElementArrays(0))).toBe(0);
    expect(decodeCbor(nestedOneElementArrays(1))).toEqual([0]);
    expect(decodeCbor(bytes('82 01 02'))).toEqual([1, 2]);
    expect(mapGet(decodeCbor(nestedOneEntryMaps(1)), 0)).toBe(0);
    expect(decodeCbor(bytes('a1 81 00 01'))).toBeInstanceOf(Map);
  });

  it('decodes a value enclosed by exactly the cap', () => {
    expect(innermostArray(decodeCbor(nestedOneElementArrays(MAX_CBOR_NESTING_DEPTH)), MAX_CBOR_NESTING_DEPTH)).toBe(0);
    expect(innermostMapValue(decodeCbor(nestedOneEntryMaps(MAX_CBOR_NESTING_DEPTH)), MAX_CBOR_NESTING_DEPTH)).toBe(0);
  });

  it('rejects one more enclosure of an array or a map', () => {
    expect(() => decodeCbor(nestedOneElementArrays(MAX_CBOR_NESTING_DEPTH + 1))).toThrow(/nesting too deep/);
    expect(() => decodeCbor(nestedOneEntryMaps(MAX_CBOR_NESTING_DEPTH + 1))).toThrow(/nesting too deep/);
  });

  it('rejects a nested one-element array deep enough to overflow the stack', () => {
    // Without the cap, read() would keep calling itself until the engine
    // throws RangeError. The cap rejects on the way in.
    let caught: unknown;
    try {
      decodeCbor(nestedOneElementArrays(100_000));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as Error).message).toMatch(/nesting too deep/);
  });

  it('rejects a nested one-entry map deep enough to overflow the stack', () => {
    let caught: unknown;
    try {
      decodeCbor(nestedOneEntryMaps(100_000));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as Error).message).toMatch(/nesting too deep/);
  });
});

describe('decodeCbor byte strings', () => {
  it('returns a copy, so a later write into the caller buffer leaves it unchanged', () => {
    // bytes(3) placed inside a larger buffer, the way a request buffer is reused.
    const storage = new Uint8Array(6);
    storage.set(bytes('43 010203'), 1);
    const input = storage.subarray(1, 5);
    const decoded = decodeCbor(input);
    expect(decoded).toEqual(bytes('010203'));
    storage[2] = 0xff;
    storage[3] = 0xfe;
    storage[4] = 0xfd;
    expect(decoded).toEqual(bytes('010203'));

    // map(1) { "authData": h'010203' } — credential bytes live inside the map.
    const nested = bytes('a1 68 6175746844617461 43 010203');
    const authData = mapGet(decodeCbor(nested), 'authData');
    expect(authData).toEqual(bytes('010203'));
    nested[11] = 0xaa;
    nested[12] = 0xbb;
    nested[13] = 0xcc;
    expect(authData).toEqual(bytes('010203'));
  });

  it('throws when a byte string is truncated', () => {
    expect(() => decodeCbor(bytes('41'))).toThrow(/truncated bytes/);
    expect(() => decodeCbor(bytes('43 0102'))).toThrow(/truncated bytes/);
  });
});
