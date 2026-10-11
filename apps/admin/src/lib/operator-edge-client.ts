import 'server-only';
import { describeUnconfigured, readConsoleStatus, type Authority } from '@/lib/console-status';
import { toolById, type OperatorTool, type ToolAuthority } from '@/lib/operator-tools-catalog';

/**
 * Server-side hop from apps/admin to svc-edge `/api/<module>/trpc/<procedure>`.
 *
 * Tokens never leave this process. A missing EDGE_URL / authority token is a
 * 503 with a named variable — never a synthetic success body for money ops.
 */

const TIMEOUT_MS = 15_000;

export type WireStatus = 'wired' | 'not-wired';

export interface ToolWireState {
  readonly toolId: string;
  readonly wire: WireStatus;
  /** Variable names that would make this tool live. Empty when wired. */
  readonly missing: readonly string[];
  readonly detail: string | null;
  readonly authority: ToolAuthority;
  readonly scope: string;
  readonly consequential: boolean;
}

export interface InvokeResult {
  readonly ok: boolean;
  readonly status: number;
  /** Always present when !ok; null only on ok. */
  readonly detail: string | null;
  /** True only when this process sent a request to the edge. */
  readonly delivered: boolean;
  /** tRPC / upstream payload when anything parseable came back. */
  readonly data: unknown;
  readonly toolId: string;
  readonly procedure: string;
  readonly edgePath: string | null;
}

function authorityOf(tool: OperatorTool): Authority {
  return tool.authority === 'treasury' ? 'treasury' : 'module';
}

function configFor(
  tool: OperatorTool,
  interactiveToken?: string,
): { edgeUrl: string; token: string } | { reason: string; missing: readonly string[] } {
  if (interactiveToken !== undefined) {
    const edgeUrl = process.env.EDGE_URL?.trim().replace(/\/$/, '');
    return edgeUrl && interactiveToken
      ? { edgeUrl, token: interactiveToken }
      : { reason: 'EDGE_URL or individual session is unavailable', missing: ['EDGE_URL'] };
  }
  const status = readConsoleStatus();
  const auth = authorityOf(tool);
  const state = status[auth];
  if (!state.configured || !status.edgeUrl) {
    return { reason: describeUnconfigured(state), missing: state.missing };
  }
  return { edgeUrl: status.edgeUrl, token: (process.env[state.tokenVar] ?? '').trim() };
}

export function wireStateFor(tool: OperatorTool, interactiveToken?: string): ToolWireState {
  const cfg = configFor(tool, interactiveToken);
  if ('reason' in cfg) {
    return {
      toolId: tool.id,
      wire: 'not-wired',
      missing: cfg.missing,
      detail: cfg.reason,
      authority: tool.authority,
      scope: tool.scope,
      consequential: tool.consequential,
    };
  }
  return {
    toolId: tool.id,
    wire: 'wired',
    missing: [],
    detail: null,
    authority: tool.authority,
    scope: tool.scope,
    consequential: tool.consequential,
  };
}

export function listToolWireStates(tools: readonly OperatorTool[], interactiveToken?: string): readonly ToolWireState[] {
  return tools.map((tool) => wireStateFor(tool, interactiveToken));
}

/**
 * Coerce form values into the shape the procedure expects.
 * Empty strings for optional fields are dropped; JSON fields are parsed.
 */
export function coerceToolInput(tool: OperatorTool, raw: Record<string, unknown>): { input: unknown } | { error: string } {
  const out: Record<string, unknown> = {};

  for (const field of tool.fields) {
    const value = raw[field.name];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value === 'number' && Number.isNaN(value));

    if (empty) {
      if (field.required) return { error: `${field.name} is required` };
      continue;
    }

    if (field.type === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) return { error: `${field.name} must be a number` };
      out[field.name] = n;
      continue;
    }

    if (field.type === 'boolean') {
      if (typeof value === 'boolean') out[field.name] = value;
      else if (value === 'true' || value === '1') out[field.name] = true;
      else if (value === 'false' || value === '0') out[field.name] = false;
      else return { error: `${field.name} must be a boolean` };
      continue;
    }

    if (field.type === 'json') {
      if (typeof value !== 'string') return { error: `${field.name} must be a JSON string` };
      try {
        out[field.name] = JSON.parse(value);
      } catch {
        return { error: `${field.name} is not valid JSON` };
      }
      continue;
    }

    if (field.type === 'enum') {
      const s = String(value).trim();
      if (field.enumValues && !field.enumValues.includes(s)) {
        return { error: `${field.name} must be one of: ${field.enumValues.join(', ')}` };
      }
      out[field.name] = s;
      continue;
    }

    // string | uuid
    out[field.name] = String(value).trim();
  }

  // Procedures with optional empty object input (e.g. mintEpoch {}) keep {}.
  return { input: out };
}

