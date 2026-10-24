/**
 * G-developer (PTX-M19-R02, PTX-M19-R04, PTX-M19-R05, PTX-M05-R08).
 * OpenAPI from existing Zod 4 via @asteasolutions/zod-to-openapi@8.5.0.
 * Changelog/deprecation is contractual. SDK money is an explicit decimal
 * string. svc-fix is not recut — FIX OpenAPI refuses here.
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { instrumentIdSchema, instrumentSchema, quoteConventionSchema } from './instruments.js';

export const ZOD_TO_OPENAPI = '@asteasolutions/zod-to-openapi' as const;
export const ZOD_TO_OPENAPI_VERSION = '8.5.0' as const;

export type DeveloperRefuseReason =
  'openapi_unset' | 'schema_unregistered' | 'ieee_money' | 'decimal_unset' | 'deprecation_unset' | 'silent_break' | 'svc_fix_not_this_pr';

export type DeveloperRefusal = {
  readonly ok: false;
  readonly reason: DeveloperRefuseReason;
  readonly detail: string;
};

export type OpenApiDocument = {
  readonly ok: true;
  readonly openapi: '3.0.3';
  readonly adapter: typeof ZOD_TO_OPENAPI;
  readonly adapterVersion: typeof ZOD_TO_OPENAPI_VERSION;
  readonly document: {
    readonly openapi: string;
    readonly info: { readonly title: string; readonly version: string };
    readonly components?: { readonly schemas?: Record<string, unknown> };
  };
};

function refuse(reason: DeveloperRefuseReason, detail: string): DeveloperRefusal {
  return { ok: false, reason, detail };
}

const MONEY = /^(tickSize|lotSize|minQty|maxQty|minNotional|unitSize|pipSize|price|qty|quantity|amount|notional)$/i;

type ZodToOpenApi = {
  extendZodWithOpenApi: (zod: typeof z) => void;
  OpenAPIRegistry: new () => {
    register: (name: string, schema: z.ZodTypeAny) => unknown;
    definitions: unknown;
  };
  OpenApiGeneratorV3: new (definitions: unknown) => {
    generateDocument: (config: { openapi: string; info: { title: string; version: string } }) => {
      openapi: string;
      info: { title: string; version: string };
      components?: { schemas?: Record<string, unknown> };
    };
  };
};

function isRefusal(value: ZodToOpenApi | DeveloperRefusal): value is DeveloperRefusal {
  return 'ok' in value && value.ok === false;
}

function loadAdapter(): ZodToOpenApi | DeveloperRefusal {
  try {
    const loaded = createRequire(import.meta.url)(ZOD_TO_OPENAPI) as ZodToOpenApi;
    if (!loaded?.extendZodWithOpenApi || !loaded.OpenAPIRegistry || !loaded.OpenApiGeneratorV3) {
      return refuse('openapi_unset', `${ZOD_TO_OPENAPI}@${ZOD_TO_OPENAPI_VERSION} is unwired — refusing rather than inventing OpenAPI`);
    }
    return loaded;
  } catch {
    return refuse('openapi_unset', `${ZOD_TO_OPENAPI}@${ZOD_TO_OPENAPI_VERSION} is missing — refusing rather than inventing OpenAPI`);
  }
}

export function refuseFixOpenApiThisPr(surface?: string | null): DeveloperRefusal | null {
  const value = surface?.trim().toLowerCase() ?? '';
  if (value === 'fix' || value === 'svc-fix' || value === 'quickfix') {
    return refuse('svc_fix_not_this_pr', 'FIX OpenAPI is svc-fix — not recut this PR');
  }
  return null;
}

/** SDK decimal handling is explicit. IEEE / JS number money refuses. */
export function refuseIeeeSdkMoney(input: {
  readonly wireType?: string | null;
  readonly format?: string | null;
  readonly jsType?: string | null;
  readonly ieee?: boolean;
}): DeveloperRefusal | null {
  const wire = input.wireType?.trim().toLowerCase() ?? '';
  const format = input.format?.trim().toLowerCase() ?? '';
  const js = input.jsType?.trim().toLowerCase() ?? '';
  if (input.ieee === true || wire === 'number' || js === 'number' || format === 'float' || format === 'double') {
    return refuse('ieee_money', 'SDK money is a decimal string — IEEE / JS number refuses');
  }
  if (input.wireType !== undefined && wire !== 'string') {
    return refuse('decimal_unset', 'SDK decimal handling is unset — money must be an explicit decimal string');
  }
  return null;
}

