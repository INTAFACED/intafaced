/** Postgres channel settings: the latest row per channel plus an append-only history, written in one transaction. */

import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { OUT_OF_APP_CHANNELS, type OutOfAppChannel } from '../channels/channel.js';
import type { ChannelSettingRow, ChannelSettingsStore } from './channel-settings.js';

type Pg = {
  channel: string;
  enabled: boolean;
  adapter: string | null;
  version: number;
  updated_by: string;
  approval_id: string;
  updated_at: Date;
};

function asChannel(value: string): OutOfAppChannel {
  if (!(OUT_OF_APP_CHANNELS as readonly string[]).includes(value)) throw new Error(`notify.channel_settings_corrupt:${value}`);
  return value as OutOfAppChannel;
}

function fromPg(row: Pg): ChannelSettingRow {
  return {
    channel: asChannel(row.channel),
    enabled: row.enabled,
    adapter: row.adapter,
    version: row.version,
    updatedBy: row.updated_by,
    approvalId: row.approval_id,
    updatedAt: row.updated_at,
  };
}

export class PostgresChannelSettingsStore implements ChannelSettingsStore {
  constructor(private readonly sql: Sql) {}

  async all(): Promise<readonly ChannelSettingRow[]> {
    const rows = await this.sql<Pg[]>`
      SELECT channel, enabled, adapter, version, updated_by, approval_id, updated_at FROM notify.channel_settings ORDER BY channel
    `;
    return rows.map(fromPg);
  }

  async append(input: {
    channel: OutOfAppChannel;
    enabled: boolean;
    adapter: string | null;
    updatedBy: string;
    approvalId: string;
    now: Date;
  }): Promise<{ status: 'inserted'; row: ChannelSettingRow } | { status: 'exists' }> {
    return transaction(this.sql, async (tx) => {
      // Serialise writers of one channel so the next version is never handed out twice.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`notify.channel_settings:${input.channel}`}))`;
      const used = await tx`SELECT 1 FROM notify.channel_settings_history WHERE approval_id = ${input.approvalId}`;
      if (used.length > 0) return { status: 'exists' as const };
      const [last] = await tx<{ version: number }[]>`
        SELECT max(version) AS version FROM notify.channel_settings_history WHERE channel = ${input.channel}
      `;
      const version = (last?.version ?? 0) + 1;
      await tx`
        INSERT INTO notify.channel_settings_history (channel, version, enabled, adapter, changed_by, approval_id, created_at)
        VALUES (${input.channel}, ${version}, ${input.enabled}, ${input.adapter}, ${input.updatedBy}, ${input.approvalId}, ${input.now})
      `;
      const [row] = await tx<Pg[]>`
        INSERT INTO notify.channel_settings (channel, enabled, adapter, version, updated_by, approval_id, updated_at)
        VALUES (${input.channel}, ${input.enabled}, ${input.adapter}, ${version}, ${input.updatedBy}, ${input.approvalId}, ${input.now})
        ON CONFLICT (channel) DO UPDATE SET enabled = EXCLUDED.enabled, adapter = EXCLUDED.adapter, version = EXCLUDED.version,
          updated_by = EXCLUDED.updated_by, approval_id = EXCLUDED.approval_id, updated_at = EXCLUDED.updated_at
        RETURNING channel, enabled, adapter, version, updated_by, approval_id, updated_at
      `;
      return { status: 'inserted' as const, row: fromPg(row!) };
    });
  }

  async history(channel: OutOfAppChannel): Promise<readonly ChannelSettingRow[]> {
    const rows = await this.sql<(Omit<Pg, 'updated_by' | 'updated_at'> & { changed_by: string; created_at: Date })[]>`
      SELECT channel, version, enabled, adapter, changed_by, approval_id, created_at
      FROM notify.channel_settings_history WHERE channel = ${channel} ORDER BY version DESC
    `;
    return rows.map((r) => fromPg({ ...r, updated_by: r.changed_by, updated_at: r.created_at }));
  }
}
