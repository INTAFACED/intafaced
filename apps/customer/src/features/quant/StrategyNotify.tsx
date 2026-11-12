import {
  QUANT_ALERT_FIELDS,
  QUANT_ALERT_TEMPLATE_MAX,
  quantAlertListSchema,
  quantAlertSchema,
  quantNotifySettingsSchema,
  type QuantAlert,
  type QuantStrategyDetail,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Loading } from '../../shared/ui';
import { channelStatus } from '../../screens/notifications/notify-api';
import { Read, Select, TextArea } from '../more/common';
import { useApi } from '../session/session';
import { notifyCopy } from './notify-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const CHOICES = ['email', 'sms', 'push', 'webhook', 'chat'] as const;
type Choice = (typeof CHOICES)[number];
type Label = 'inapp' | Choice;
/** `quant.notify_channel_unavailable — webhook — …`: the channel a refusal names. */
const unavailableOf = (message: string) => /^quant\.notify_channel_unavailable — (\w+) — /.exec(message.trim())?.[1] ?? null;
/** `alert.template_invalid — template — …`: what is wrong with the message. */
const invalidOf = (message: string) => /^alert\.template_invalid — template — (.*)$/.exec(message.trim())?.[1] ?? null;

/** TEST values for the live preview: never a real fill. */
const PREVIEW: Record<(typeof QUANT_ALERT_FIELDS)[number], string> = {
  strategy: 'TEST strategy',
  version: '1',
  symbol: 'TEST/USD',
  side: 'buy',
  qty: '0.01',
  price: '100',
  time: '2026-01-01T00:00:00.000Z',
};

/** A strategy's notification channels (AL-live-06). */
export function StrategyChannels({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = notifyCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const settings = useResource(
    (signal) => api.query('quant', 'notify.get', { strategyId: strategy.id }, quantNotifySettingsSchema, { signal }),
    `quant-notify:${strategy.id}:${revision}`,
  );
  const status = useResource((signal) => channelStatus(api, signal), 'quant-notify-channel-status');
  const [picked, setPicked] = useState<Set<Choice> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const names = (list: readonly Label[]) => list.map((channel) => t(channel)).join(', ');
  return (
    <section aria-label={t('channelsTitle')} data-testid="quant-notify">
      <h3>{t('channelsTitle')}</h3>
      <p className="muted">{t('channelsIntro')}</p>
      <Read resource={settings.resource} retry={settings.reload}>
        {(saved) => {
          const chosen: Set<Choice> = picked ?? new Set<Choice>(saved.channels.filter((c) => c !== 'inapp'));
          const unconfigured = (channel: Choice) =>
            (channel === 'email' || channel === 'sms' || channel === 'push') &&
            status.resource.status === 'ready' &&
            !status.resource.data.some((row) => row.channel === channel && row.configured);
          async function save() {
            if (busy) return;
            setBusy(true);
            setNote(null);
            setRefused(null);
            setFailure(null);
            const res = await api.mutate(
              'quant',
              'notify.set',
              { strategyId: strategy.id, channels: [...chosen] },
              quantNotifySettingsSchema,
            );
            setBusy(false);
            if (res.ok) {
              setPicked(null);
              setNote(t('saved', { channels: names(res.data.channels) }));
              setRevision((n) => n + 1);
              return;
            }
            const channel = unavailableOf(res.message);
            if (channel) setRefused(t('unavailable', { channel: t(channel as Choice) }));
            else setFailure(res);
          }
          return (
            <>
              <p data-testid="quant-notify-current" data-channels={saved.channels.join(',')}>
                {t('current', { channels: names(saved.channels) })}
              </p>
              <fieldset>
                <legend>{t('channelsTitle')}</legend>
                <label>
                  <input type="checkbox" checked disabled /> {t('inappAlways')}
                </label>
                {CHOICES.map((channel) => (
                  <label key={channel}>
                    <input
                      type="checkbox"
                      checked={chosen.has(channel)}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.currentTarget.checked) next.add(channel);
                        else next.delete(channel);
                        setPicked(next);
                        setNote(null);
                        setRefused(null);
                      }}
                    />{' '}
                    {t(channel)}
                  </label>
                ))}
              </fieldset>
              {CHOICES.filter((channel) => chosen.has(channel) && unconfigured(channel)).map((channel) => (
                <p key={channel} role="status" data-testid="quant-notify-vendor" data-channel={channel} data-code={`vendor.${channel}`}>
                  {t('vendorNotice', { channel: t(channel) })}
                </p>
              ))}
              <Button onClick={() => void save()} disabled={busy}>
                {t('save')}
              </Button>
              {busy && <Loading label={t('saving')} />}
              {note && (
                <p role="status" data-testid="quant-notify-note">
                  {note}
                </p>
              )}
              {refused && (
                <p role="alert" data-testid="quant-notify-refusal" data-code="quant.notify_channel_unavailable">
                  {refused}
                </p>
              )}
              {failure && <Failure result={failure} retry={() => void save()} />}
            </>
          );
        }}
      </Read>
    </section>
  );
}

