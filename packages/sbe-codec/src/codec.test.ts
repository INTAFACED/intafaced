import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSbeCodec } from './codec.js';
import type { EncodeInput, JavaSbeCodec } from './types.js';

// Linked Trade+Depth decimal-string proof: scripts/linked-roundtrip.mjs (not vitest — JVM spawnSync blocks birpc).

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function trade(): EncodeInput {
  return {
    template: 'Trade',
    instrument: 'BTCUSDT',
    tradeId: '9',
    side: 'buy',
    price: '100.25',
    qty: '1.50',
    eventTimeNs: '1',
  };
}

describe('sbe codec — pin, schema, not protobuf, not a book', () => {
  it('schema is SBE XML with decimal mantissa/exponent, not protobuf', () => {
    const schema = readFileSync(join(root, 'schema', 'intafaced-md.xml'), 'utf8');
    expect(schema).toContain('http://fixprotocol.io/2016/sbe');
    expect(schema).toContain('name="Trade"');
    expect(schema).toContain('name="DepthLevel"');
    expect(schema).toContain('DecimalEncoding');
    expect(schema).toContain('primitiveType="int64"');
    expect(schema.toLowerCase()).not.toContain('protobuf');
    expect(schema.toLowerCase()).not.toContain('proto3');
  });

  it('package.json does not depend on ledger-client, protobuf, ccxt, or nats', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names).not.toContain('@intafaced/ledger-client');
    expect(names.some((n) => n.toLowerCase().includes('protobuf'))).toBe(false);
    expect(names.some((n) => n.toLowerCase().includes('ccxt'))).toBe(false);
    expect(names.some((n) => n.toLowerCase() === 'nats' || n.includes('nats.js'))).toBe(false);
  });

  it('pom pins sbe-tool 1.39.0 and does not declare a money book', () => {
    const pom = readFileSync(join(root, 'pom.xml'), 'utf8');
    expect(pom).toContain('<sbe.version>1.39.0</sbe.version>');
    expect(pom).toContain('uk.co.real-logic');
    expect(pom).toContain('sbe-tool');
    expect(pom.toLowerCase()).not.toContain('memberwallet');
    expect(pom.toLowerCase()).not.toContain('protobuf');
    expect(pom.toLowerCase()).not.toContain('aeron-client');
    expect(pom).toContain('maven-shade-plugin');
    expect(pom).toContain('io.intafaced.sbe.SbeCodecMain');
    expect(pom).toContain('org.agrona:*');
  });
});

describe('sbe codec — missing / IEEE inputs refuse even if Java is present', () => {
  const stub: JavaSbeCodec = {
    handle: () => {
      throw new Error('java must not be called when inputs are missing');
    },
  };
  const adapter = createSbeCodec({ java: stub });

  it('refuses a missing price without calling Java', () => {
    const { price: _p, ...rest } = trade();
    const result = adapter.encode(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_input');
    expect(result.field).toBe('price');
    expect('payload' in result).toBe(false);
  });

  it('refuses JS number qty', () => {
    const result = adapter.encode({
      ...trade(),
      qty: 1.5 as unknown as string,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ieee_input');
    expect(result.field).toBe('qty');
  });

  it('refuses scientific-notation price', () => {
    const result = adapter.encode({ ...trade(), price: '1e-2' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_decimal');
  });
});

describe('sbe codec — decode money stays a decimal string', () => {
  function decodeJava(fields: Record<string, unknown>) {
    const stub: JavaSbeCodec = {
      handle: () =>
        JSON.stringify({
          ok: true,
          template: 'Trade',
          instrument: 'BTCUSDT',
          tradeId: '9',
          side: 'buy',
          eventTimeNs: '1',
          price: '100.25',
          qty: '1.50',
          ...fields,
        }),
    };
    return createSbeCodec({ java: stub }).decode('cGF5bG9hZA');
  }

  it('refuses blank, whitespace, and exponent-form price or qty', () => {
    const blankPrice = decodeJava({ price: '' });
    expect(blankPrice.ok).toBe(false);
    if (!blankPrice.ok) expect(blankPrice.reason).toBe('missing_input');

    const whitespaceQty = decodeJava({ qty: '   ' });
    expect(whitespaceQty.ok).toBe(false);
    if (!whitespaceQty.ok) expect(whitespaceQty.reason).toBe('missing_input');

    const exponentPrice = decodeJava({ price: '1e-2' });
    expect(exponentPrice.ok).toBe(false);
    if (!exponentPrice.ok) {
      expect(exponentPrice.reason).toBe('invalid_decimal');
      expect(exponentPrice.message).not.toContain('0.01');
    }

    const exponentQty = decodeJava({ qty: '1e-2' });
    expect(exponentQty.ok).toBe(false);
    if (!exponentQty.ok) expect(exponentQty.reason).toBe('invalid_decimal');

    const plain = decodeJava({});
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.price).toBe('100.25');
      expect(plain.qty).toBe('1.50');
    }

    const jsonNumber = decodeJava({ price: 1.5 });
    expect(jsonNumber.ok).toBe(false);
    if (!jsonNumber.ok) expect(jsonNumber.reason).toBe('invalid_message');
  });
});

describe('sbe codec — encode payloadB64 must be canonical standard base64', () => {
  function encodeFromJava(payloadB64: string, template = 'Trade') {
    const stub: JavaSbeCodec = {
      handle: () => JSON.stringify({ ok: true, template, payloadB64 }),
    };
    return createSbeCodec({ java: stub }).encode(trade());
  }

  it('refuses empty, whitespace, and non-alphabet payloadB64', () => {
    const rejected = ['', ' ', '    ', '\n', '\n\n\n\n', '!!!!', 'b2s-', 'b2s_', '====', 'YR=='];
    for (const payloadB64 of rejected) {
      const result = encodeFromJava(payloadB64);
      expect(result.ok, JSON.stringify(payloadB64)).toBe(false);
      if (!result.ok) expect(result.reason, JSON.stringify(payloadB64)).toBe('invalid_message');
    }
  });

  it('accepts a canonical padded Trade payload from the Java stub', () => {
    const payloadB64 = Buffer.from('ok').toString('base64');
    const result = encodeFromJava(payloadB64, 'Trade');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template).toBe('Trade');
    expect(result.payloadB64).toBe(payloadB64);
    expect(Buffer.from(result.payload).toString('utf8')).toBe('ok');
  });
});
