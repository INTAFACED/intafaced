import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { founderCall } from '@/lib/desk/founder-call';
import { refusalWords } from '@/lib/compliance-cases/model';

/**
 * Case room writes as the signed-in founder: favourite an inbox and define a queue (svc-ops `compliance.inboxes.*`). The service
 * decides membership and the second factor; this route only carries the call and says what came back. A reply that never arrived
 * is reported as unknown, never as failed, and is never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

type Body =
  | { action: 'favourite'; inboxId: string; favourite: boolean }
  | { action: 'define'; name: string; version: number; entityType: string; workflow: string; members: string[] };

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null;

function parseBody(raw: Record<string, unknown>): Body | null {
  if (raw.action === 'favourite') {
    const inboxId = text(raw.inboxId, 128);
    return inboxId && typeof raw.favourite === 'boolean' ? { action: 'favourite', inboxId, favourite: raw.favourite } : null;
  }
  if (raw.action === 'define') {
    const name = text(raw.name, 80);
    const entityType = text(raw.entityType, 40);
    const workflow = text(raw.workflow, 80);
    const members = Array.isArray(raw.members) ? raw.members.map((m) => text(m, 128)) : null;
    const version = raw.version;
    if (!name || !entityType || !workflow || !members || members.length > 200 || members.includes(null)) return null;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 9999) return null;
    return { action: 'define', name, version, entityType, workflow, members: members as string[] };
  }
  return null;
}

const accepted = (raw: unknown): { ok: true } | null => (raw && typeof raw === 'object' ? { ok: true } : null);

function answer(payload: Record<string, unknown>, status: number): Response {
  return Response.json(payload, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('jurisdiction');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const input = parseBody(raw);
  if (!input) return answer({ ok: false, code: 'admin.request_invalid', message: 'That request was not accepted. Nothing was sent.' }, 400);

  const result =
    input.action === 'favourite'
      ? await founderCall(
          session,
          'ops',
          'compliance.inboxes.setFavourite',
          'POST',
          { inboxId: input.inboxId, favourite: input.favourite },
          accepted,
        )
      : await founderCall(
          session,
          'ops',
          'compliance.inboxes.define',
          'POST',
          { name: input.name, version: input.version, entityType: input.entityType, workflow: input.workflow, members: input.members },
          accepted,
        );
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message: refusalWords(result.refusal.code) ?? 'svc-ops did not accept this session for that.',
        },
        403,
      );
    case 'refused':
      return answer({ ok: false, code: result.refusal.code, message: refusalWords(result.refusal.code) ?? 'svc-ops refused this.' }, 409);
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-ops has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-ops answered in a shape this console does not understand. Reload to see what was stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-ops did not answer. Reload to see what was stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
