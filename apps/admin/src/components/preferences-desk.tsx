'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  CONSOLE_THEMES,
  PREFERENCE_KEYS,
  PREFERENCE_LEVELS,
  PREFERENCES_STALE,
  WEEK_STARTS,
  type PreferenceKey,
  type PreferenceLevel,
  type PreferenceValues,
  type Preferences,
  type WritablePreferenceLevel,
} from '@intafaced/contracts/ops-console-preferences';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchPreferences, postConsoleChange, type ConsoleChangeReply } from '@/lib/console-announcements/browser';
import type { OpsRead } from '@/lib/console-announcements/model';
import './desk.css';

/**
 * PROFILE AND PREFERENCES (OPS-admin-access-08, admin-access-038).
 *
 * The console's preferences at four levels: the server's shipped defaults, the organisation, your team and you. For each
 * one the most specific level that sets it wins, and the table says which level that was. A founder sets the
 * organisation's values or their own. The staff directory names no team for a founder yet, so the team column says so and
 * cannot be set. The console has one look (dark); another theme is the owner's call.
 */

const KEY_LABEL: Readonly<Record<PreferenceKey, string>> = {
  theme: 'Theme',
  homePage: 'Home page',
  timeZone: 'Time zone',
  weekStart: 'Week starts on',
};
const LEVEL_LABEL: Readonly<Record<PreferenceLevel, string>> = {
  server: 'Server',
  organisation: 'Organisation',
  team: 'Team',
  person: 'You',
};
const shown = (key: PreferenceKey, v: string | null) =>
  v === null ? '—' : key === 'theme' || key === 'weekStart' ? v.charAt(0).toUpperCase() + v.slice(1) : v;

