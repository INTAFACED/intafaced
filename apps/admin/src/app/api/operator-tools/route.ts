import { adminBffGate } from '@/lib/admin-bff-gate';
import { invokeOperatorTool, listToolWireStates } from '@/lib/operator-edge-client';
import { OPERATOR_TOOLS, toolById, usesAccountConsole } from '@/lib/operator-tools-catalog';
import { readConsoleStatus } from '@/lib/console-status';
import { adminSessionConfig, openFounderSession } from '@/lib/founder-session';

/**
 * Operator tools BFF — list wired procedures and invoke them via edge tRPC.
 *
 * GET  → catalog + per-tool wire status (never invents a live platform answer)
 * POST → invoke one tool; tokens stay server-side
 *
 * Missing EDGE_URL / authority token → 503 with wire: not-wired, never a green
 * local success for money or compliance mutations.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;

  const status = readConsoleStatus();
  const session = openFounderSession(request.headers.get('cookie'), adminSessionConfig());
  const tools = OPERATOR_TOOLS.map((tool) => {
    const wire = listToolWireStates([tool], session.accessToken)[0]!;
    return {
      id: tool.id,
      group: tool.group,
      label: tool.label,
      summary: tool.summary,
      procedure: tool.procedure,
      edgeModule: tool.edgeModule,
      kind: tool.kind,
      authority: tool.authority,
      scope: tool.scope,
      consequential: tool.consequential,
      fields: tool.fields,
      wire: wire.wire,
      missing: wire.missing,
      detail: wire.detail,
    };
  });

  return Response.json({
    edgeUrl: status.edgeUrl,
    moduleConfigured: status.module.configured,
    treasuryConfigured: status.treasury.configured,
    tools,
    residual: {
      reconcile: 'simulated — svc-edge has no reconcile route; see /ledger',
      sso: 'Current interactive founder identity is required for every request',
    },
  });
}

export async function POST(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'a JSON body is required', code: 'admin.operator_tools.bad_body' }, { status: 400 });
  }

  const input = body as { toolId?: unknown; input?: unknown };
  if (typeof input.toolId !== 'string' || input.toolId.trim().length === 0) {
    return Response.json({ error: 'toolId is required', code: 'admin.operator_tools.tool_id' }, { status: 400 });
  }

  const tool = toolById(input.toolId.trim());
  if (!tool) {
    return Response.json({ error: `unknown toolId "${input.toolId}"`, code: 'admin.operator_tools.unknown' }, { status: 404 });
  }
  if (usesAccountConsole(tool.id)) {
    return Response.json(
      { error: 'Inspect this account in Account controls.', code: 'admin.account_console_required', href: '/accounts' },
      { status: 409 },
    );
  }

  const rawInput =
    input.input != null && typeof input.input === 'object' && !Array.isArray(input.input) ? (input.input as Record<string, unknown>) : {};

  const session = openFounderSession(request.headers.get('cookie'), adminSessionConfig());
  const result = await invokeOperatorTool(tool.id, rawInput, session.accessToken);
  // Pass through the real status. A not-wired console is 503; a scope refuse
  // from the service is whatever the edge returned — never forced to 200.
  return Response.json(result, { status: result.ok ? 200 : result.status });
}
