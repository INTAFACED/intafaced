import { describe, expect, it } from 'vitest';
import { createSbeCodec, type JavaSbeCodec, type SbeCodec } from '@intafaced/sbe-codec';
import { SBE_UNAVAILABLE, encodeL2JsonFrame, encodeL2Snapshot } from './sbe-l2-tape.js';

function stubJava(): JavaSbeCodec {
  return {
    handle(json: string): string {
      const req = JSON.parse(json) as Record<string, unknown>;
      if (req.op === 'encode') {
        const marker = [
          String(req.template),
          String(req.instrument),
          String(req.side),
          String(req.price),
          String(req.qty),
          String(req.sequence),
        ].join(':');
        return JSON.stringify({
          ok: true,
          template: req.template,
          payloadB64: Buffer.from(marker, 'utf8').toString('base64'),
        });
      }
      return JSON.stringify({ ok: false, error: { code: 'invalid_message', message: 'decode not used' } });
    },
  };
}

const BOOK = {
  marketId: 'BTC-USDT',
  sequence: 10,
  bids: [['100', '1']] as const,
  asks: [['101', '1']] as const,
};

function codecThatCountsEncodes(): { readonly codec: SbeCodec; readonly encodes: () => number } {
  const inner = createSbeCodec({ java: stubJava() });
  let encodes = 0;
  const codec: SbeCodec = {
    linked: inner.linked,
    encode(input) {
      encodes += 1;
      return inner.encode(input);
    },
    decode(payload) {
      return inner.decode(payload);
    },
  };
  return { codec, encodes: () => encodes };
}

