/**
 * Owner channel settings: enable or disable an out-of-app channel and name the
 * adapter the owner configured. Changing one needs a second person.
 *
 * No credential is read, stored or returned here. `configured` comes from the
 * registry, which reads it from the environment. A channel with no row follows the
 * environment alone (the behaviour before this existed); a row can only switch a
 * channel off, never make an unconfigured one send.
 */

import type { ChannelStatus } from '../channels/registry.js';
import { OUT_OF_APP_CHANNELS, type OutOfAppChannel } from '../channels/channel.js';
import type { CommandLog } from '../preferences/account.js';
import type { NoticeApprovalConsumer } from '../notices/board.js';
import { OpsConfigError, payloadHashOf, spendFourEyes } from './four-eyes.js';

export type ChannelSettingRow = {
  readonly channel: OutOfAppChannel;
  readonly enabled: boolean;
  readonly adapter: string | null;
  readonly version: number;
  readonly updatedBy: string;
  readonly approvalId: string;
  readonly updatedAt: Date;
};

export interface ChannelSettingsStore {
  all(): Promise<readonly ChannelSettingRow[]>;
  /** Writes the next version of one channel. `exists` when the approval was already used. */
  append(input: {
    channel: OutOfAppChannel;
    enabled: boolean;
    adapter: string | null;
    updatedBy: string;
    approvalId: string;
    now: Date;
  }): Promise<{ status: 'inserted'; row: ChannelSettingRow } | { status: 'exists' }>;
  history(channel: OutOfAppChannel): Promise<readonly ChannelSettingRow[]>;
}

export class MemoryChannelSettingsStore implements ChannelSettingsStore {
  private readonly log: ChannelSettingRow[] = [];

  async all(): Promise<readonly ChannelSettingRow[]> {
    return OUT_OF_APP_CHANNELS.flatMap((channel) => {
      const rows = this.log.filter((r) => r.channel === channel);
      const last = rows[rows.length - 1];
      return last ? [last] : [];
    });
  }

  async append(input: {
    channel: OutOfAppChannel;
    enabled: boolean;
    adapter: string | null;
    updatedBy: string;
    approvalId: string;
    now: Date;
  }): Promise<{ status: 'inserted'; row: ChannelSettingRow } | { status: 'exists' }> {
    if (this.log.some((r) => r.approvalId === input.approvalId)) return { status: 'exists' };
    const version = this.log.filter((r) => r.channel === input.channel).length + 1;
    const row: ChannelSettingRow = {
      channel: input.channel,
      enabled: input.enabled,
      adapter: input.adapter,
      version,
      updatedBy: input.updatedBy,
      approvalId: input.approvalId,
      updatedAt: input.now,
    };
    this.log.push(row);
    return { status: 'inserted', row };
  }

  async history(channel: OutOfAppChannel): Promise<readonly ChannelSettingRow[]> {
    return this.log.filter((r) => r.channel === channel).reverse();
  }
}

export type ChannelSettingWire = {
  readonly channel: OutOfAppChannel;
  /** The environment has this channel's credentials. Never the credentials. */
  readonly configured: boolean;
  /** Env variable names the operator still has to set. */
  readonly requires: string[];
  /** The owner's switch. Null = no change recorded; the environment decides alone. */
  readonly enabled: boolean | null;
  readonly adapter: string | null;
  readonly version: number;
  /** `unconfigured` sends are refused `channel.not_configured` (undeliverable); `disabled` are refused `channel.disabled`. */
  readonly effective: 'sending' | 'disabled' | 'unconfigured';
  /** Allowlisted NotConnected id for an unconfigured channel. */
  readonly notConnected: `vendor.${OutOfAppChannel}` | null;
};

const ADAPTER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type SetReplay = { ok: true; setting: ChannelSettingWire } | { ok: false; code: string };

