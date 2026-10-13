/**
 * Real Logic SBE 1.39.0 adapter — PTX-M05-R04.
 *
 * When the official generated stubs are linked, encode/decode uses them.
 * When they are not, every call refuses with sbe_unavailable and does not
 * invent protobuf. Qty/price stay decimal strings. NATS and the book stay out.
 */

import { MONEY_FIELDS, readDecimalString } from './decimal.js';
import { loadJavaSbeCodec } from './java-bridge.js';
import type {
  AdapterRefuse,
  AdapterRefuseReason,
  DecodeOk,
  DecodeResult,
  EncodeInput,
  EncodeResult,
  JavaSbeCodec,
  SbeCodec,
  Side,
  TemplateName,
} from './types.js';
import { SBE_UNAVAILABLE } from './types.js';

function refuse(linked: boolean, reason: AdapterRefuseReason, message: string, field?: string): AdapterRefuse {
  return field === undefined ? { ok: false, linked, reason, message } : { ok: false, linked, reason, field, message };
}

function readSide(value: unknown): { ok: true; value: Side } | { ok: false; reason: AdapterRefuseReason; message: string; field: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: false, reason: 'missing_input', message: 'side is missing', field: 'side' };
  }
  if (value !== 'buy' && value !== 'sell') {
    return { ok: false, reason: 'invalid_message', message: 'side must be "buy" or "sell"', field: 'side' };
  }
  return { ok: true, value };
}

function readTemplate(
  value: unknown,
): { ok: true; value: TemplateName } | { ok: false; reason: AdapterRefuseReason; message: string; field: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: false, reason: 'missing_input', message: 'template is missing', field: 'template' };
  }
  if (value !== 'Trade' && value !== 'DepthLevel') {
    return { ok: false, reason: 'unsupported_template', message: 'template must be Trade or DepthLevel', field: 'template' };
  }
  return { ok: true, value };
}

function readToken(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; reason: AdapterRefuseReason; message: string; field: string } {
  if (typeof value === 'number') {
    return { ok: false, reason: 'ieee_input', message: `${field} is an IEEE number — ids stay decimal strings`, field };
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, reason: 'missing_input', message: `${field} is missing`, field };
  }
  return { ok: true, value: value.trim() };
}

function parseJavaJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' ? v : null;
}

// Empty base64 round-trips through Buffer, so length is checked before the compare.
const CANONICAL_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function canonicalStandardBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!CANONICAL_B64.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