/** Changelog/deprecation is contractual. A removed field without both refuses. */
export function refuseSilentContractBreak(input: {
  readonly previousFields: readonly string[];
  readonly nextFields: readonly string[];
  readonly deprecated?: readonly string[];
  readonly changelog?: string | null;
}): DeveloperRefusal | null {
  const next = new Set(input.nextFields);
  const removed = input.previousFields.filter((field) => !next.has(field));
  if (removed.length === 0) return null;
  const deprecated = new Set(input.deprecated ?? []);
  const undeclared = removed.filter((field) => !deprecated.has(field));
  if (undeclared.length > 0) {
    return refuse('deprecation_unset', `removed ${undeclared.join(',')} without deprecation — refusing a silent break`);
  }
  if (!input.changelog?.trim()) {
    return refuse('silent_break', 'deprecated removal without changelog — refusing a silent break');
  }
  return null;
}

function schemaHasNumberMoney(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const rec = schema as Record<string, unknown>;
  if (rec.type === 'number' || rec.format === 'float' || rec.format === 'double') return true;
  const properties = rec.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      if (MONEY.test(key) && schemaHasNumberMoney(value)) return true;
    }
  }
  return false;
}

function refuseNumberMoneyInDocument(document: { components?: { schemas?: Record<string, unknown> } }): DeveloperRefusal | null {
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    if (schemaHasNumberMoney(schema)) {
      return refuse('ieee_money', `OpenAPI ${name} money is number — decimal string required`);
    }
  }
  return null;
}

const HITCHED: Readonly<Record<string, z.ZodTypeAny>> = {
  InstrumentId: instrumentIdSchema,
  QuoteConvention: quoteConventionSchema,
  Instrument: instrumentSchema,
};

export function generateOpenApiFromZod(
  input: {
    readonly schemas?: Readonly<Record<string, z.ZodTypeAny | undefined>>;
    readonly title?: string;
    readonly version?: string;
    readonly surface?: string | null;
    readonly adapterVersion?: string | null;
  } = {},
): OpenApiDocument | DeveloperRefusal {
  const fix = refuseFixOpenApiThisPr(input.surface);
  if (fix) return fix;
  if (input.adapterVersion !== undefined && input.adapterVersion !== ZOD_TO_OPENAPI_VERSION) {
    return refuse(
      'openapi_unset',
      `OpenAPI adapter must be ${ZOD_TO_OPENAPI}@${ZOD_TO_OPENAPI_VERSION} — refusing ${input.adapterVersion ?? 'unset'}`,
    );
  }

  const schemas = input.schemas ?? HITCHED;
  const names = Object.keys(schemas);
  if (names.length === 0 || names.some((name) => !name.trim())) {
    return refuse('schema_unregistered', 'unregistered schema refuses — OpenAPI is not invented');
  }
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema) {
      return refuse('schema_unregistered', `${name} is unregistered — refusing rather than inventing OpenAPI`);
    }
  }

  const adapter = loadAdapter();
  if (isRefusal(adapter)) return adapter;

  try {
    adapter.extendZodWithOpenApi(z);
    const registry = new adapter.OpenAPIRegistry();
    for (const [name, schema] of Object.entries(schemas)) {
      // zod-to-openapi 8 only adds `.openapi()` to schemas built after
      // extendZodWithOpenApi; a clone is built now, so it has the method.
      if (schema) registry.register(name, schema.clone());
    }
    const document = new adapter.OpenApiGeneratorV3(registry.definitions).generateDocument({
      openapi: '3.0.3',
      info: {
        title: input.title ?? '@intafaced/contracts',
        version: input.version ?? '0.0.0',
      },
    });
    const ieee = refuseNumberMoneyInDocument(document);
    if (ieee) return ieee;
    return {
      ok: true,
      openapi: '3.0.3',
      adapter: ZOD_TO_OPENAPI,
      adapterVersion: ZOD_TO_OPENAPI_VERSION,
      document,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    return refuse('schema_unregistered', `Zod schema did not register through ${ZOD_TO_OPENAPI}@${ZOD_TO_OPENAPI_VERSION} — ${message}`);
  }
}