describe('sbe L2 tape — DepthLevel via sbe-codec, never L3', () => {
  it('encodes each resting level as DepthLevel and names the book L2', () => {
    const codec = createSbeCodec({ java: stubJava() });
    const encoded = encodeL2Snapshot(codec, BOOK);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.book).toBe('L2');
    expect(encoded.template).toBe('DepthLevel');
    expect(encoded.sequence).toBe('10');
    expect(encoded.payloads).toHaveLength(2);
    expect(Buffer.from(encoded.payloads[0]!).toString('utf8')).toBe('DepthLevel:BTC-USDT:buy:100:1:10');
    expect(Buffer.from(encoded.payloads[1]!).toString('utf8')).toBe('DepthLevel:BTC-USDT:sell:101:1:10');
    expect(JSON.stringify(encoded)).not.toMatch(/L3/i);
  });

  it('refuses IEEE qty and does not emit a partial tape', () => {
    const codec = createSbeCodec({ java: stubJava() });
    const encoded = encodeL2Snapshot(codec, {
      ...BOOK,
      bids: [['100', 1 as unknown as string]],
    });
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.reason).toBe('ieee_input');
    expect('payloads' in encoded).toBe(false);
  });

  it('unlinked codec refuses sbe_unavailable rather than inventing protobuf', () => {
    const codec = createSbeCodec({ java: null });
    const encoded = encodeL2Snapshot(codec, BOOK);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.reason).toBe(SBE_UNAVAILABLE);
    expect(encoded.message.toLowerCase()).toContain('sbe');
    expect(encoded.message.toLowerCase()).toContain('inventing protobuf');
  });

  it('encodes a hub snapshot JSON frame and skips status frames', () => {
    const codec = createSbeCodec({ java: stubJava() });
    const live = encodeL2JsonFrame(
      codec,
      JSON.stringify({ type: 'snapshot', marketId: 'BTC-USDT', sequence: 10, bids: [['100', '1']], asks: [['101', '1']] }),
    );
    expect(live.ok).toBe(true);
    if (!live.ok || live.skip) return;
    expect(live.book).toBe('L2');
    expect(live.payloads).toHaveLength(2);

    const status = encodeL2JsonFrame(codec, JSON.stringify({ type: 'status', code: 'depth.engine_unavailable' }));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.skip).toBe(true);
    expect(status.payloads).toEqual([]);
  });

  it.each([
    ['blank price', { bids: [['', '1']] as const, asks: [['101', '1']] as const }, 'price'],
    ['whitespace-only size', { bids: [['100', ' \t']] as const, asks: [['101', '1']] as const }, 'qty'],
    ['blank ask price after a priced bid', { bids: [['100', '1']] as const, asks: [['', '2']] as const }, 'price'],
    ['whitespace-only ask size', { bids: [['100', '1']] as const, asks: [['101', '  ']] as const }, 'qty'],
  ] as const)('refuses a %s on encodeL2Snapshot before the codec encodes', (_label, levels, field) => {
    const { codec, encodes } = codecThatCountsEncodes();
    const encoded = encodeL2Snapshot(codec, { marketId: 'BTC-USDT', sequence: 10, ...levels });
    expect(encodes()).toBe(0);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.reason).toBe('missing_input');
    expect(encoded.field).toBe(field);
    expect(encoded.message.toLowerCase()).toContain('blank');
    expect('payloads' in encoded).toBe(false);
  });

  it.each([
    ['blank price', { bids: [['', '1']], asks: [['101', '1']] }, 'price'],
    ['whitespace-only size', { bids: [['100', '1']], asks: [['101', '\n']] }, 'qty'],
  ] as const)('refuses a %s on encodeL2JsonFrame before the codec encodes', (_label, levels, field) => {
    const { codec, encodes } = codecThatCountsEncodes();
    const encoded = encodeL2JsonFrame(codec, JSON.stringify({ type: 'snapshot', marketId: 'BTC-USDT', sequence: 10, ...levels }));
    expect(encodes()).toBe(0);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.reason).toBe('missing_input');
    expect(encoded.field).toBe(field);
    expect(encoded.message.toLowerCase()).toContain('blank');
    expect('payloads' in encoded).toBe(false);
  });

  it.each([
    ['boolean', true, 'true'],
    ['array', ['9', '10'], '9,10'],
    ['object', { n: 10 }, '[object Object]'],
  ] as const)('refuses a %s sequence on encodeL2Snapshot before the codec encodes', (_label, sequence, published) => {
    const { codec, encodes } = codecThatCountsEncodes();
    const encoded = encodeL2Snapshot(codec, {
      marketId: 'BTC-USDT',
      sequence: sequence as unknown as number,
      bids: [['100', '1']],
      asks: [['101', '1']],
    });
    expect(encodes()).toBe(0);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.reason).toBe('invalid_message');
    expect(encoded.field).toBe('sequence');
    expect(encoded.message.toLowerCase()).toContain('sequence');
    expect('payloads' in encoded).toBe(false);
    expect(JSON.stringify(encoded)).not.toContain(`"${published}"`);
  });

  it.each([
    ['boolean', true, 'true'],
    ['array', ['9', '10'], '9,10'],
    ['object', { n: 10 }, '[object Object]'],
  ] as const)('refuses a %s sequence on encodeL2JsonFrame before the codec encodes', (_label, sequence, published) => {
    const { codec, encodes } = codecThatCountsEncodes();
    const encoded = encodeL2JsonFrame(
      codec,
      JSON.stringify({
        type: 'snapshot',
        marketId: 'BTC-USDT',
        sequence,
        bids: [['100', '1']],
        asks: [['101', '1']],
      }),
    );
    expect(encodes()).toBe(0);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.reason).toBe('invalid_message');
    expect(encoded.field).toBe('sequence');
    expect(encoded.message.toLowerCase()).toContain('sequence');
    expect('payloads' in encoded).toBe(false);
    expect(JSON.stringify(encoded)).not.toContain(`"${published}"`);
  });

  it('encodes a string sequence and a finite number sequence', () => {
    const codec = createSbeCodec({ java: stubJava() });
    const fromText = encodeL2Snapshot(codec, { ...BOOK, sequence: '42' });
    expect(fromText.ok).toBe(true);
    if (!fromText.ok) return;
    expect(fromText.sequence).toBe('42');
    expect(Buffer.from(fromText.payloads[0]!).toString('utf8')).toBe('DepthLevel:BTC-USDT:buy:100:1:42');

    const fromNumber = encodeL2Snapshot(codec, { ...BOOK, sequence: 10.5 });
    expect(fromNumber.ok).toBe(true);
    if (!fromNumber.ok) return;
    expect(fromNumber.sequence).toBe('10.5');
    expect(Buffer.from(fromNumber.payloads[0]!).toString('utf8')).toBe('DepthLevel:BTC-USDT:buy:100:1:10.5');

    const framed = encodeL2JsonFrame(
      codec,
      JSON.stringify({ type: 'snapshot', marketId: 'BTC-USDT', sequence: '42', bids: [['100', '1']], asks: [['101', '1']] }),
    );
    expect(framed.ok).toBe(true);
    if (!framed.ok || framed.skip) return;
    expect(framed.sequence).toBe('42');
  });
});
