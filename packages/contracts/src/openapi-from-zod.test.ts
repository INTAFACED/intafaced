import { describe, expect, it } from 'vitest';
import { quoteConventionSchema } from './instruments.js';
import {
  generateOpenApiFromZod,
  refuseIeeeSdkMoney,
  refuseSilentContractBreak,
  ZOD_TO_OPENAPI,
  ZOD_TO_OPENAPI_VERSION,
} from './openapi-from-zod.js';

describe('CARD G-developer OpenAPI from Zod 4', () => {
  it('pins @asteasolutions/zod-to-openapi@8.5.0', () => {
    expect(ZOD_TO_OPENAPI).toBe('@asteasolutions/zod-to-openapi');
    expect(ZOD_TO_OPENAPI_VERSION).toBe('8.5.0');
  });

  it('refuses a wrong adapter version rather than inventing OpenAPI', () => {
    const result = generateOpenApiFromZod({ adapterVersion: '6.0.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('openapi_unset');
  });

  it('refuses an unregistered schema rather than inventing a spec', () => {
    const empty = generateOpenApiFromZod({ schemas: {} });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.reason).toBe('schema_unregistered');

    const missing = generateOpenApiFromZod({ schemas: { Tick: undefined } });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe('schema_unregistered');
  });

  it('refuses FIX OpenAPI — svc-fix is not recut this PR', () => {
    const result = generateOpenApiFromZod({ surface: 'svc-fix' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('svc_fix_not_this_pr');
  });

  it('generates OpenAPI from existing Zod 4 schemas made before the adapter loads', () => {
    const result = generateOpenApiFromZod({
      schemas: { QuoteConvention: quoteConventionSchema },
      title: '@intafaced/contracts',
      version: '0.0.0',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter).toBe(ZOD_TO_OPENAPI);
      expect(result.adapterVersion).toBe('8.5.0');
      expect(result.document.openapi.startsWith('3.')).toBe(true);
      const schema = result.document.components?.schemas?.QuoteConvention as { properties?: Record<string, { type?: string }> } | undefined;
      expect(schema?.properties?.unitSize?.type).not.toBe('number');
      expect(schema?.properties?.pipSize?.type).not.toBe('number');
    }
  });
});

describe('CARD G-developer contractual deprecation', () => {
  it('refuses a removed field without deprecation', () => {
    const result = refuseSilentContractBreak({
      previousFields: ['tickSize', 'lotSize'],
      nextFields: ['tickSize'],
    });
    expect(result?.reason).toBe('deprecation_unset');
  });

  it('refuses a deprecated removal without changelog', () => {
    const result = refuseSilentContractBreak({
      previousFields: ['tickSize', 'lotSize'],
      nextFields: ['tickSize'],
      deprecated: ['lotSize'],
    });
    expect(result?.reason).toBe('silent_break');
  });

  it('allows a named deprecation with changelog', () => {
    expect(
      refuseSilentContractBreak({
        previousFields: ['tickSize', 'lotSize'],
        nextFields: ['tickSize'],
        deprecated: ['lotSize'],
        changelog: 'lotSize removed after deprecation window',
      }),
    ).toBeNull();
  });
});

describe('CARD G-developer SDK decimal handling', () => {
  it('refuses IEEE / JS number money', () => {
    expect(refuseIeeeSdkMoney({ ieee: true })?.reason).toBe('ieee_money');
    expect(refuseIeeeSdkMoney({ wireType: 'number' })?.reason).toBe('ieee_money');
    expect(refuseIeeeSdkMoney({ jsType: 'number' })?.reason).toBe('ieee_money');
    expect(refuseIeeeSdkMoney({ format: 'double' })?.reason).toBe('ieee_money');
  });

  it('refuses unset decimal handling', () => {
    expect(refuseIeeeSdkMoney({ wireType: 'integer' })?.reason).toBe('decimal_unset');
  });

  it('accepts an explicit decimal string', () => {
    expect(refuseIeeeSdkMoney({ wireType: 'string', format: 'decimal' })).toBeNull();
  });
});