export class ChannelSettings {
  constructor(
    private readonly store: ChannelSettingsStore,
    private readonly approvals: NoticeApprovalConsumer | null,
    private readonly commands: CommandLog,
    private readonly status: () => readonly ChannelStatus[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Channels the owner switched off. One small read per dispatch. */
  async disabled(): Promise<ReadonlySet<OutOfAppChannel>> {
    const rows = await this.store.all();
    return new Set(rows.filter((r) => !r.enabled).map((r) => r.channel));
  }

  async get(): Promise<readonly ChannelSettingWire[]> {
    const rows = new Map((await this.store.all()).map((r) => [r.channel, r]));
    const status = new Map(this.status().map((s) => [s.channel, s]));
    return OUT_OF_APP_CHANNELS.map((channel) => wire(channel, rows.get(channel) ?? null, status.get(channel) ?? null));
  }

  /** What the second person has to approve: the hash, the target and the version it is bound to. */
  async proposal(input: { channel: OutOfAppChannel; enabled: boolean; adapter?: string | null }) {
    const adapter = normaliseAdapter(input.adapter);
    const current = (await this.store.all()).find((r) => r.channel === input.channel);
    const version = current?.version ?? 0;
    return {
      targetId: input.channel,
      expectedVersion: String(version),
      payloadHash: payloadHashOf({ channel: input.channel, enabled: input.enabled, adapter, version }),
    };
  }

  async history(channel: OutOfAppChannel): Promise<readonly ChannelSettingRow[]> {
    return this.store.history(channel);
  }

  async set(
    actorId: string,
    input: {
      channel: OutOfAppChannel;
      enabled: boolean;
      adapter?: string | null;
      clientRequestId: string;
      approvalId: string;
      operationId: string;
    },
  ): Promise<ChannelSettingWire> {
    const replay = (await this.commands.find(actorId, 'setChannelSettings', input.clientRequestId)) as SetReplay | null;
    if (replay) {
      if (!replay.ok) throw new OpsConfigError(replay.code);
      return replay.setting;
    }
    const fail = async (code: string): Promise<never> => {
      await this.commands.put(actorId, 'setChannelSettings', input.clientRequestId, { ok: false, code } satisfies SetReplay);
      throw new OpsConfigError(code);
    };
    let adapter: string | null;
    try {
      adapter = normaliseAdapter(input.adapter);
    } catch (err) {
      return fail(err instanceof OpsConfigError ? err.code : 'notify.channel_adapter_invalid');
    }
    const proposal = await this.proposal({ channel: input.channel, enabled: input.enabled, adapter });
    try {
      await spendFourEyes(this.approvals, {
        actorId,
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: proposal.payloadHash,
        targetId: proposal.targetId,
        expectedVersion: proposal.expectedVersion,
      });
    } catch (err) {
      return fail(err instanceof OpsConfigError ? err.code : 'notify.approval_spent');
    }
    const written = await this.store.append({
      channel: input.channel,
      enabled: input.enabled,
      adapter,
      updatedBy: actorId,
      approvalId: input.approvalId,
      now: this.now(),
    });
    if (written.status === 'exists') return fail('notify.approval_spent');
    const status = this.status().find((s) => s.channel === input.channel) ?? null;
    const setting = wire(input.channel, written.row, status);
    await this.commands.put(actorId, 'setChannelSettings', input.clientRequestId, { ok: true, setting } satisfies SetReplay);
    return setting;
  }
}

function normaliseAdapter(adapter: string | null | undefined): string | null {
  if (adapter == null) return null;
  const trimmed = adapter.trim();
  if (trimmed === '') return null;
  if (!ADAPTER_RE.test(trimmed)) throw new OpsConfigError('notify.channel_adapter_invalid');
  return trimmed;
}

function wire(channel: OutOfAppChannel, row: ChannelSettingRow | null, status: ChannelStatus | null): ChannelSettingWire {
  const configured = status?.configured ?? false;
  const enabled = row ? row.enabled : null;
  return {
    channel,
    configured,
    requires: [...(status?.requires ?? [])],
    enabled,
    adapter: row?.adapter ?? null,
    version: row?.version ?? 0,
    effective: !configured ? 'unconfigured' : enabled === false ? 'disabled' : 'sending',
    notConnected: configured ? null : `vendor.${channel}`,
  };
}
