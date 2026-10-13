/**
 * Browser hop to this app's `/api/operator-tools` route.
 * Edge tokens never leave the server.
 */

import { founderMutationHeaders } from './founder-browser';

export interface ToolListItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly summary: string;
  readonly procedure: string;
  readonly edgeModule: string;
  readonly kind: 'query' | 'mutation';
  readonly authority: 'module' | 'treasury';
  readonly scope: string;
  readonly consequential: boolean;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly label: string;
    readonly required?: boolean;
    readonly placeholder?: string;
    readonly enumValues?: readonly string[];
    readonly hint?: string;
  }[];
  readonly wire: 'wired' | 'not-wired';
  readonly missing: readonly string[];
  readonly detail: string | null;
}

export interface ToolListResponse {
  readonly edgeUrl: string | null;
  readonly moduleConfigured: boolean;
  readonly treasuryConfigured: boolean;
  readonly tools: readonly ToolListItem[];
  readonly residual?: { reconcile?: string; sso?: string };
  readonly error?: string;
}

export interface InvokeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly detail: string | null;
  readonly delivered: boolean;
  readonly data: unknown;
  readonly toolId: string;
  readonly procedure: string;
  readonly edgePath: string | null;
  readonly error?: string;
}

export async function fetchOperatorTools(): Promise<ToolListResponse> {
  try {
    const res = await fetch('/api/operator-tools', { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as Partial<ToolListResponse> & { error?: string };
    if (!res.ok && !body.tools) {
      return {
        edgeUrl: null,
        moduleConfigured: false,
        treasuryConfigured: false,
        tools: [],
        error: body.error ?? `console /api/operator-tools answered ${res.status}`,
      };
    }
    return {
      edgeUrl: body.edgeUrl ?? null,
      moduleConfigured: body.moduleConfigured ?? false,
      treasuryConfigured: body.treasuryConfigured ?? false,
      tools: body.tools ?? [],
      residual: body.residual,
      error: body.error,
    };
  } catch (err) {
    return {
      edgeUrl: null,
      moduleConfigured: false,
      treasuryConfigured: false,
      tools: [],
      error: (err as Error).message,
    };
  }
}

export async function invokeOperatorToolBrowser(toolId: string, input: Record<string, unknown>): Promise<InvokeResponse> {
  try {
    const res = await fetch('/api/operator-tools', {
      method: 'POST',
      headers: await founderMutationHeaders(),
      body: JSON.stringify({ toolId, input }),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as Partial<InvokeResponse> & { error?: string };
    if (typeof body.ok === 'boolean') {
      return {
        ok: body.ok,
        status: body.status ?? res.status,
        detail: body.detail ?? body.error ?? null,
        delivered: body.delivered ?? false,
        data: body.data ?? null,
        toolId: body.toolId ?? toolId,
        procedure: body.procedure ?? '',
        edgePath: body.edgePath ?? null,
      };
    }
    return {
      ok: false,
      status: res.status,
      detail: body.error ?? `console /api/operator-tools answered ${res.status}`,
      delivered: false,
      data: null,
      toolId,
      procedure: '',
      edgePath: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      detail: (err as Error).message,
      delivered: false,
      data: null,
      toolId,
      procedure: '',
      edgePath: null,
    };
  }
}
