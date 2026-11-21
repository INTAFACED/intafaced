import 'server-only';
import { createHash } from 'node:crypto';
import { type FounderCallContext, partFrom, founderRecordRead } from '@/lib/desk';
import { readDefinition } from './status-model';
import { NOTIFY, anyData, loadPublishApprovals, reply } from './incidents-server';
import { readWindows, type MaintenanceDeskView, type MaintenanceDraftInput, type MaintenanceTarget } from './maintenance-model';
import { NOTIFY_DRAFT_NOTICE } from '@intafaced/contracts/notify-notify-procedures';
import {
  NOTIFY_STATUS_PAGE_DEFINITION,
  NOTIFY_STATUS_PAGE_MAINTENANCE_WINDOWS,
  NOTIFY_STATUS_PAGE_MAINTENANCE_MOVE,
} from '@intafaced/contracts/notify-status-page-procedures';

/**
 * The maintenance desk as the signed-in founder. svc-notify holds the windows with their derived state, moves and
 * reminders (`statusPage.maintenance.windows`), takes drafts and publishes on the notice board (`notify.draftNotice`
 * and the same four-eyes publish as incidents), and takes the operators' moves (`statusPage.maintenance.move`).
 */

const LIST_LIMIT = 50;

export async function loadMaintenanceDesk(ctx: FounderCallContext): Promise<MaintenanceDeskView> {
  const [windows, definition, approvals] = await Promise.all([
    founderRecordRead(ctx, NOTIFY_STATUS_PAGE_MAINTENANCE_WINDOWS, { limit: LIST_LIMIT }, readWindows),
    founderRecordRead(ctx, NOTIFY_STATUS_PAGE_DEFINITION, undefined, readDefinition),
    loadPublishApprovals(ctx),
  ]);
  return {
    windows: partFrom(windows, (d) => d, NOTIFY),
    components: partFrom(definition, (d) => d.components.map((c) => ({ id: c.id, name: c.name })), NOTIFY),
    approvals,
    me: ctx.session.userId,
    asOf: new Date().toISOString(),
  };
}

/**
 * The draft's key is its content and the newest window the founder saw when writing it (`basis`): a lost reply sent
 * again finds the same draft, while the same window written again after the desk moved on is a new draft.
 */
export function maintenanceDraftKey(founder: string, input: MaintenanceDraftInput & { basis: string | null }): string {
  const fields = [
    input.basis,
    input.title.trim(),
    input.body.trim(),
    input.startsAt,
    input.endsAt,
    [...input.components].sort(),
    [...input.reminderOffsets].sort((a, b) => b - a),
  ];
  return `maintenance-draft:${createHash('sha256')
    .update(JSON.stringify([founder, fields]))
    .digest('hex')
    .slice(0, 48)}`;
}

export async function draftMaintenance(ctx: FounderCallContext, input: MaintenanceDraftInput & { basis: string | null }) {
  return reply(
    await founderRecordRead(
      ctx,
      NOTIFY_DRAFT_NOTICE,
      {
        kind: 'maintenance',
        title: input.title.trim(),
        body: input.body.trim(),
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        components: input.components.length > 0 ? input.components : null,
        reminderOffsets: input.reminderOffsets.length > 0 ? input.reminderOffsets : null,
        clientRequestId: maintenanceDraftKey(ctx.session.userId, input),
      },
      anyData,
    ),
    'drafted',
  );
}

/** One operator move with its reason. The same move again answers the window as it stands. */
export async function moveMaintenance(ctx: FounderCallContext, input: { id: string; to: MaintenanceTarget; reason: string }) {
  return reply(
    await founderRecordRead(ctx, NOTIFY_STATUS_PAGE_MAINTENANCE_MOVE, { ...input, reason: input.reason.trim() }, anyData),
    `moved to ${input.to.replace('_', ' ')}`,
  );
}