function edgePath(tool: OperatorTool): string {
  return `/api/${tool.edgeModule}/trpc/${tool.procedure}`;
}

/**
 * Unwrap tRPC HTTP response. Services in this monorepo return either a bare
 * result, `{ result: { data } }`, or `{ result: { data: { json } } }`.
 */
function unwrapTrpc(body: unknown): { data: unknown; error: string | null } {
  if (body == null) return { data: null, error: null };
  if (typeof body !== 'object') return { data: body, error: null };

  const b = body as {
    error?: { message?: string; code?: string; data?: { code?: string; httpStatus?: number } };
    result?: { data?: { json?: unknown } | unknown };
    message?: string;
  };

  if (b.error) {
    const msg = b.error.message ?? b.message ?? 'tRPC procedure refused';
    const code = b.error.code ?? b.error.data?.code;
    return { data: body, error: code ? `${msg} (${code})` : msg };
  }

  if (b.result && 'data' in b.result) {
    const data = b.result.data;
    if (data != null && typeof data === 'object' && data !== null && 'json' in (data as object)) {
      return { data: (data as { json: unknown }).json, error: null };
    }
    return { data, error: null };
  }

  return { data: body, error: null };
}

export async function invokeOperatorTool(
  toolId: string,
  rawInput: Record<string, unknown>,
  interactiveToken?: string,
): Promise<InvokeResult> {
  const tool = toolById(toolId);
  if (!tool) {
    return {
      ok: false,
      status: 404,
      detail: `Unknown operator tool "${toolId}"`,
      delivered: false,
      data: null,
      toolId,
      procedure: '',
      edgePath: null,
    };
  }

  const cfg = configFor(tool, interactiveToken);
  if ('reason' in cfg) {
    return {
      ok: false,
      status: 503,
      detail: cfg.reason,
      delivered: false,
      data: { wire: 'not-wired', missing: cfg.missing },
      toolId: tool.id,
      procedure: tool.procedure,
      edgePath: edgePath(tool),
    };
  }

  const coerced = coerceToolInput(tool, rawInput);
  if ('error' in coerced) {
    return {
      ok: false,
      status: 400,
      detail: coerced.error,
      delivered: false,
      data: null,
      toolId: tool.id,
      procedure: tool.procedure,
      edgePath: edgePath(tool),
    };
  }

  const path = edgePath(tool);
  const urlBase = `${cfg.edgeUrl}${path}`;
  const input = coerced.input;

  try {
    let res: Response;
    if (tool.kind === 'query') {
      // No transformer on platform services — GET input is the bare object
      // (see services/svc-pay/scripts/card-sandbox-e2e.mjs).
      const hasKeys = input != null && typeof input === 'object' && Object.keys(input as object).length > 0;
      const qs = hasKeys ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
      res = await fetch(`${urlBase}${qs}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } else {
      res = await fetch(urlBase, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        // Bare input object — matches card-sandbox e2e; edge also accepts { json }.
        body: JSON.stringify(input ?? {}),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }

    const body = await res.json().catch(() => null);
    const unwrapped = unwrapTrpc(body);

    if (!res.ok || unwrapped.error) {
      return {
        ok: false,
        status: res.status,
        detail:
          unwrapped.error ??
          (body && typeof body === 'object' && 'error' in (body as object)
            ? String((body as { error?: unknown }).error)
            : `svc-edge answered ${res.status}`),
        delivered: true,
        data: unwrapped.data ?? body,
        toolId: tool.id,
        procedure: tool.procedure,
        edgePath: path,
      };
    }

    return {
      ok: true,
      status: res.status,
      detail: null,
      delivered: true,
      data: unwrapped.data,
      toolId: tool.id,
      procedure: tool.procedure,
      edgePath: path,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      detail: `svc-edge did not answer: ${(err as Error).message}`,
      delivered: true,
      data: null,
      toolId: tool.id,
      procedure: tool.procedure,
      edgePath: path,
    };
  }
}
