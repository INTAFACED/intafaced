/**
 * Generate the merchant Payments SDKs from the live public REST OpenAPI mount.
 *
 *   pnpm exec tsx tooling/scripts/sdk-from-openapi.ts
 *   pnpm exec tsx tooling/scripts/sdk-from-openapi.ts --check
 *
 * --check fails when the committed spec or generated clients drift. It does not
 * publish. Founder and operator paths are refused.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

const BANNED = /founderAdmin|founder-admin|founder_admin|payHalts|operatorStatus|(^|\/)operator(\/|$)/i;

interface OperationParameter {
  readonly in?: string;
  readonly name?: string;
}

interface OperationObject {
  readonly summary?: string;
  readonly operationId?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly OperationParameter[];
}

interface OpenApiDocument {
  readonly paths?: Record<string, Record<string, OperationObject | undefined>>;
  readonly [key: string]: unknown;
}

export interface SdkOperation {
  readonly method: string;
  readonly path: string;
  readonly name: string;
  readonly pyName: string;
  readonly idempotency: boolean;
  readonly pathParams: readonly string[];
  readonly summary: string;
}

export function assertMerchantSurface(spec: OpenApiDocument): void {
  const paths = spec.paths ?? {};
  for (const path of Object.keys(paths)) {
    if (BANNED.test(path)) throw new Error(`merchant OpenAPI contains a non-merchant path: ${path}`);
    const item = paths[path] ?? {};
    for (const method of Object.keys(item)) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      if (op.operationId && BANNED.test(op.operationId)) {
        throw new Error(`merchant OpenAPI operation is not a merchant path: ${op.operationId}`);
      }
      for (const tag of op.tags ?? []) {
        if (BANNED.test(tag)) throw new Error(`merchant OpenAPI tag is not a merchant path: ${tag}`);
      }
      if (op.summary && BANNED.test(op.summary)) {
        throw new Error(`merchant OpenAPI summary is not a merchant path: ${path} ${method}`);
      }
    }
  }
}

function pascal(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function snake(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

export function operationsFromSpec(spec: OpenApiDocument): SdkOperation[] {
  assertMerchantSurface(spec);
  const ops: SdkOperation[] = [];
  const names = new Set<string>();
  for (const path of Object.keys(spec.paths ?? {}).sort()) {
    const item = spec.paths?.[path] ?? {};
    for (const method of HTTP) {
      const op = item[method];
      if (!op) continue;
      const params = pathParams(path);
      const tsBits = [method];
      const pyBits = [method];
      for (const segment of path.split('/').filter(Boolean)) {
        if (segment.startsWith('{') && segment.endsWith('}')) {
          const name = segment.slice(1, -1);
          tsBits.push(`By${pascal(name)}`);
          pyBits.push(`by_${snake(name)}`);
        } else {
          tsBits.push(pascal(segment));
          pyBits.push(snake(segment));
        }
      }
      const name = tsBits.join('');
      const pyName = pyBits.join('_');
      if (names.has(name) || names.has(pyName)) throw new Error(`duplicate SDK operation name: ${name}`);
      if (BANNED.test(name) || BANNED.test(pyName)) throw new Error(`SDK operation is not a merchant path: ${name}`);
      names.add(name);
      names.add(pyName);
      const declared = (op.parameters ?? []).some((param) => param.in === 'header' && param.name?.toLowerCase() === 'idempotency-key');
      ops.push({
        method: method.toUpperCase(),
        path,
        name,
        pyName,
        idempotency: method === 'post' || declared,
        pathParams: params,
        summary: (op.summary ?? '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  if (ops.length === 0) throw new Error('merchant OpenAPI has no operations');
  return ops;
}

function tsInput(op: SdkOperation): string {
  if (op.pathParams.length === 0) return 'PayCallInput';
  const fields = op.pathParams.map((name) => `readonly ${name}: string`).join('; ');
  return `PayCallInput & { readonly params: { ${fields} } }`;
}

function comment(summary: string): string {
  const clean = summary.replace(/\*\//g, '* /');
  return clean ? `  /** ${clean} */\n` : '';
}

export function renderTypeScript(ops: readonly SdkOperation[]): string {
  const iface = ops.map((op) => `${comment(op.summary)}  ${op.name}(input: ${tsInput(op)}): Promise<PayResponse>;`).join('\n');
  const body = ops
    .map(
      (op) =>
        `    ${op.name}(input) {\n      return client.call({ ...input, method: '${op.method}', path: '${op.path}', idempotency: ${op.idempotency} });\n    },`,
    )
    .join('\n');
  return `// Generated from the Payments OpenAPI document. Do not edit.
