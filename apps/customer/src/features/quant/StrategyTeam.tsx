import { type QuantStrategyDetail } from '@intafaced/contracts/quant-algo';
import { quantEditLockSchema, quantTeamSchema, type QuantEditLock, type QuantTeam } from '@intafaced/contracts/quant-team';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { QuotaAwareFailure } from './quota-refusal';
import { teamCopy } from './team-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');
/** The code a refusal starts with, as the service sends it: `quant.edit_locked — …`. */
export const refusalCode = (result: Failed) => result.code ?? /^([a-z]+\.[a-z_]+) — /.exec(result.message.trim())?.[1] ?? null;
/** The time a lock refusal names: `… holds the edit lock until <iso>; …`. */
export const lockedUntil = (result: Failed) => /until (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(result.message)?.[1] ?? '';

/** The edit lock, as anyone who may edit reads it, with Take and Let go. */
export function EditLock({ strategyId, lock, onChange }: { strategyId: string; lock: QuantEditLock; onChange: () => void }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ code: string; text: string } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function act(path: 'team.lock' | 'team.unlock') {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    const res = await api.mutate('quant', path, { strategyId }, quantEditLockSchema);
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
        <Button variant="secondary" onClick={() => void act('team.unlock')} disabled={busy}>
          {t('lockRelease')}
        </Button>
      ) : (
        <Button onClick={() => void act('team.lock')} disabled={busy}>
          {t('lockTake')}
        </Button>
      )}
      {refused && (
        <p role="alert" data-testid="quant-edit-lock-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <Failure result={failure} retry={() => void act('team.lock')} />}
    </section>
  );
}

/** The owner's team panel on a strategy's page (AL-team-01): collaborators, the edit lock and support access. */
export function StrategyTeam({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const team = useResource(
    (signal) => api.query('quant', 'team.get', { strategyId: strategy.id }, quantTeamSchema, { signal }),
    `quant-team:${strategy.id}:${revision}`,
  );
  const reload = () => setRevision((n) => n + 1);
  return (
    <section aria-label={t('teamTitle')} data-testid="quant-team">
      <h3>{t('teamTitle')}</h3>
      <p className="muted">{t('teamIntro')}</p>
      <Read resource={team.resource} retry={team.reload}>
        {(data) => (
          <>
            <Collaborators team={data} onChange={reload} />
            <ShareForm strategyId={strategy.id} onChange={reload} />
            <EditLock strategyId={strategy.id} lock={data.lock} onChange={reload} />
            <SupportAccess team={data} onChange={reload} />
          </>
        )}
      </Read>
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
    const res = await api.mutate('quant', 'team.remove', { strategyId: team.strategyId, memberId }, quantTeamSchema);
    if (!res.ok) return setFailure(res);
    setNote(t('removed'));
    onChange();
  }
  return (
    <div data-testid="quant-collaborators">
      <h4>{t('collaborators')}</h4>
      {team.collaborators.length === 0 ? (
        <EmptyState title={t('noCollaborators')} />
      ) : (
        <DataTable label={t('collaborators')} headers={[t('member'), t('permission'), t('liveControl'), t('added'), '']}>
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
                <Button variant="danger" onClick={() => void remove(row.memberId)}>
                  {t('remove', { member: row.memberId })}
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {note && (
        <p role="status" data-testid="quant-team-note">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
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
    const res = await api.mutate('quant', 'team.set', { strategyId, memberId: memberId.trim(), role, liveControl }, quantTeamSchema);
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
      <Select
        label={t('permissionField')}
        value={role}
        onChange={(value) => setRole(value === 'edit' ? 'edit' : 'view')}
        options={[
          { value: 'view', label: t('view') },
          { value: 'edit', label: t('edit') },
        ]}
      />
      <label className="quant-check-line">
        <input
          className="quant-run-check"
          type="checkbox"
          checked={liveControl}
          onChange={(event) => setLiveControl(event.currentTarget.checked)}
        />{' '}
        {t('liveField')}
      </label>
      <Button type="submit" disabled={busy}>
        {t('share')}
      </Button>
      {busy && <Loading />}
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
    const res = await api.mutate(
      'quant',
      'team.grant',
      { strategyId: team.strategyId, seconds: Math.round(value * 60), seq: team.grants.length },
      quantTeamSchema,
    );
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
      <p className="muted">{t('supportIntro')}</p>
      <Field label={t('grantField')} inputMode="decimal" value={minutes} onChange={(event) => setMinutes(event.currentTarget.value)} />
      <Button onClick={() => void grant()} disabled={busy}>
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
      {failure && <Failure result={failure} retry={() => void grant()} />}
      <h5>{t('grants')}</h5>
      {team.grants.length === 0 ? (
        <EmptyState title={t('noGrants')} />
      ) : (
        <DataTable label={t('grants')} headers={[t('grantFrom'), t('grantUntil'), t('grantState')]}>
          {team.grants.map((row) => (
            <tr key={row.grantId} data-testid="quant-grant" data-active={row.active}>
              <td lang="zxx">{utcText(row.createdAt)}</td>
              <td lang="zxx">{utcText(row.expiresAt)}</td>
              <td>{row.active ? t('active') : t('ended')}</td>
            </tr>
          ))}
        </DataTable>
      )}
      <h5>{t('reads')}</h5>
      {team.reads.length === 0 ? (
        <EmptyState title={t('noReads')} />
      ) : (
        <DataTable label={t('reads')} headers={[t('readAt'), t('reader'), t('readWhat')]}>
          {team.reads.map((row, i) => (
            <tr key={`${row.readAt}:${i}`} data-testid="quant-support-read" data-granted={row.granted}>
              <td lang="zxx">{utcText(row.readAt)}</td>
              <td lang="zxx">{row.reader}</td>
              <td>{row.granted ? t('sawSource') : t('sawMetadata')}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </section>
  );
}
