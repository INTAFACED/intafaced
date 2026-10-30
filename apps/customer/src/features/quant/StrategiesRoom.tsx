import {
  QUANT_DESCRIPTION_MAX,
  QUANT_FOLDER_MAX,
  quantStrategyCardPageSchema,
  quantStrategyCardSchema,
  type QuantStrategyCard,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Panel, Tabs } from '../../shared/ui';
import { Read, Select } from '../more/common';
import { preservePaperHref } from '../more/trade-context';
import { useApi } from '../session/session';
import { QuantRooms } from './QuantRooms';
import { strategiesCopy } from './strategies-copy';
import { MorePages, useStrategyPages } from './strategy-pages';
import './algo.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** An ISO instant as its UTC minute, "2026-10-23 03:40". */
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');
type ListTab = 'saved' | 'bin';
const TABS: readonly ListTab[] = ['saved', 'bin'];
const ALL = '\u0000all';
const deletedOk = z.object({ ok: z.literal(true) });

/** The tab the address names (`?tab=bin`), so the recycle bin can be linked to and survives a reload. */
function tabOf(search: string): ListTab {
  return new URLSearchParams(search).get('tab') === 'bin' ? 'bin' : 'saved';
}

/**
 * The strategy list (AL-editor-01): the account's saved strategies with version, folder and description; rename, move
 * and describe without adding a version; delete to the recycle bin and restore with the same versions. Each write is
 * keyed from what the screen read, so a press after a lost reply replays the first answer instead of writing twice.
 */
export function StrategiesRoom({ paper }: { paper: boolean }) {
  const { t } = strategiesCopy.useCopy();
  const [tab, setTab] = useState<ListTab>(() => tabOf(location.search));
  const [revision, setRevision] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  function choose(next: string) {
    const value = next === 'bin' ? 'bin' : 'saved';
    setTab(value);
    setNote(null);
    const url = new URL(location.href);
    if (value === 'bin') url.searchParams.set('tab', 'bin');
    else url.searchParams.delete('tab');
    history.replaceState(history.state, '', url);
  }
  const changed = (message: string) => {
    setNote(message);
    setRevision((n) => n + 1);
  };
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <Panel title={t('title')}>
        <div data-testid="quant-strategies">
          <p className="muted">{t('simulated')}</p>
          <Tabs items={TABS} value={tab} onChange={choose} label={t('tabs')} labels={{ saved: t('tabSaved'), bin: t('tabBin') }} />
          {note && (
            <p role="status" data-testid="quant-strategies-note">
              {note}
            </p>
          )}
          {tab === 'saved' ? (
            <SavedList key={`saved:${revision}`} paper={paper} onChanged={changed} />
          ) : (
            <RecycleBin key={`bin:${revision}`} onChanged={changed} />
          )}
        </div>
      </Panel>
    </>
  );
}

