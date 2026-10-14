/**
 * One timeline per person: the activity history (notes, stage and owner changes, replies, commitments, questionnaires) and the
 * messages we queued, newest first. A stage change reads "New → Qualified"; an entry written before the stage was recorded keeps
 * its reason text and its older title. Pure functions.
 */
import type { CrmActivity } from '@intafaced/contracts';
import { crmDate } from '@/lib/crm-browser';
import { formatMoney, sentence, stageLabel } from './format';

export type TimelineMessage = {
  id: string;
  kind: string;
  status: string;
  staffText: string | null;
  actorUserId: string;
  createdAt: string;
};
export type TimelineOwner = { userId: string; displayName: string };
export type TimelineItem = {
  id: string;
  at: string;
  title: string;
  detail: string | null;
  /** Who did it: a founder's name, "System" or "Enquirer". */
  who: string;
  /** The activity kind, or "message" for a message with no activity of its own. Drives the marker. */
  kind: string;
};

const MESSAGE_KIND: Record<string, string> = {
  information_request: 'Information request',
  call_invitation: 'Call invitation',
  follow_up: 'Follow-up',
};
const MESSAGE_STATUS: Record<string, string> = {
  pending: 'Saved, not emailed yet',
  unconfigured: 'Saved, but email sending is not set up yet',
  accepted: 'Handed to the email service',
  failed: 'Sending failed',
  unresolved: 'Unclear whether it was sent',
};
export const messageKindLabel = (kind: string) => MESSAGE_KIND[kind] ?? sentence(kind);
export const messageStatusText = (status: string) => MESSAGE_STATUS[status] ?? sentence(status);

type ActivityLike = Pick<CrmActivity, 'id' | 'sequence' | 'kind' | 'actor' | 'note' | 'referenceId' | 'occurredAt'> &
  Partial<Pick<CrmActivity, 'fromStage' | 'toStage' | 'fromDueAt' | 'toDueAt' | 'fromCommitment' | 'toCommitment'>>;

const whenOf = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? crmDate(iso) : null);

function commitmentWords(value: { tier: string; amount: string; currency: string } | null | undefined): string {
  if (!value) return 'none';
  return `${value.tier === 'committed' ? 'Committed' : 'Soft-circled'} ${formatMoney(value.amount, value.currency)}`;
}

/** The words for one activity entry: a title, and the line under it. */
export function describeActivity(activity: ActivityLike, owners: readonly TimelineOwner[]): { title: string; detail: string | null } {
  const note = activity.note;
  switch (activity.kind) {
    case 'assigned': {
      const owner = owners.find((entry) => entry.userId === activity.referenceId);
      return { title: owner ? `Assigned to ${owner.displayName}` : 'Owner changed', detail: note };
    }
    case 'stage_changed':
      if (activity.fromStage && activity.toStage)
        return { title: `${stageLabel(activity.fromStage)} → ${stageLabel(activity.toStage)}`, detail: note };
      if (activity.toStage) return { title: `Moved to ${stageLabel(activity.toStage)}`, detail: note };
      // Entries from before the stage was recorded: only the reason is known, and the kind covered next-action edits too.
      return { title: 'Stage or next action updated', detail: note };
    case 'next_action_changed': {
      const due = whenOf(activity.toDueAt ?? activity.referenceId);
      return { title: 'Next action changed', detail: [note, due ? `due ${due}` : null].filter(Boolean).join(' · ') || null };
    }
    case 'note':
      return { title: 'Note', detail: note };
    case 'questionnaire_submitted':
      return { title: 'Questionnaire submitted', detail: note };
    case 'call_invited':
      return { title: 'Call invitation recorded', detail: note };
    case 'call_booked':
      return { title: 'Call booked', detail: note };
    case 'reply_sent':
      return { title: 'Reply sent', detail: note };
    case 'commitment_changed': {
      const to = activity.toCommitment;
      const title = to ? `Commitment: ${commitmentWords(to)}` : 'Commitment cleared';
      const from = activity.fromCommitment;
      return { title, detail: [from ? `was ${commitmentWords(from)}` : null, note].filter(Boolean).join(' · ') || null };
    }
    case 'email_status': {
      const queued = /^Message queued: (.+)$/.exec(note ?? '');
      if (queued?.[1]) return { title: `Message queued: ${messageKindLabel(queued[1])}`, detail: null };
      return { title: 'Message update', detail: note };
    }
    default:
      return { title: sentence(String(activity.kind)), detail: note };
  }
}

function whoOf(actor: CrmActivity['actor'], owners: readonly TimelineOwner[]): string {
  if (actor.kind === 'operator') return owners.find((owner) => owner.userId === actor.userId)?.displayName ?? 'Founder';
  return actor.kind === 'system' ? 'System' : 'Enquirer';
}

/** Newest first. A queued message joins its own "Message queued" entry (its text and delivery status); a message with no entry is added. */
export function buildTimeline(args: {
  activities: readonly ActivityLike[];
  messages: readonly TimelineMessage[];
  owners: readonly TimelineOwner[];
}): TimelineItem[] {
  const byMessage = new Map(args.messages.map((message) => [message.id, message]));
  const used = new Set<string>();
  const items: Array<TimelineItem & { sequence: number }> = args.activities.map((activity) => {
    const words = describeActivity(activity, args.owners);
    const message = activity.kind === 'email_status' && activity.referenceId ? byMessage.get(activity.referenceId) : undefined;
    if (message) used.add(message.id);
    const detail = message ? [messageStatusText(message.status), message.staffText].filter(Boolean).join('\n') : words.detail;
    return {
      id: activity.id,
      at: activity.occurredAt,
      title: words.title,
      detail,
      who: whoOf(activity.actor, args.owners),
      kind: activity.kind,
      sequence: activity.sequence,
    };
  });
  for (const message of args.messages) {
    if (used.has(message.id)) continue;
    items.push({
      id: `message:${message.id}`,
      at: message.createdAt,
      title: `Message: ${messageKindLabel(message.kind)}`,
      detail: [messageStatusText(message.status), message.staffText].filter(Boolean).join('\n'),
      who: args.owners.find((owner) => owner.userId === message.actorUserId)?.displayName ?? 'Founder',
      kind: 'message',
      sequence: 0,
    });
  }
  return items
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.sequence - a.sequence)
    .map(({ sequence: _sequence, ...item }) => item);
}
