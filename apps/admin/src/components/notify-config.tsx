import { Chip } from '@/components/chip';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import type { ChannelSetting, Effective, NotifyConfigView, TemplateRow } from '@/lib/notify/config-model';
import { shortId } from '@/lib/desk/desk-model';
import './desk.css';

/**
 * NOTIFY CHANNELS AND TEMPLATES — read-only.
 *
 * Whether each out-of-app channel has credentials (never the credentials), the owner's on/off switch and the adapter
 * name; and the newest saved version of each identity message template with the fields it may use. A channel with no
 * credentials reads "unconfigured": a switch cannot make it send. A template with no saved version sends nothing.
 * Changing either needs a second person's approval; this console does not carry that request for these settings, and
 * the page says so instead of showing a button that cannot work.
 */

const TONE: Record<Effective, 'live' | 'warn' | 'neutral'> = { sending: 'live', disabled: 'warn', unconfigured: 'neutral' };
const WORDS: Record<Effective, string> = { sending: 'Sending', disabled: 'Switched off', unconfigured: 'Unconfigured' };

function Failed({ name, part }: { name: string; part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-testid="notify-config-failed">
      <strong>{name} unavailable</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
    </div>
  );
}

export function ChannelSettingsTable({ rows }: { rows: readonly ChannelSetting[] }) {
  if (rows.length === 0) return <p className="dk-muted">svc-notify listed no out-of-app channels.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Channel settings" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th>State</th>
            <th>Credentials</th>
            <th>Owner switch</th>
            <th>Adapter</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.channel} data-testid={`setting-${r.channel}`}>
              <th scope="row">{r.channel}</th>
              <td>
                <Chip tone={TONE[r.effective]}>{WORDS[r.effective]}</Chip>
                {r.notConnected && <p className="dk-muted">{r.notConnected}</p>}
              </td>
              <td>
                {r.configured ? 'Present' : `Missing: ${r.requires.length === 0 ? 'not listed by svc-notify' : r.requires.join(', ')}`}
              </td>
              <td>{r.enabled === null ? 'Not set' : r.enabled ? 'On' : 'Off'}</td>
              <td>{r.adapter ?? 'Not named'}</td>
              <td>{r.version === 0 ? 'Never saved' : r.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TemplateTable({ rows }: { rows: readonly TemplateRow[] }) {
  if (rows.length === 0) return <p className="dk-muted">svc-notify listed no templates.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Message templates" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Template</th>
            <th>Saved version</th>
            <th>Subject</th>
            <th>Allowed fields</th>
            <th>Saved by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-testid={`template-${r.key}`}>
              <th scope="row">{r.key}</th>
              {r.current ? (
                <>
                  <td>
                    {r.current.version}
                    <p className="dk-muted">{formatWhen(r.current.createdAt)}</p>
                  </td>
                  <td>{r.current.subject === '' ? '(no subject)' : r.current.subject}</td>
                </>
              ) : (
                <td colSpan={2}>No version saved, so nothing is sent from this template.</td>
              )}
              <td className="dk-packet">{r.fields.join(', ')}</td>
              <td className="dk-packet">{r.current ? shortId(r.current.authorId) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotifyConfigDesk({ view }: { view: NotifyConfigView | null }) {
  return (
    <div className="dk" data-testid="notify-config">
      <div className="adm-pagehead">
        <div>
          <h2>Channels and templates</h2>
          <p>How each out-of-app channel is set up and which message templates are saved. Read-only.</p>
        </div>
      </div>
      <p className="dk-muted">
        {view
          ? `As of ${formatAsOf(view.asOf)} (when this console read svc-notify).`
          : 'svc-notify could not be read. Nothing is shown rather than a guess.'}
      </p>
      <p className="dk-why" data-testid="notify-config-blocker">
        Changing a channel switch or a template needs a second person&apos;s approval. This console does not carry that request for these
        settings, so there is no edit control here.
      </p>
      {view && (
        <>
          <h3>Channels</h3>
          {view.channels.kind === 'ok' ? (
            <ChannelSettingsTable rows={view.channels.data} />
          ) : (
            <Failed name="Channel settings" part={view.channels} />
          )}
          <h3>Templates</h3>
          {view.templates.kind === 'ok' ? <TemplateTable rows={view.templates.data} /> : <Failed name="Templates" part={view.templates} />}
        </>
      )}
    </div>
  );
}
