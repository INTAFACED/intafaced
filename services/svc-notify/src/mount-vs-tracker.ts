/**
 * D26-P1-O5 — ops.notifications mount vs tracker honest gaps.
 *
 * Backend product-complete: fan-out mountain (in-app inbox + delivery rows).
 * Out-of-app email/push/SMS are §13 credential sockets (Class X).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelSocketMatrixComplete, FANOUT_MOUNTAIN_ID } from './channels/mountain-vs-sockets.js';

export const NOTIFY_TRACKER_ID = FANOUT_MOUNTAIN_ID;

export const NOTIFY_MOUNTED_DOORS = ['list', 'deliveries', 'operatorDeliveries', 'channels'] as const;

export type NotifyMountedDoor = (typeof NOTIFY_MOUNTED_DOORS)[number];

export const NOTIFY_HONEST_GAPS = [
  'gap.class_x_credentials',
  'gap.no_provider_invent',
  'gap.accepted_is_not_delivered',
  'gap.no_shell_consumer',
] as const;

export function notifyDoorsInRouterSource(): readonly NotifyMountedDoor[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const routerPath = join(here, 'router.ts');
  const src = readFileSync(routerPath, 'utf8');
  const start = src.search(/^\s{4}notify:\s*router\(\{/m);
  if (start === -1) return [];
  const next = src.slice(start + 1).search(/^\s{4}[a-zA-Z]+:\s*router\(\{/m);
  const block = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  return NOTIFY_MOUNTED_DOORS.filter((door) => new RegExp(`\\b${door}\\s*:`).test(block));
}

export function notifyHealthDoorMounted(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'router.ts'), 'utf8');
  return /\bhealth:\s*(?:publicProcedure|mountRecord\()/.test(src);
}

export function notifyMountMatrixComplete(): boolean {
  return notifyDoorsInRouterSource().length === NOTIFY_MOUNTED_DOORS.length && notifyHealthDoorMounted();
}

/** Denon D26-P1-O5 backend done bar met when fan-out doors + channel/socket matrix wired. */
export function notifyTrackerBackendDoneBarMet(): boolean {
  return notifyMountMatrixComplete() && channelSocketMatrixComplete();
}

export function notifyMountVsTrackerBoardCard(): {
  readonly tracker: typeof NOTIFY_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
  readonly mountComplete: boolean;
} {
  const mounted = notifyDoorsInRouterSource();
  return {
    tracker: NOTIFY_TRACKER_ID,
    doors: NOTIFY_MOUNTED_DOORS.length,
    doorsMounted: mounted.length,
    gaps: NOTIFY_HONEST_GAPS.length,
    backendDoneBarMet: notifyTrackerBackendDoneBarMet(),
    mountComplete: mounted.length === NOTIFY_MOUNTED_DOORS.length && notifyHealthDoorMounted(),
  };
}