function SavedList({ paper, onChanged }: { paper: boolean; onChanged: (note: string) => void }) {
  const api = useApi();
  const { t } = strategiesCopy.useCopy();
  const pages = useStrategyPages('studio.list', quantStrategyCardPageSchema, '');
  const [folder, setFolder] = useState(ALL);
  const [editing, setEditing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);

  async function remove(strategy: QuantStrategyCard) {
    if (busyId) return;
    setBusyId(strategy.id);
    setFailure(null);
    // Keyed by the restores the list read, so a delete after a restore is a new delete, not a replay of the first.
    const res = await api.mutate(
      'quant',
      'studio.delete',
      { id: strategy.id, idempotencyKey: `studio.delete:${strategy.id}:${strategy.restores}` },
      deletedOk,
    );
    setBusyId(null);
    if (res.ok) onChanged(t('deletedNote', { name: strategy.name, version: strategy.version }));
    else setFailure(res);
  }

  return (
    <Read resource={pages.first.resource} retry={pages.first.reload}>
      {(data) => {
        const { rows, cursor } = pages.rowsOf(data);
        if (!rows.length) {
          return (
            <EmptyState
              title={t('none')}
              action={
                <a className="button" href={preservePaperHref('/quant/studio', paper)}>
                  {t('openStudio')}
                </a>
              }
            >
              {t('noneBody')}
            </EmptyState>
          );
        }
        const folders = [...new Set(rows.map((row) => row.folder))].sort((a, b) => a.localeCompare(b));
        const shown = folder === ALL ? rows : rows.filter((row) => row.folder === folder);
        return (
          <>
            <Select
              label={t('folderFilter')}
              value={folder}
              onChange={setFolder}
              options={[{ value: ALL, label: t('folderAll') }, ...folders.map((name) => ({ value: name, label: name || t('folderRoot') }))]}
            />
            {cursor && folder !== ALL && (
              <p className="muted" role="note">
                {t('folderPartial')}
              </p>
            )}
            {failure && <Failure result={failure} />}
            {shown.length === 0 ? (
              <EmptyState title={t('noneInFolder')} />
            ) : (
              <DataTable
                label={t('tabSaved')}
                headers={[t('name'), t('folder'), t('version'), t('saved'), t('descriptionHeading'), t('actions')]}
              >
                {shown.map((row) => (
                  <tr key={row.id} data-testid="quant-strategy-row" data-id={row.id} data-version={row.version} data-folder={row.folder}>
                    <td lang="und" data-testid="quant-strategy-name">
                      {row.name}
                    </td>
                    <td lang="und">{row.folder || t('folderRoot')}</td>
                    <td>{t('versionOf', { version: row.version })}</td>
                    <td lang="zxx">{utcText(row.createdAt)}</td>
                    <td lang="und">{row.description || t('noDescription')}</td>
                    <td>
                      {editing === row.id ? (
                        <OrganiseForm
                          strategy={row}
                          onCancel={() => setEditing(null)}
                          onSaved={(applied) => {
                            setEditing(null);
                            onChanged(applied ? t('organised') : t('organisedElsewhere'));
                          }}
                        />
                      ) : (
                        <>
                          <Button variant="secondary" onClick={() => setEditing(row.id)} disabled={busyId !== null}>
                            {t('organise', { name: row.name })}
                          </Button>
                          <Button variant="secondary" onClick={() => void remove(row)} disabled={busyId !== null}>
                            {t('delete', { name: row.name })}
                          </Button>
                          {busyId === row.id && <Loading label={t('deleting')} />}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            <MorePages cursor={cursor} busy={pages.busy} failure={pages.failure} more={(next) => void pages.more(next)} />
          </>
        );
      }}
    </Read>
  );
}

/** Rename, move and describe one strategy. The head changes; no version is added. */
function OrganiseForm(props: { strategy: QuantStrategyCard; onCancel: () => void; onSaved: (applied: boolean) => void }) {
  const api = useApi();
  const { t } = strategiesCopy.useCopy();
  const { strategy } = props;
  const [name, setName] = useState(strategy.name);
  const [folder, setFolder] = useState(strategy.folder);
  const [description, setDescription] = useState(strategy.description);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function save() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    // Keyed by how many times the head was organised when the list read it: a lost reply replays this same write.
    const res = await api.mutate(
      'quant',
      'studio.organise',
      { id: strategy.id, name, folder, description, idempotencyKey: `studio.organise:${strategy.id}:${strategy.organised}` },
      quantStrategyCardSchema,
    );
    setBusy(false);
    if (!res.ok) {
      setFailure(res);
      return;
    }
    // The same key answers with the write it first stored. If that is not what was sent here, another tab or device
    // organised this strategy from the same read: say so and read the list again rather than claim this change.
    const head = res.data;
    const sent = { name: name.trim(), folder: folder.trim(), description: description.trim() };
    props.onSaved(head.name === sent.name && head.folder === sent.folder && head.description === sent.description);
  }
  return (
    <form
      data-testid="quant-organise"
      aria-label={t('organiseTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label={t('nameLabel')} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={128} />
      <Field
        label={t('folderLabel')}
        hint={t('folderHint', { max: QUANT_FOLDER_MAX })}
        value={folder}
        onChange={(event) => setFolder(event.currentTarget.value)}
        maxLength={QUANT_FOLDER_MAX}
      />
      <Field
        label={t('descriptionLabel')}
        value={description}
        onChange={(event) => setDescription(event.currentTarget.value)}
        maxLength={QUANT_DESCRIPTION_MAX}
      />
      <Button type="submit" disabled={busy}>
        {t('save')}
      </Button>
      <Button type="button" variant="secondary" onClick={props.onCancel} disabled={busy}>
        {t('cancel')}
      </Button>
      {busy && <Loading label={t('saving')} />}
      {failure && <Failure result={failure} />}
    </form>
  );
}

function RecycleBin({ onChanged }: { onChanged: (note: string) => void }) {
  const api = useApi();
  const { t } = strategiesCopy.useCopy();
  const pages = useStrategyPages('studio.listDeleted', quantStrategyCardPageSchema, '');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function restore(strategy: QuantStrategyCard) {
    if (busyId) return;
    setBusyId(strategy.id);
    setFailure(null);
    // Keyed by the delete it undoes, so a lost reply replays this restore and a later delete can be restored again.
    const res = await api.mutate(
      'quant',
      'studio.restore',
      { id: strategy.id, idempotencyKey: `studio.restore:${strategy.id}:${strategy.deletedAt ?? ''}` },
      quantStrategyCardSchema,
    );
    setBusyId(null);
    if (res.ok) onChanged(t('restoredNote', { name: res.data.name, version: res.data.version }));
    else setFailure(res);
  }
  return (
    <Read resource={pages.first.resource} retry={pages.first.reload}>
      {(data) => {
        const { rows, cursor } = pages.rowsOf(data);
        if (!rows.length) return <EmptyState title={t('binNone')}>{t('binNoneBody')}</EmptyState>;
        return (
          <>
            {failure && <Failure result={failure} />}
            <DataTable label={t('tabBin')} headers={[t('name'), t('folder'), t('version'), t('deleted'), t('actions')]}>
              {rows.map((row) => (
                <tr key={row.id} data-testid="quant-bin-row" data-id={row.id} data-version={row.version}>
                  <td lang="und">{row.name}</td>
                  <td lang="und">{row.folder || t('folderRoot')}</td>
                  <td>{t('versionOf', { version: row.version })}</td>
                  <td lang="zxx">{row.deletedAt ? utcText(row.deletedAt) : ''}</td>
                  <td>
                    <Button variant="secondary" onClick={() => void restore(row)} disabled={busyId !== null}>
                      {t('restore', { name: row.name })}
                    </Button>
                    {busyId === row.id && <Loading label={t('restoring')} />}
                  </td>
                </tr>
              ))}
            </DataTable>
            <MorePages cursor={cursor} busy={pages.busy} failure={pages.failure} more={(next) => void pages.more(next)} />
          </>
        );
      }}
    </Read>
  );
}