/** A strategy's fill alerts (AL-alerts-01). */
export function StrategyAlerts({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = notifyCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const list = useResource(
    (signal) => api.query('quant', 'alert.list', { strategyId: strategy.id }, quantAlertListSchema, { signal }),
    `quant-alerts:${strategy.id}:${revision}`,
  );
  return (
    <section aria-label={t('alertsTitle')} data-testid="quant-alerts">
      <h3>{t('alertsTitle')}</h3>
      <p className="muted">{t('alertsIntro')}</p>
      {note && (
        <p role="status" data-testid="quant-alerts-note">
          {note}
        </p>
      )}
      <Read resource={list.resource} retry={list.reload}>
        {(data) => (
          <>
            {opening ? (
              <AlertForm
                strategy={strategy}
                ordinal={data.alerts.length}
                onCancel={() => setOpening(false)}
                onCreated={(alert) => {
                  setOpening(false);
                  setNote(t('created', { version: alert.strategyVersion }));
                  setRevision((n) => n + 1);
                }}
              />
            ) : (
              <Button
                onClick={() => {
                  setNote(null);
                  setOpening(true);
                }}
              >
                {t('add')}
              </Button>
            )}
            {data.alerts.length === 0 ? (
              <EmptyState title={t('noAlerts')} />
            ) : (
              <DataTable label={t('alertsTitle')} headers={[t('version'), t('event'), t('template'), t('createdAt')]}>
                {data.alerts.map((alert) => (
                  <tr key={alert.alertId} data-testid="quant-alert" data-alert-id={alert.alertId} data-version={alert.strategyVersion}>
                    <td>{t('versionOf', { version: alert.strategyVersion })}</td>
                    <td>{t('onFill')}</td>
                    <td data-testid="quant-alert-template">{alert.template}</td>
                    <td lang="zxx">{utcText(alert.createdAt)}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </>
        )}
      </Read>
    </section>
  );
}

function AlertForm(props: {
  strategy: QuantStrategyDetail;
  ordinal: number;
  onCancel: () => void;
  onCreated: (alert: QuantAlert) => void;
}) {
  const api = useApi();
  const { t } = notifyCopy.useCopy();
  const newest = Math.max(...props.strategy.versions.map((row) => row.version));
  const [version, setVersion] = useState(String(newest));
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  // The alert count when this form opened: the create's key, kept until it is confirmed or cancelled.
  const [ordinal] = useState(props.ordinal);
  const preview = template.replace(/\{([^{}]*)\}/g, (whole, name: string) => PREVIEW[name.trim() as keyof typeof PREVIEW] ?? whole);
  async function create() {
    if (busy) return;
    setBusy(true);
    setInvalid(null);
    setFailure(null);
    const res = await api.mutate(
      'quant',
      'alert.create',
      { strategyId: props.strategy.id, strategyVersion: Number(version), template, ordinal },
      quantAlertSchema,
    );
    setBusy(false);
    if (res.ok) return props.onCreated(res.data);
    const detail = invalidOf(res.message);
    if (detail) setInvalid(detail);
    else setFailure(res);
  }
  return (
    <form
      data-testid="quant-alert-form"
      aria-label={t('addTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <Select
        label={t('version')}
        value={version}
        onChange={setVersion}
        options={[...props.strategy.versions]
          .sort((a, b) => b.version - a.version)
          .map((row) => ({ value: String(row.version), label: t('versionOf', { version: row.version }) }))}
      />
      <TextArea label={t('template')} value={template} onChange={setTemplate} maxLength={QUANT_ALERT_TEMPLATE_MAX} />
      <p className="muted">{t('fields', { fields: QUANT_ALERT_FIELDS.map((field) => `{${field}}`).join(', ') })}</p>
      {template.trim() && (
        <p data-testid="quant-alert-preview" lang="zxx">
          {t('preview', { text: preview })}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {t('create')}
      </Button>
      <Button type="button" variant="secondary" onClick={props.onCancel} disabled={busy}>
        {t('cancel')}
      </Button>
      {busy && <Loading label={t('creating')} />}
      {invalid && (
        <p role="alert" data-testid="quant-alert-refusal" data-code="alert.template_invalid">
          {t('invalid', { detail: invalid })}
        </p>
      )}
      {failure && <Failure result={failure} retry={() => void create()} />}
    </form>
  );
}