// Regenerate: pnpm exec tsx tooling/scripts/sdk-from-openapi.ts
import type { PayCallInput, PayClient, PayResponse } from './client.js';

export interface PayOperations {
${iface}
}

export function bindOperations(client: PayClient): PayOperations {
  return {
${body}
  };
}
`;
}

function pyDoc(op: SdkOperation): string {
  const summary = op.summary.replace(/"""/g, "'''");
  const line = summary ? `${op.method} ${op.path} — ${summary}` : `${op.method} ${op.path}`;
  return `        """${line}"""`;
}

export function renderPython(ops: readonly SdkOperation[]): string {
  const methods = ops
    .map(
      (op) => `    def ${op.pyName}(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
${pyDoc(op)}
        return self._client.call(
            "${op.method}",
            "${op.path}",
            body=body,
            query=query,
            params=params,
            idempotency=${op.idempotency ? 'True' : 'False'},
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )
`,
    )
    .join('\n');
  return `"""Generated from the Payments OpenAPI document. Do not edit.

Regenerate: pnpm exec tsx tooling/scripts/sdk-from-openapi.ts
"""

from __future__ import annotations

from intafaced_pay.client import PayClient


class PayOperations:
    def __init__(self, client: PayClient) -> None:
        self._client = client

${methods}
`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function canonicalSpec(spec: unknown): unknown {
  return sortValue(spec);
}

const OUTPUTS = {
  specTs: 'packages/sdk-ts/openapi/payments.openapi.json',
  specPy: 'sdks/python/openapi/payments.openapi.json',
  ts: 'packages/sdk-ts/src/operations.ts',
  py: 'sdks/python/intafaced_pay/operations.py',
} as const;

async function format(source: string, filepath: string): Promise<string> {
  const config = (await prettier.resolveConfig(join(repoRoot, filepath))) ?? {};
  return prettier.format(source, { ...config, filepath });
}

function dumpSpec(): OpenApiDocument {
  const raw = execFileSync('pnpm', ['--filter', '@intafaced/svc-pay', 'exec', 'tsx', 'scripts/dump-openapi.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('OpenAPI dump was not JSON');
  return JSON.parse(raw.slice(start, end + 1)) as OpenApiDocument;
}

async function renderedFiles(spec: OpenApiDocument): Promise<Record<string, string>> {
  const canonical = canonicalSpec(spec);
  assertMerchantSurface(canonical as OpenApiDocument);
  const ops = operationsFromSpec(canonical as OpenApiDocument);
  const specText = await format(`${JSON.stringify(canonical, null, 2)}\n`, OUTPUTS.specTs);
  const ts = await format(renderTypeScript(ops), OUTPUTS.ts);
  if (BANNED.test(ts) || BANNED.test(renderPython(ops))) throw new Error('generated SDK contains a non-merchant path');
  return {
    [OUTPUTS.specTs]: specText,
    [OUTPUTS.specPy]: specText,
    [OUTPUTS.ts]: ts,
    [OUTPUTS.py]: renderPython(ops),
  };
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const files = await renderedFiles(dumpSpec());
  const drifted: string[] = [];
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(repoRoot, relative);
    if (check) {
      if (readOrEmpty(absolute) !== contents) drifted.push(relative);
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  if (drifted.length > 0) {
    throw new Error(`SDK spec drift. Regenerate with tooling/scripts/sdk-from-openapi.ts:\n${drifted.join('\n')}`);
  }
  if (!check) process.stdout.write(`wrote ${Object.keys(files).length} SDK files\n`);
}

const entry = process.argv[1] ?? '';
if (entry.includes('sdk-from-openapi')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
