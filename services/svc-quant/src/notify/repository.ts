import type { QuantNotifyChannel } from '@intafaced/contracts';

/** One fill alert (AL-alerts-01): a strategy version and a template. Never a copy of the strategy's parameters. */
export interface StoredAlert {
  readonly id: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly template: string;
  readonly key: string;
  readonly createdAt: string;
}

export interface StoredNotifySettings {
  readonly channels: readonly QuantNotifyChannel[];
  readonly updatedAt: string;
}

/** Strategy notification channels, fill alerts, and which fills each alert has announced. Holds no balance. */
export interface NotifyRepository {
  settings(input: { readonly accountId: string; readonly strategyId: string }): Promise<StoredNotifySettings | null>;
  saveSettings(input: {
    readonly accountId: string;
    readonly strategyId: string;
    readonly channels: readonly QuantNotifyChannel[];
  }): Promise<StoredNotifySettings>;
  /** Stores one alert under its key; the same key returns the alert first stored under it. */
  createAlert(input: Omit<StoredAlert, 'id' | 'createdAt'>): Promise<StoredAlert>;
  /** One account's alerts of one strategy, oldest first. */
  alerts(input: { readonly accountId: string; readonly strategyId: string; readonly limit: number }): Promise<readonly StoredAlert[]>;
  /** Every account's alerts, for the server-side sweep, oldest first after `after` (an alert id). */
  sweepAlerts(input: { readonly after: string | null; readonly limit: number }): Promise<readonly StoredAlert[]>;
  /** The fill sequence numbers of one run already announced under one alert. */
  announced(input: { readonly alertId: string; readonly runId: string }): Promise<ReadonlySet<number>>;
  /** Records that a fill was announced. Recording it twice changes nothing. */
  markAnnounced(input: { readonly alertId: string; readonly runId: string; readonly seq: number; readonly eventId: string }): Promise<void>;
}
