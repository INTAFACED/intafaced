import { type QuantStrategyDetail } from '@intafaced/contracts/quant-algo';
import { type QuantEditLock, type QuantTeam } from '@intafaced/contracts/quant-team';
import {
  QUANT_TEAM_GET,
  QUANT_TEAM_GRANT,
  QUANT_TEAM_LOCK,
  QUANT_TEAM_REMOVE,
  QUANT_TEAM_SET,
  QUANT_TEAM_UNLOCK,
} from '@intafaced/contracts/quant-team-procedures';
import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import { EmptyNote, FailureNote, KitRead, ScrollTable, Waiting } from '../more';
import { useApi } from '../session';
import { QuotaAwareFailure } from './quota-refusal';
import { teamCopy } from './team-copy';
import { Button, Field } from '@intafaced/ui/lit';
import { CheckField, SelectField } from '@intafaced/ui/lit/templates';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');
/** The code a refusal starts with, as the service sends it: `quant.edit_locked — …`. */
export const refusalCode = (result: Failed) => result.code ?? /^([a-z]+\.[a-z_]+) — /.exec(result.message.trim())?.[1] ?? null;
/** The time a lock refusal names: `… holds the edit lock until <iso>; …`. */
export const lockedUntil = (result: Failed) => /until (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(result.message)?.[1] ?? '';

/**
 * The last data a resource read, kept on screen while it reads again, so a form's own note survives the reload its save
 * starts. Before the first read it is null and the caller shows the loading state.
 */
export function useLastReady<T>(resource: Resource<T>): T | null {
  const [kept, setKept] = useState<T | null>(null);
  useEffect(() => {
    if (resource.status === 'ready') setKept(resource.data);
  }, [resource]);
  return resource.status === 'ready' ? resource.data : kept;
}

/** The edit lock, as anyone who may edit reads it, with Take and Let go. */
export function EditLock({ strategyId, lock, onChange }: { strategyId: string; lock: QuantEditLock; onChange: () => void }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ code: string; text: string } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function act(record: typeof QUANT_TEAM_LOCK | typeof QUANT_TEAM_UNLOCK) {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    const res = await api.call(record, { strategyId });
    setBusy(false);
    if (res.ok) return onChange();
    const code = refusalCode(res);
    if (code === 'quant.edit_locked') setRefused({ code, text: t('lockRefused', { until: utcText(lockedUntil(res)) }) });
    else if (code === 'quant.edit_lock_unset') setRefused({ code, text: t('lockUnset') });
    else setFailure(res);
  }
  return (
    <section
      aria-label={t('lockTitle')}
      data-testid="quant-edit-lock"
      data-held={lock.held}
      data-mine={lock.mine}
      data-holder={lock.holderId ?? ''}
    >
      <h4>{t('lockTitle')}</h4>
      <p data-testid="quant-edit-lock-state">
        {!lock.held
          ? t('lockFree')
          : lock.mine
            ? t('lockMine', { until: utcText(lock.expiresAt ?? '') })
            : t('lockHeld', { holder: lock.holderId ?? '', until: utcText(lock.expiresAt ?? '') })}
      </p>
      {lock.mine ? (
        <Button tone="secondary" onClick={() => void act(QUANT_TEAM_UNLOCK)} disabled={busy}>
          {t('lockRelease')}
        </Button>
      ) : (
        <Button tone="primary" onClick={() => void act(QUANT_TEAM_LOCK)} disabled={busy}>
          {t('lockTake')}
        </Button>
      )}
      {refused && (
        <p role="alert" data-testid="quant-edit-lock-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <FailureNote result={failure} retry={() => void act(QUANT_TEAM_LOCK)} />}
    </section>
  );
}

/** The owner's team panel on a strategy's page (AL-team-01): collaborators, the edit lock and support access. */
export function StrategyTeam({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const team = useResource(
    (signal) => api.call(QUANT_TEAM_GET, { strategyId: strategy.id }, { signal }),
    `quant-team:${strategy.id}:${revision}`,
  );
  const reload = () => setRevision((n) => n + 1);
  const kept = useLastReady(team.resource);
  return (
    <section aria-label={t('teamTitle')} data-testid="quant-team">
      <h3>{t('teamTitle')}</h3>
      <p>{t('teamIntro')}</p>
      {kept ? (
        <>
          <Collaborators team={kept} onChange={reload} />
          <ShareForm strategyId={strategy.id} onChange={reload} />
          <EditLock strategyId={strategy.id} lock={kept.lock} onChange={reload} />
          <SupportAccess team={kept} onChange={reload} />
        </>
      ) : (
        <KitRead resource={team.resource} retry={team.reload}>
          {() => null}
        </KitRead>
      )}
    </section>
  );
}

function Collaborators({ team, onChange }: { team: QuantTeam; onChange: () => void }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function remove(memberId: string) {
    setNote(null);
    setFailure(null);
    const res = await api.call(QUANT_TEAM_REMOVE, { strategyId: team.strategyId, memberId });
    if (!res.ok) return setFailure(res);
    setNote(t('removed'));
    onChange();
  }
  return (
    <div data-testid="quant-collaborators">
      <h4>{t('collaborators')}</h4>
      {team.collaborators.length === 0 ? (
        <EmptyNote title={t('noCollaborators')} />
      ) : (
        <ScrollTable label={t('collaborators')} headers={[t('member'), t('permission'), t('liveControl'), t('added'), '']}>
          {team.collaborators.map((row) => (
            <tr
              key={row.memberId}
              data-testid="quant-collaborator"
              data-member={row.memberId}
              data-role={row.role}
              data-live={row.liveControl}
            >
              <td lang="zxx">{row.memberId}</td>
              <td>{t(row.role)}</td>
              <td>{row.liveControl ? t('liveYes') : t('liveNo')}</td>
              <td lang="zxx">{utcText(row.addedAt)}</td>
              <td>
                <Button tone="secondary" onClick={() => void remove(row.memberId)}>
                  {t('remove', { member: row.memberId })}
                </Button>
              </td>
            </tr>
          ))}
        </ScrollTable>
      )}
      {note && (
        <p role="status" data-testid="quant-team-note">
          {note}
        </p>
      )}
      {failure && <FailureNote result={failure} />}
    </div>
  );
}

function ShareForm({ strategyId, onChange }: { strategyId: string; onChange: () => void }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<'view' | 'edit'>('view');
  const [liveControl, setLiveControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function save() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setRefused(null);
    setFailure(null);
    const res = await api.call(QUANT_TEAM_SET, { strategyId, memberId: memberId.trim(), role, liveControl });
    setBusy(false);
    if (res.ok) {
      setNote(t('shared', { member: memberId.trim().toLowerCase(), permission: role === 'edit' ? t('canEdit') : t('canView') }));
      onChange();
      return;
    }
    if (refusalCode(res) === 'quant.team_member_invalid') setRefused(t('memberInvalid'));
    else setFailure(res);
  }
  return (
    <form
      data-testid="quant-share-form"
      aria-label={t('addTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h4>{t('addTitle')}</h4>
      <Field
        label={t('memberField')}
        hint={t('memberHint')}
        value={memberId}
        onChange={(event) => setMemberId(event.currentTarget.value)}
      />
      <SelectField
        label={t('permissionField')}
        value={role}
        onChange={(value) => setRole(value === 'edit' ? 'edit' : 'view')}
        options={[
          { value: 'view', label: t('view') },
          { value: 'edit', label: t('edit') },
        ]}
      />
      <CheckField label={t('liveField')} checked={liveControl} onChange={setLiveControl} />
      <Button tone="primary" type="submit" disabled={busy}>
        {t('share')}
      </Button>
      {busy && <Waiting />}
      {note && (
        <p role="status" data-testid="quant-share-note">
          {note}
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-share-refusal" data-code="quant.team_member_invalid">
          {refused}
        </p>
      )}
      {failure && <QuotaAwareFailure result={failure} />}
    </form>
  );
}

function SupportAccess({ team, onChange }: { team: QuantTeam; onChange: () => void }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function grant() {
    if (busy) return;
    const value = Number(minutes.trim());
    setNote(null);
    setRefused(null);
    setFailure(null);
    if (!minutes.trim() || !Number.isFinite(value)) return setRefused(t('grantInvalid'));
    setBusy(true);
    const res = await api.call(QUANT_TEAM_GRANT, { strategyId: team.strategyId, seconds: Math.round(value * 60), seq: team.grants.length });
    setBusy(false);
    if (res.ok) {
      setNote(t('granted', { until: utcText(res.data.grants[0]?.expiresAt ?? '') }));
      onChange();
      return;
    }
    if (refusalCode(res) === 'quant.grant_invalid') setRefused(t('grantInvalid'));
    else setFailure(res);
  }
  return (
    <section aria-label={t('supportTitle')} data-testid="quant-support">
      <h4>{t('supportTitle')}</h4>
      <p>{t('supportIntro')}</p>
      <Field label={t('grantField')} inputMode="decimal" value={minutes} onChange={(event) => setMinutes(event.currentTarget.value)} />
      <Button tone="primary" onClick={() => void grant()} disabled={busy}>
        {t('grant')}
      </Button>
      {note && (
        <p role="status" data-testid="quant-grant-note">
          {note}
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-grant-refusal" data-code="quant.grant_invalid">
          {refused}
        </p>
      )}
      {failure && <FailureNote result={failure} retry={() => void grant()} />}
      <h5>{t('grants')}</h5>
      {team.grants.length === 0 ? (
        <EmptyNote title={t('noGrants')} />
      ) : (
        <ScrollTable label={t('grants')} headers={[t('grantFrom'), t('grantUntil'), t('grantState')]}>
          {team.grants.map((row) => (
            <tr key={row.grantId} data-testid="quant-grant" data-active={row.active}>
              <td lang="zxx">{utcText(row.createdAt)}</td>
              <td lang="zxx">{utcText(row.expiresAt)}</td>
              <td>{row.active ? t('active') : t('ended')}</td>
            </tr>
          ))}
        </ScrollTable>
      )}
      <h5>{t('reads')}</h5>
      {team.reads.length === 0 ? (
        <EmptyNote title={t('noReads')} />
      ) : (
        <ScrollTable label={t('reads')} headers={[t('readAt'), t('reader'), t('readWhat')]}>
          {team.reads.map((row, i) => (
            <tr key={`${row.readAt}:${i}`} data-testid="quant-support-read" data-granted={row.granted}>
              <td lang="zxx">{utcText(row.readAt)}</td>
              <td lang="zxx">{row.reader}</td>
              <td>{row.granted ? t('sawSource') : t('sawMetadata')}</td>
            </tr>
          ))}
        </ScrollTable>
      )}
    </section>
  );
}