export function createSbeCodec(deps: { readonly java?: JavaSbeCodec | null } = {}): SbeCodec {
  const java = deps.java === undefined ? loadJavaSbeCodec() : deps.java;
  const linked = java !== null;

  return {
    linked,
    encode(input: Partial<EncodeInput> | null | undefined): EncodeResult {
      const template = readTemplate(input?.template);
      if (!template.ok) return refuse(linked, template.reason, template.message, template.field);
      const instrument = readToken(input?.instrument, 'instrument');
      if (!instrument.ok) return refuse(linked, instrument.reason, instrument.message, instrument.field);
      const side = readSide(input?.side);
      if (!side.ok) return refuse(linked, side.reason, side.message, side.field);
      const eventTimeNs = readToken(input?.eventTimeNs, 'eventTimeNs');
      if (!eventTimeNs.ok) return refuse(linked, eventTimeNs.reason, eventTimeNs.message, eventTimeNs.field);

      const money: Record<(typeof MONEY_FIELDS)[number], string> = { price: '', qty: '' };
      for (const field of MONEY_FIELDS) {
        const read = readDecimalString(input?.[field], field);
        if (!read.ok) return refuse(linked, read.reason, read.message, field);
        money[field] = read.value;
      }

      const idField = template.value === 'Trade' ? 'tradeId' : 'sequence';
      const id = readToken(
        template.value === 'Trade'
          ? (input as Partial<EncodeInput> & { tradeId?: unknown }).tradeId
          : (input as Partial<EncodeInput> & { sequence?: unknown }).sequence,
        idField,
      );
      if (!id.ok) return refuse(linked, id.reason, id.message, id.field);

      if (java === null) {
        return refuse(linked, SBE_UNAVAILABLE, 'Real Logic SBE 1.39.0 is not linked — refusing rather than inventing protobuf');
      }

      const body: Record<string, string> = {
        op: 'encode',
        template: template.value,
        instrument: instrument.value,
        side: side.value,
        price: money.price,
        qty: money.qty,
        eventTimeNs: eventTimeNs.value,
      };
      if (template.value === 'Trade') body.tradeId = id.value;
      else body.sequence = id.value;

      let raw: string;
      try {
        raw = java.handle(JSON.stringify(body));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'SBE Java encode failed';
        return refuse(linked, SBE_UNAVAILABLE, message);
      }

      const parsed = asRecord(parseJavaJson(raw));
      if (parsed === null) return refuse(linked, 'invalid_message', 'SBE Java encode returned non-JSON');
      if (parsed.ok === false) {
        const error = asRecord(parsed.error);
        const code = error && typeof error.code === 'string' ? error.code : 'invalid_message';
        const message = error && typeof error.message === 'string' ? error.message : 'encode refused';
        const reason: AdapterRefuseReason =
          code === SBE_UNAVAILABLE
            ? SBE_UNAVAILABLE
            : code === 'invalid_decimal'
              ? 'invalid_decimal'
              : code === 'missing_input'
                ? 'missing_input'
                : 'invalid_message';
        return refuse(true, reason, message);
      }
      const payloadB64 = stringField(parsed, 'payloadB64');
      const outTemplate = stringField(parsed, 'template');
      if (
        payloadB64 === null ||
        !canonicalStandardBase64(payloadB64) ||
        (outTemplate !== 'Trade' && outTemplate !== 'DepthLevel')
      ) {
        return refuse(linked, 'invalid_message', 'SBE Java encode omitted payload');
      }
      return { ok: true, linked: true, template: outTemplate, payload: Uint8Array.from(Buffer.from(payloadB64, 'base64')), payloadB64 };
    },
    decode(payload: Uint8Array | string | null | undefined): DecodeResult {
      if (
        payload === undefined ||
        payload === null ||
        (typeof payload === 'string' && payload.length === 0) ||
        (payload instanceof Uint8Array && payload.byteLength === 0)
      ) {
        return refuse(linked, 'missing_input', 'payload is missing', 'payload');
      }
      if (java === null) {
        return refuse(linked, SBE_UNAVAILABLE, 'Real Logic SBE 1.39.0 is not linked — refusing rather than inventing protobuf');
      }
      const payloadB64 = typeof payload === 'string' ? payload : Buffer.from(payload).toString('base64');
      let raw: string;
      try {
        raw = java.handle(JSON.stringify({ op: 'decode', payloadB64 }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'SBE Java decode failed';
        return refuse(linked, SBE_UNAVAILABLE, message);
      }
      const parsed = asRecord(parseJavaJson(raw));
      if (parsed === null) return refuse(linked, 'invalid_message', 'SBE Java decode returned non-JSON');
      if (parsed.ok === false) {
        const error = asRecord(parsed.error);
        const code = error && typeof error.code === 'string' ? error.code : 'invalid_message';
        const message = error && typeof error.message === 'string' ? error.message : 'decode refused';
        const reason: AdapterRefuseReason =
          code === 'schema_mismatch' ? 'schema_mismatch' : code === SBE_UNAVAILABLE ? SBE_UNAVAILABLE : 'invalid_message';
        return refuse(true, reason, message);
      }
      const template = stringField(parsed, 'template');
      const instrument = stringField(parsed, 'instrument');
      const side = stringField(parsed, 'side');
      const priceField = stringField(parsed, 'price');
      const qtyField = stringField(parsed, 'qty');
      const eventTimeNs = stringField(parsed, 'eventTimeNs');
      if (template === null || instrument === null || side === null || priceField === null || qtyField === null || eventTimeNs === null) {
        return refuse(linked, 'invalid_message', 'SBE Java decode omitted a decimal field');
      }
      if (side !== 'buy' && side !== 'sell') {
        return refuse(linked, 'invalid_message', 'decoded side is not buy/sell');
      }
      const decodedSide: Side = side === 'sell' ? 'sell' : 'buy';
      if (typeof parsed.price === 'number' || typeof parsed.qty === 'number') {
        return refuse(linked, 'ieee_input', 'SBE Java decode leaked a JSON number for money');
      }
      const priceRead = readDecimalString(priceField, 'price');
      if (!priceRead.ok) return refuse(linked, priceRead.reason, priceRead.message, 'price');
      const qtyRead = readDecimalString(qtyField, 'qty');
      if (!qtyRead.ok) return refuse(linked, qtyRead.reason, qtyRead.message, 'qty');
      const common = {
        ok: true as const,
        linked: true as const,
        instrument,
        side: decodedSide,
        price: priceRead.value,
        qty: qtyRead.value,
        eventTimeNs,
      };
      if (template === 'Trade') {
        const tradeId = stringField(parsed, 'tradeId');
        if (tradeId === null) return refuse(linked, 'invalid_message', 'decoded tradeId is missing');
        return { ...common, template: 'Trade', tradeId };
      }
      if (template === 'DepthLevel') {
        const sequence = stringField(parsed, 'sequence');
        if (sequence === null) return refuse(linked, 'invalid_message', 'decoded sequence is missing');
        return { ...common, template: 'DepthLevel', sequence };
      }
      return refuse(linked, 'unsupported_template', `decoded template ${template} is not ours`);
    },
  };
}

let singleton: SbeCodec | undefined;

function productionCodec(): SbeCodec {
  return (singleton ??= createSbeCodec());
}

/** Lazy so unit tests that inject `java` do not compile the toolchain at import. */
export const sbeCodec: SbeCodec = {
  get linked() {
    return productionCodec().linked;
  },
  encode(input) {
    return productionCodec().encode(input);
  },
  decode(payload) {
    return productionCodec().decode(payload);
  },
};
