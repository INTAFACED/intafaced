/**
 * Algo orders: create, then watch, pause, resume and cancel. Parameters are never edited (a new schedule is made from the
 * old numbers). Every change goes through the room writer with a confirm; an unknown outcome is settled by reading the
 * original schedule back from the service, never by sending again.
 */
import { useState } from 'react';
import { Button, Field, Input, type Loadable } from '../rooms/ui';
import { WriteNotice } from '../rooms/RoomNotices';
import { roomWords } from '../rooms/refusals';
import { useRoomApi } from '../rooms/read';
import { rememberId } from '../rooms/store';
import { useRoomWriter } from '../rooms/write';
import type { AlgoParent, AlgoPolicy } from '../rooms/api';
import { AlgoDetail, AlgoList, type AlgoAction } from './AlgoList';
import { AlgoForm, valuesFrom, type AlgoFormValues } from './AlgoForm';
import { execCopy } from './copy';
import { useAlgoIds, useParents, useRefreshParents, type ExecMarket } from './data';
import { ownsNote } from './model';
import { ConfirmDialog, Why } from './parts';

const ACTIONS: readonly AlgoAction[] = ['pause', 'resume', 'cancel'];

export function AlgoTab({
  markets,
  policy,
  userId,
}: {
  markets: readonly ExecMarket[];
  policy: Loadable<AlgoPolicy>;
  userId: string | null;
}) {
  const { t } = execCopy.useCopy();
  const room = useRoomApi();
  const writer = useRoomWriter();
  const { ids, list: algoList } = useAlgoIds(userId);
  const parents = useParents(ids);
  const refreshParents = useRefreshParents(ids);
  const [selected, setSelected] = useState<string | null>(null);
  const [typedId, setTypedId] = useState('');
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [action, setAction] = useState<{ parent: AlgoParent; action: AlgoAction } | null>(null);
  const [prefill, setPrefill] = useState<{ values: AlgoFormValues; token: number } | null>(null);

  async function openById() {
    const id = typedId.trim();
    if (!id) return;
    const result = await room.algoGet(id);
    if (result.ok) {
      rememberId('algo', userId, result.data.id);
      setSelected(result.data.id);
      setTypedId('');
      setOpenNote(null);
    } else {
      const words = roomWords({ code: result.code, reason: result.reason, message: result.message });
      setOpenNote(`${words.title}. ${words.body}`);
    }
  }

  /** Read the original back. Any answer from the service proves the state, so the note is dropped; a failed read keeps the lock. */
  async function check(id: string) {
    if (writer.note.state === 'pending' && !ownsNote('algo', writer.note.pending)) {
      setCheckNote(t('Check in another room'));
      return;
    }
    const colon = id.indexOf(':');
    const parentId = colon > 0 && ACTIONS.includes(id.slice(0, colon) as AlgoAction) ? id.slice(colon + 1) : id;
    const result = await room.algoGet(parentId);
    if (result.ok) {
      rememberId('algo', userId, result.data.id);
      writer.resolve(id);
      setSelected(result.data.id);
      setCheckNote(t('Checked: schedule {id} is {status}', { id: result.data.id, status: t(`Status ${result.data.status}`) }));
    } else if (result.code === 'trade.algo_not_found') {
      writer.resolve(id);
      setCheckNote(t('Checked: no schedule has that id, so nothing was created'));
    } else setCheckNote(t('Could not check, try again'));
  }

  async function run() {
    if (!action) return;
    const { parent, action: kind } = action;
    await writer.run({ kind: 'algo', id: `${kind}:${parent.id}`, symbol: parent.symbol, call: () => room.algoAction(kind, parent.id) });
    setAction(null);
    refreshParents();
  }

  const selectedRow = parents.status === 'ready' ? (parents.data.find((r) => r.id === selected) ?? null) : null;
  const capability = policy.status === 'ready' ? policy.data.capability : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <AlgoForm
        markets={markets}
        policy={policy}
        writer={writer}
        userId={userId}
        prefill={prefill}
        onCreated={setSelected}
        onCheck={(id) => void check(id)}
      />
      <div className="flex min-w-0 flex-col gap-3">
        {capability && !capability.createEnabled ? <Why>{t('Create off banner')}</Why> : null}
        {capability && !capability.jobsEnabled ? <Why>{t('Scheduler off banner')}</Why> : null}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('Open by id')} hint={t('Any schedule id you have, for example from another device')} className="min-w-64 flex-1">
            <Input
              aria-label={t('Open by id')}
              value={typedId}
              onValueChange={setTypedId}
              density="dense"
              onKeyDown={(e) => e.key === 'Enter' && void openById()}
            />
          </Field>
          <Button variant="secondary" size={32} disabled={!typedId.trim() || !userId} onClick={() => void openById()}>
            {t('Open')}
          </Button>
        </div>
        {openNote ? <Why>{openNote}</Why> : null}
        {checkNote ? (
          <p role="status" className="m-0 text-sm text-fg">
            {checkNote}
          </p>
        ) : null}
        <WriteNotice writer={writer} onCheck={(id) => void check(id)} done={t('Done, the list shows the new state')} />
        <AlgoList
          load={parents}
          empty={ids.length === 0}
          listing={algoList}
          selectedId={selected}
          onSelect={setSelected}
          onAction={(parent, kind) => setAction({ parent, action: kind })}
          locked={writer.busy || writer.note.state !== 'none'}
        />
        {selectedRow ? (
          <AlgoDetail row={selectedRow} onClone={(parent) => setPrefill({ values: valuesFrom(parent), token: Date.now() })} />
        ) : null}
      </div>
      <ConfirmDialog
        open={action !== null}
        title={action ? t(`Confirm ${action.action}`) : ''}
        description={action ? t(`Confirm ${action.action} body`) : ''}
        rows={
          action
            ? [
                { label: t('Schedule id'), value: action.parent.id, mono: true },
                { label: t('Market'), value: action.parent.symbol },
              ]
            : []
        }
        confirmLabel={action ? t(`Do ${action.action}`) : ''}
        tone={action?.action === 'cancel' ? 'secondary' : 'primary'}
        busy={writer.busy}
        onConfirm={() => void run()}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}