function Outcome({ reply }: { reply: ConsoleChangeReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="preferences-outcome">
        <strong>Done: preferences saved</strong>
      </div>
    );
  return (
    <div className="adm-callout" role="alert" data-tone="danger" data-testid="preferences-outcome" data-code={reply.code ?? ''}>
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function LevelForm({
  level,
  values,
  busy,
  onSave,
}: {
  level: WritablePreferenceLevel;
  values: PreferenceValues;
  busy: boolean;
  onSave: (level: WritablePreferenceLevel, values: Record<PreferenceKey, string>) => void;
}) {
  const [form, setForm] = useState<Record<PreferenceKey, string>>({
    theme: values.theme ?? '',
    homePage: values.homePage ?? '',
    timeZone: values.timeZone ?? '',
    weekStart: values.weekStart ?? '',
  });
  const set = (key: PreferenceKey) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const id = (key: PreferenceKey) => `pref-${level}-${key}`;
  const heading = level === 'organisation' ? 'The organisation’s preferences' : 'Your preferences';
  return (
    <section className="dk-stack" aria-labelledby={`pref-${level}`} data-testid={`preferences-form-${level}`}>
      <h2 id={`pref-${level}`}>{heading}</h2>
      <p className="dk-muted">
        Blank leaves a preference to the level above.{' '}
        {level === 'organisation' ? 'These apply to every founder who has not set their own.' : 'Only you see these.'}
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor={id('theme')}>Theme</label>
          <select id={id('theme')} className="adm-input" value={form.theme} onChange={set('theme')} disabled={busy}>
            <option value="">Not set</option>
            {CONSOLE_THEMES.map((t) => (
              <option key={t} value={t}>
                {shown('theme', t)}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor={id('homePage')}>Home page (a console path)</label>
          <input
            id={id('homePage')}
            className="adm-input"
            placeholder="/crm"
            value={form.homePage}
            onChange={set('homePage')}
            disabled={busy}
          />
        </div>
        <div className="adm-field">
          <label htmlFor={id('timeZone')}>Time zone</label>
          <input
            id={id('timeZone')}
            className="adm-input"
            placeholder="Europe/Berlin"
            value={form.timeZone}
            onChange={set('timeZone')}
            disabled={busy}
          />
        </div>
        <div className="adm-field">
          <label htmlFor={id('weekStart')}>Week starts on</label>
          <select id={id('weekStart')} className="adm-input" value={form.weekStart} onChange={set('weekStart')} disabled={busy}>
            <option value="">Not set</option>
            {WEEK_STARTS.map((w) => (
              <option key={w} value={w}>
                {shown('weekStart', w)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => onSave(level, form)} disabled={busy}>
          Save {level === 'organisation' ? 'the organisation’s' : 'yours'}
        </button>
      </div>
    </section>
  );
}

export function PreferencesDesk({ initial }: { initial: OpsRead<Preferences> }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ConsoleChangeReply | null>(null);
  const [formKey, setFormKey] = useState(0);

  const save = useCallback(
    async (level: WritablePreferenceLevel, values: Record<PreferenceKey, string>) => {
      setBusy(true);
      const expectedRevision = view.kind === 'read' ? view.data.levels[level].revision : 0;
      const result = await postConsoleChange('/api/console-preferences', { level, expectedRevision, values });
      setReply(result);
      if (result.ok && result.answer.preferences) {
        setView({ kind: 'read', data: result.answer.preferences as Preferences });
        setFormKey((k) => k + 1);
        // The theme and the home link live in the console layout.
        router.refresh();
      } else if (!result.ok && (result.code === PREFERENCES_STALE || result.changed === 'unknown')) {
        // Another founder saved first, or the outcome is unknown: show what is stored now, and save again from that.
        const fresh = await fetchPreferences();
        if (fresh) {
          setView(fresh);
          setFormKey((k) => k + 1);
        }
      }
      setBusy(false);
    },
    [router, view],
  );
  const onSave = (level: WritablePreferenceLevel, values: Record<PreferenceKey, string>) => void save(level, values);

  const data = view.kind === 'read' ? view.data : null;
  return (
    <div className="dk-stack" data-testid="preferences-desk">
      <header className="adm-pagehead">
        <h1>Profile and preferences</h1>
        <p className="dk-muted">
          How this console looks and opens for you. For each preference the most specific level that sets it wins: you, then your team, then
          the organisation, then the server.
        </p>
        {data && <span className="dk-asof">As of {formatAsOf(data.asOf)}</span>}
      </header>
      <Outcome reply={reply} />
      {view.kind === 'unconfigured' && (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="preferences-unconfigured">
          <strong>Preferences have no storage</strong>
          <p>svc-ops has no database configured for console preferences, so every preference is the server’s and none can be saved.</p>
        </div>
      )}
      {view.kind === 'unknown' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="preferences-unknown">
          <strong>Preferences could not be read</strong>
          <p>
            {view.message} The console uses the server’s preferences until they can be.{view.code ? ` Code: ${view.code}.` : ''}
          </p>
        </div>
      )}
      {data && (
        <>
          <table className="adm-table" data-testid="preferences-table">
            <thead>
              <tr>
                <th scope="col">Preference</th>
                {PREFERENCE_LEVELS.map((l) => (
                  <th key={l} scope="col">
                    {LEVEL_LABEL[l]}
                  </th>
                ))}
                <th scope="col">In force</th>
              </tr>
            </thead>
            <tbody>
              {PREFERENCE_KEYS.map((key) => (
                <tr key={key} data-testid={`preference-${key}`}>
                  <th scope="row">{KEY_LABEL[key]}</th>
                  {PREFERENCE_LEVELS.map((l) => (
                    <td key={l} data-level={l}>
                      {shown(key, data.levels[l].values[key])}
                    </td>
                  ))}
                  <td data-testid={`preference-${key}-effective`} data-from={data.effective[key].from}>
                    <strong>{shown(key, data.effective[key].value)}</strong> (from {LEVEL_LABEL[data.effective[key].from].toLowerCase()})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dk-muted" data-testid="preferences-team-blocker">
            Team: the staff directory names no team for you yet, so team preferences cannot be set ({data.levels.team.blocker}).
          </p>
          <p className="dk-muted">
            Theme: the console has one look, dark; another is the owner’s call. Your time zone is used where you type or read a wall clock,
            such as an announcement’s window; the rest of the console prints UTC so two founders read the same words.
            {data.levels.person.updatedAt ? ` You last saved yours ${formatWhen(data.levels.person.updatedAt)}.` : ''}
          </p>
          <LevelForm key={`o${formKey}`} level="organisation" values={data.levels.organisation.values} busy={busy} onSave={onSave} />
          <LevelForm key={`p${formKey}`} level="person" values={data.levels.person.values} busy={busy} onSave={onSave} />
        </>
      )}
    </div>
  );
}
