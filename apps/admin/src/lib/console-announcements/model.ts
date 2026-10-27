import {
  announcementActiveOutputSchema,
  announcementsListOutputSchema,
  type AnnouncementActive,
  type AnnouncementKind,
  type AnnouncementsList,
} from '@intafaced/contracts/ops-console-announcements';

/**
 * The console's announcement banner as this console last read it from svc-ops (OPS-admin-access-08). Pure, so the server
 * loader, the banner and the desk read it the same way.
 *
 *   read          svc-ops answered.
 *   unconfigured  svc-ops has no storage for announcements: none can be saved, and none shows.
 *   unknown       svc-ops could not be read: nothing is assumed.
 */
export type OpsRead<T> =
  | { readonly kind: 'read'; readonly data: T }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'unknown'; readonly message: string; readonly code: string | null };

export type AnnouncementsView = OpsRead<AnnouncementsList>;
export type ActiveAnnouncementView = OpsRead<AnnouncementActive>;

export function readAnnouncementsList(raw: unknown): AnnouncementsList | null {
  const parsed = announcementsListOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function readActiveAnnouncement(raw: unknown): AnnouncementActive | null {
  const parsed = announcementActiveOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The callout tone each kind shows in. */
export const KIND_TONE: Readonly<Record<AnnouncementKind, 'info' | 'warn' | 'danger' | 'ok'>> = {
  information: 'info',
  warning: 'warn',
  error: 'danger',
  success: 'ok',
};

export const KIND_LABEL: Readonly<Record<AnnouncementKind, string>> = {
  information: 'Information',
  warning: 'Warning',
  error: 'Error',
  success: 'Success',
};

/** A desk reply: what happened, or why not, in the refusal map's words. */
export type AnnouncementDeskReply =
  | { readonly ok: true; readonly what: string }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
