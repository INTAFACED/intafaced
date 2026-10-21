import { z } from 'zod';

// hand-declared-ok: listSessions and the family sign-out answers are declared in svc-identity, not in packages/contracts yet
export const deviceList = z.object({
  userId: z.string().uuid(),
  sessions: z.array(
    z.object({
      id: z.string().uuid(),
      familyId: z.string().uuid(),
      createdAt: z.string(),
      lastUsedAt: z.string(),
      device: z.string().nullable(),
      userAgent: z.string().nullable(),
      country: z.string().nullable(),
      isCurrent: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type DeviceList = z.infer<typeof deviceList>;
export type Device = DeviceList['sessions'][number];
export const familyEnded = z.object({ familyId: z.string().uuid(), revoked: z.boolean() });
export const othersEnded = z.object({ revokedFamilies: z.number().int().min(0) });

/** A short, honest name from what the browser reported: "Chrome on Windows". Falls back to the stored device name. */
export function deviceName(device: Pick<Device, 'userAgent' | 'device'>): string | null {
  const ua = device.userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const system = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? (device.device?.trim() ? device.device.trim() : null);
}

/** One row per sign-in (family), this device first, then newest activity first. */
export function byFamily(sessions: readonly Device[]): Device[] {
  const seen = new Map<string, Device>();
  for (const session of sessions) {
    const held = seen.get(session.familyId);
    if (!held || Date.parse(session.lastUsedAt) > Date.parse(held.lastUsedAt)) seen.set(session.familyId, session);
  }
  return [...seen.values()].sort((a, b) =>
    a.isCurrent === b.isCurrent ? Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt) : a.isCurrent ? -1 : 1,
  );
}
