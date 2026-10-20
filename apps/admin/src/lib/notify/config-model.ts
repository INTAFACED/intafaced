import type { Part } from '@/lib/desk/part';

/**
 * Notify owner settings: strict readers for svc-notify's `notify.channelSettings` and `notify.templates` (both
 * `admin:read`). A row that does not match is a failed read, never a shorter list.
 */

export const OUT_OF_APP = ['email', 'push', 'sms'] as const;
export type OutOfAppChannel = (typeof OUT_OF_APP)[number];
export const EFFECTIVE = ['sending', 'disabled', 'unconfigured'] as const;
export type Effective = (typeof EFFECTIVE)[number];

export interface ChannelSetting {
  readonly channel: OutOfAppChannel;
  readonly configured: boolean;
  /** Names of the settings the channel needs; never their values. */
  readonly requires: readonly string[];
  readonly enabled: boolean | null;
  readonly adapter: string | null;
  readonly version: number;
  readonly effective: Effective;
  readonly notConnected: string | null;
}

export interface TemplateCurrent {
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: string;
}

export interface TemplateRow {
  readonly key: string;
  readonly fields: readonly string[];
  /** Null: no version saved, so svc-notify sends nothing from this template. */
  readonly current: TemplateCurrent | null;
}

export interface NotifyConfigView {
  readonly asOf: string;
  readonly channels: Part<readonly ChannelSetting[]>;
  readonly templates: Part<readonly TemplateRow[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function readChannelSettings(raw: unknown): ChannelSetting[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: ChannelSetting[] = [];
  for (const row of raw) {
    if (!isRecord(row)) return null;
    const { channel, configured, requires, enabled, adapter, version, effective, notConnected } = row;
    if (typeof channel !== 'string' || !(OUT_OF_APP as readonly string[]).includes(channel)) return null;
    if (typeof configured !== 'boolean' || !isStrings(requires)) return null;
    if (!(enabled === null || typeof enabled === 'boolean') || !(adapter === null || typeof adapter === 'string')) return null;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
    if (typeof effective !== 'string' || !(EFFECTIVE as readonly string[]).includes(effective)) return null;
    if (!(notConnected === null || typeof notConnected === 'string')) return null;
    rows.push({
      channel: channel as OutOfAppChannel,
      configured,
      requires,
      enabled,
      adapter,
      version,
      effective: effective as Effective,
      notConnected,
    });
  }
  return rows;
}

export function readTemplates(raw: unknown): TemplateRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: TemplateRow[] = [];
  for (const row of raw) {
    if (!isRecord(row) || typeof row.key !== 'string' || row.key === '' || !isStrings(row.fields)) return null;
    const { current } = row;
    if (current === null) {
      rows.push({ key: row.key, fields: row.fields, current: null });
      continue;
    }
    if (!isRecord(current)) return null;
    const { version, subject, body, authorId, createdAt } = current;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
    if (typeof subject !== 'string' || typeof body !== 'string' || typeof authorId !== 'string' || !isIso(createdAt)) return null;
    rows.push({ key: row.key, fields: row.fields, current: { version, subject, body, authorId, createdAt } });
  }
  return rows;
}
