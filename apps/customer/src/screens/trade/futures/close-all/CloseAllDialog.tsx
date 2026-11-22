/**
 * Close all, reduce-only (the futures desk's positions table and the risk room, J-derivatives-05): the positions fixed when
 * the sheet opens, closed one at a time with each one's own request identity and its own result, and what the last write
 * said. Drawn only from the kit; the close itself is the futures desk's own (`../hooks`, `../positions-logic`).
 */
import { useRef, useState, type ReactNode } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { useMounted } from '../../../../shared/outside';
import { positionsCopy } from '../positions-copy';
import { newNonce, useFuturesWriter, type Writer } from '../hooks';
import { closeAllPlan } from '../model';
import {
  closeAllReduce,
  hasUnresolved,
  remainingIds,
  resultOf,
  startCloseAll,
  stopsRun,
  tally,
  type CloseAllState,
  type CloseResult,
} from '../positions-logic';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

export function sideWord(t: T, side: Position['side']): string {
  return side === 'long' ? t('Side long') : t('Side short');
}

/**
 * A sheet that stays open while `busy`: a close asked for while a run is sending (Escape, the sheet's own Close) draws the
 * sheet again, so the run's results are never hidden mid-run.
 */
export function BusySheet({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const [shown, setShown] = useState(0);
  return (
    <Sheet key={shown} open title={title} onClose={() => (busy ? setShown((n) => n + 1) : onClose())}>
      {children}
    </Sheet>
  );
}

/** What the last write said, in words: a refusal, an unknown answer (with a status check), or a block. */
export function WriteNotice({ writer, onCheck }: { writer: Writer; onCheck: () => void }) {
  const { t } = positionsCopy.useCopy();
  const { outcome, note } = writer;
  if (note.state === 'unreadable')
    return (
      <p role="alert" className="lt-refusal">
        {t('Earlier request unreadable')}
      </p>
    );
  if (note.state === 'pending' || outcome?.kind === 'uncertain') {
    const id = note.state === 'pending' ? note.pending.id : outcome?.kind === 'uncertain' ? outcome.id : '';
    return (
      <div role="alert" className="lt-refusal">
        <p className="lt-refusal-title">{t('Unknown outcome title')}</p>
        <p className="lt-refusal-body">{t('Unknown outcome body', { id })}</p>
        <Button tone="secondary" aria-busy={writer.busy || undefined} disabled={writer.busy || note.state !== 'pending'} onClick={onCheck}>
          {writer.busy ? t('Checking') : t('Check status')}
        </Button>
      </div>
    );
  }
  if (outcome?.kind === 'refused')
    return (
      <div role="alert" className="lt-refusal">
        <p className="lt-refusal-title">{outcome.refusal.title}</p>
        <p className="lt-refusal-body">{outcome.refusal.body}</p>
        {outcome.refusal.code ? <p className="lt-ref">{t('Refusal code', { code: outcome.refusal.code })}</p> : null}
      </div>
    );
  if (outcome?.kind === 'blocked')
    return (
      <p role="alert" className="lt-refusal">
        {t(`Blocked ${outcome.reason}`)}
      </p>
    );
  if (outcome?.kind === 'done')
    return (
      <p role="status" className="lt-hint">
        {t('Earlier request done')}
      </p>
    );
  return null;
}

function ResultLine({ position, result, t }: { position: Position; result: CloseResult; t: T }) {
  const word =
    result.kind === 'refused' ? t('Result refused') : result.kind === 'blocked' ? t('Result blocked') : t(`Result ${result.kind}`);
  return (
    <li>
      <div className="lt-actions">
        <span>
          {position.symbol} <span className="lt-hint">{sideWord(t, position.side)}</span>
        </span>
        <strong>{word}</strong>
      </div>
      {result.kind === 'refused' ? (
        <span className="lt-hint">
          {result.title}. {result.body}
        </span>
      ) : null}
      {result.kind === 'blocked' ? <span className="lt-hint">{t(`Blocked ${result.reason}`)}</span> : null}
    </li>
  );
}

export function CloseAllDialog({ positions, onClose, onDone }: { positions: Position[]; onClose(): void; onDone(): void }) {
  const { t } = positionsCopy.useCopy();
  const writer = useFuturesWriter();
  // The list is fixed when the dialog opens, so a position that closes mid-run does not change what was confirmed.
  const [plan] = useState(() => closeAllPlan(positions));
  const [state, setState] = useState<CloseAllState>(() => startCloseAll(plan.map((p) => p.id ?? '')));
  const closeIds = useRef(new Map<string, string>());
  const [running, setRunning] = useState(false);
  const mounted = useMounted();
  const apply = (event: Parameters<typeof closeAllReduce>[1]) => mounted.current && setState((s) => closeAllReduce(s, event));

  async function run(ids: string[]) {
    setRunning(true);
    for (const id of ids) {
      const position = plan.find((p) => p.id === id);
      if (!position) continue;
      apply({ type: 'sending', id });
      // One close per position, one at a time. Nothing else is sent while an answer is unknown.
      let clientCloseId = closeIds.current.get(id);
      if (!clientCloseId) {
        clientCloseId = newNonce();
        closeIds.current.set(id, clientCloseId);
      }
      const result = resultOf(
        await writer.run({
          op: 'close',
          positionId: id,
          symbol: position.symbol,
          side: position.side,
          size: position.contracts,
          clientCloseId,
        }),
      );
      apply({ type: 'result', id, result });
      if (stopsRun(result)) {
        apply({ type: 'stop' });
        break;
      }
    }
    if (mounted.current) setRunning(false);
    onDone();
  }

  async function check() {
    if (writer.note.state !== 'pending') return;
    const pending = writer.note.pending;
    const id = pending.id.startsWith('close:') ? pending.id.slice('close:'.length) : null;
    const result = resultOf(await writer.check(pending));
    if (id && result.kind !== 'uncertain') apply({ type: 'result', id, result });
    onDone();
  }

  const unresolved = hasUnresolved(state) || writer.note.state !== 'none';
  const left = remainingIds(state);
  const counts = tally(state);
  const started = left.length < plan.length;
  const description = plan.length === 1 ? t('Close all count one') : t('Close all count', { count: String(plan.length) });
  return (
    <BusySheet title={t('Close all title')} busy={running} onClose={onClose}>
      <div className="lt-stack">
        <p className="lt-hint">{description}</p>
        <ul aria-label={t('Close all list label')} className="lt-rows">
          {plan.map((p) => (
            <ResultLine key={p.id} position={p} result={state.results[p.id ?? ''] ?? { kind: 'waiting' }} t={t} />
          ))}
        </ul>
        <p className="lt-hint">{t('Close all stops')}</p>
        {started ? (
          <p role="status">
            {t('Close all summary', {
              done: String(counts.done),
              refused: String(counts.refused),
              unknown: String(counts.unknown),
              total: String(counts.total),
            })}
          </p>
        ) : null}
        {unresolved ? (
          <p role="alert" className="lt-refusal">
            {t('Close all unresolved')}
          </p>
        ) : null}
        {writer.note.state !== 'none' ? <WriteNotice writer={writer} onCheck={() => void check()} /> : null}
        <div className="lt-actions">
          <Button tone="secondary" disabled={running} onClick={onClose}>
            {started ? t('Done close') : t('Cancel')}
          </Button>
          {left.length > 0 ? (
            <Button tone="primary" aria-busy={running || undefined} disabled={unresolved || running} onClick={() => void run(left)}>
              {started
                ? left.length === 1
                  ? t('Close all remaining one')
                  : t('Close all remaining', { count: String(left.length) })
                : left.length === 1
                  ? t('Close all button one')
                  : t('Close all button', { count: String(left.length) })}
            </Button>
          ) : null}
        </div>
      </div>
    </BusySheet>
  );
}
