import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import { useSession } from '../../../features/session/session';
import { positionsCopy } from './positions-copy';
import { newNonce, usePendingNote, useFuturesWriter, type Writer } from './hooks';
import { adjustmentId, closeAllPlan, leveragePresets, stateOf } from './model';
import {
  amountProblem,
  closeAllReduce,
  gateActions,
  hasUnresolved,
  pickNonce,
  remainingIds,
  resultOf,
  settleOf,
  startCloseAll,
  stopsRun,
  tally,
  type ActionKey,
  type CloseAllState,
  type CloseResult,
} from './positions-logic';
import type { Intent } from './write';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

const REFUSAL_LIQUIDATING = 'trade.liquidation_in_progress';

function sideWord(t: T, side: Position['side']): string {
  return side === 'long' ? t('Side long') : t('Side short');
}

/** One dialog frame: kit Dialog, controlled by whoever mounts it. */
function Frame({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { t } = positionsCopy.useCopy();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('Dialog close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="mt-4 flex flex-col gap-3 text-sm">{children}</div>
        <DialogFooter className="mt-5">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the last write said, in words: a refusal, an unknown answer (with a status check), or a block. */
function WriteNotice({ writer, onCheck }: { writer: Writer; onCheck: () => void }) {
  const { t } = positionsCopy.useCopy();
  const { outcome, note } = writer;
  if (note.state === 'unreadable')
    return (
      <p role="alert" className="text-error-text">
        {t('Earlier request unreadable')}
      </p>
    );
  if (note.state === 'pending' || outcome?.kind === 'uncertain') {
    const id = note.state === 'pending' ? note.pending.id : outcome?.kind === 'uncertain' ? outcome.id : '';
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-sm border border-line p-3">
        <p className="font-medium text-warn">{t('Unknown outcome title')}</p>
        <p className="text-fg-2">{t('Unknown outcome body', { id })}</p>
        <Button variant="secondary" size={28} loading={writer.busy} disabled={note.state !== 'pending'} onClick={onCheck}>
          {writer.busy ? t('Checking') : t('Check status')}
        </Button>
      </div>
    );
  }
  if (outcome?.kind === 'refused')
    return (
      <div role="alert" className="flex flex-col gap-1">
        <p className="font-medium text-error-text">{outcome.refusal.title}</p>
        <p className="text-fg-2">{outcome.refusal.body}</p>
        {outcome.refusal.code ? <p className="text-2xs text-fg-3">{t('Refusal code', { code: outcome.refusal.code })}</p> : null}
      </div>
    );
  if (outcome?.kind === 'blocked')
    return (
      <p role="alert" className="text-error-text">
        {t(`Blocked ${outcome.reason}`)}
      </p>
    );
  if (outcome?.kind === 'done')
    return (
      <p role="status" className="text-fg-2">
        {t('Earlier request done')}
      </p>
    );
  return null;
}

/** Send one intent, or look up the unresolved one. A finished write for THIS position closes the dialog via onDone. */
function useSend(position: Position, onDone: (p: Position) => void, onRefusal?: (code: string | null) => void) {
  const writer = useFuturesWriter();
  const refusal = writer.outcome?.kind === 'refused' ? writer.outcome.refusal.code : undefined;
  useEffect(() => {
    if (refusal !== undefined) onRefusal?.(refusal);
  }, [refusal, onRefusal]);
  const settle = (result: Awaited<ReturnType<Writer['run']>>) => {
    if (result.kind === 'done' && result.position.id === position.id) onDone(result.position);
  };
  return {
    writer,
    send: async (intent: Intent) => settle(await writer.run(intent)),
    check: async () => {
      if (writer.note.state === 'pending') settle(await writer.check(writer.note.pending));
    },
  };
}

interface DialogBase {
  position: Position;
  onClose(): void;
  onDone(p: Position): void;
  /** Called with the service code of a refusal, so a row can disable what a live liquidation step blocks. */
  onRefusal?(code: string | null): void;
}

export function MarginDialog({
  position,
  mode,
  free,
  onClose,
  onDone,
  onRefusal,
}: DialogBase & { mode: 'add' | 'reduce'; free: string | null }) {
  const { t } = positionsCopy.useCopy();
  const [amount, setAmount] = useState('');
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const { writer, send, check } = useSend(position, onDone, onRefusal);
  const asset = settleOf(position.symbol) ?? '';
  const problem = amountProblem(amount, { free: mode === 'add' ? free : null });
  const kind = mode === 'add' ? 'margin-add' : 'margin-reduce';
  const submit = () => {
    if (position.id === null || problem) return;
    // The same amount re-sends the same id; a changed amount is a new request with a new id.
    nonce.current = pickNonce(nonce.current, `${kind}:${position.id}:${amount}`, newNonce);
    const input = {
      symbol: position.symbol,
      positionId: position.id,
      amount,
      clientAdjustmentId: adjustmentId(kind, position.id, amount, nonce.current.nonce),
    };
    void send({ op: kind, input });
  };
  const word = mode === 'add' ? t('Margin add title') : t('Margin reduce title');
  return (
    <Frame
      title={word}
      onClose={onClose}
      description={t('Margin position line', {
        contract: position.symbol,
        side: sideWord(t, position.side),
        margin: fmtAmount(position.collateral, { places: 8 }),
        asset,
      })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            loading={writer.busy}
            disabled={problem !== null || writer.note.state !== 'none' || position.id === null}
            onClick={submit}
          >
            {mode === 'add' ? t('Margin add button') : t('Margin reduce button')}
          </Button>
        </>
      }
    >
      <Field
        label={t('Margin amount', { asset })}
        error={amount !== '' && problem && problem !== 'empty' ? t(`Problem ${problem}`) : undefined}
        hint={
          mode === 'add'
            ? free === null
              ? t('Margin free unknown')
              : t('Margin free', { free: fmtAmount(free, { places: 8 }), asset })
            : t('Margin reduce note')
        }
      >
        <Input kind="decimal" value={amount} onValueChange={setAmount} precision={8} trailing={asset} />
      </Field>
      <p className="text-fg-2">{t('Margin recompute')}</p>
      <WriteNotice writer={writer} onCheck={() => void check()} />
    </Frame>
  );
}

export function LeverageDialog({ position, cap, onClose, onDone, onRefusal }: DialogBase & { cap: string | null }) {
  const { t } = positionsCopy.useCopy();
  const [value, setValue] = useState('');
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const { writer, send, check } = useSend(position, onDone, onRefusal);
  const problem = amountProblem(value, { cap });
  const submit = () => {
    if (position.id === null || problem) return;
    nonce.current = pickNonce(nonce.current, `leverage:${position.id}:${value}`, newNonce);
    const input = {
      symbol: position.symbol,
      positionId: position.id,
      leverage: value,
      clientAdjustmentId: adjustmentId('leverage', position.id, value, nonce.current.nonce),
    };
    void send({ op: 'leverage', input });
  };
  return (
    <Frame
      title={t('Leverage title')}
      onClose={onClose}
      description={t('Leverage position line', {
        contract: position.symbol,
        side: sideWord(t, position.side),
        leverage: fmtAmount(position.leverage, { places: 2 }),
      })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            loading={writer.busy}
            disabled={problem !== null || writer.note.state !== 'none' || position.id === null}
            onClick={submit}
          >
            {t('Leverage button')}
          </Button>
        </>
      }
    >
      <Field
        label={t('Leverage field')}
        error={value !== '' && problem && problem !== 'empty' ? t(`Problem ${problem}`) : undefined}
        hint={cap === null ? t('Leverage cap unknown') : t('Leverage cap', { cap: fmtAmount(cap, { places: 2 }) })}
      >
        <Input kind="decimal" value={value} onValueChange={setValue} precision={2} trailing="x" />
      </Field>
      <div className="flex flex-wrap gap-2">
        {leveragePresets(cap).map((preset) => (
          <Button
            key={preset}
            variant="secondary"
            size={28}
            aria-label={t('Leverage preset', { value: preset })}
            onClick={() => setValue(preset)}
          >
            {preset}x
          </Button>
        ))}
      </div>
      <p className="text-warn">{t('Leverage warning')}</p>
      <p className="text-fg-2">{t('Margin recompute')}</p>
      <WriteNotice writer={writer} onCheck={() => void check()} />
    </Frame>
  );
}

export function CloseDialog({ position, onClose, onDone, onRefusal }: DialogBase) {
  const { t } = positionsCopy.useCopy();
  const { writer, send, check } = useSend(position, onDone, onRefusal);
  const closing = stateOf(position) === 'closing';
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const submit = () => {
    // No price field exists on a close: the service closes at the mark it accepts.
    // The same position and size reuse one clientCloseId; a retry replays that close.
    if (position.id === null) return;
    nonce.current = pickNonce(nonce.current, `close:${position.id}:${position.contracts}`, newNonce);
    void send({
      op: 'close',
      positionId: position.id,
      symbol: position.symbol,
      size: position.contracts,
      clientCloseId: nonce.current.nonce,
    });
  };
  return (
    <Frame
      title={closing ? t('Retry close title') : t('Close title')}
      onClose={onClose}
      description={
        position.markPrice === null
          ? t('Close summary no mark', {
              contract: position.symbol,
              side: sideWord(t, position.side),
              size: fmtAmount(position.contracts, { places: 8 }),
            })
          : t('Close summary', {
              contract: position.symbol,
              side: sideWord(t, position.side),
              size: fmtAmount(position.contracts, { places: 8 }),
              mark: fmtPrice(position.markPrice, null),
            })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="sell" loading={writer.busy} disabled={writer.note.state !== 'none' || position.id === null} onClick={submit}>
            {closing ? t('Retry close button') : t('Close button')}
          </Button>
        </>
      }
    >
      <p>{t('Close mark word')}</p>
      {closing ? <p className="text-fg-2">{t('Close retry word')}</p> : null}
      <WriteNotice writer={writer} onCheck={() => void check()} />
    </Frame>
  );
}

function ResultLine({ position, result, t }: { position: Position; result: CloseResult; t: T }) {
  const word =
    result.kind === 'refused' ? t('Result refused') : result.kind === 'blocked' ? t('Result blocked') : t(`Result ${result.kind}`);
  return (
    <li className="flex flex-col gap-0.5 border-b border-line py-1.5 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span>
          {position.symbol} <span className="text-fg-2">{sideWord(t, position.side)}</span>
        </span>
        <span className="font-medium">{word}</span>
      </div>
      {result.kind === 'refused' ? (
        <span className="text-fg-2">
          {result.title}. {result.body}
        </span>
      ) : null}
      {result.kind === 'blocked' ? <span className="text-fg-2">{t(`Blocked ${result.reason}`)}</span> : null}
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  return (
    <Frame
      title={t('Close all title')}
      onClose={() => !running && onClose()}
      description={plan.length === 1 ? t('Close all count one') : t('Close all count', { count: String(plan.length) })}
      footer={
        <>
          <Button variant="secondary" disabled={running} onClick={onClose}>
            {started ? t('Done close') : t('Cancel')}
          </Button>
          {left.length > 0 ? (
            <Button variant="sell" loading={running} disabled={unresolved || running} onClick={() => void run(left)}>
              {started
                ? left.length === 1
                  ? t('Close all remaining one')
                  : t('Close all remaining', { count: String(left.length) })
                : left.length === 1
                  ? t('Close all button one')
                  : t('Close all button', { count: String(left.length) })}
            </Button>
          ) : null}
        </>
      }
    >
      <ul aria-label={t('Close all list label')} className="m-0 list-none p-0">
        {plan.map((p) => (
          <ResultLine key={p.id} position={p} result={state.results[p.id ?? ''] ?? { kind: 'waiting' }} t={t} />
        ))}
      </ul>
      <p className="text-fg-2">{t('Close all stops')}</p>
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
        <p role="alert" className="text-warn">
          {t('Close all unresolved')}
        </p>
      ) : null}
      {writer.note.state !== 'none' ? <WriteNotice writer={writer} onCheck={() => void check()} /> : null}
    </Frame>
  );
}

/** The row buttons and their dialogs. Every disabled button says why, in words next to it. */
export function PositionRowActions({
  position,
  free,
  leverageCap,
  planeOff,
  locked = false,
  stale = false,
  onChanged,
  only = ['add', 'reduce', 'leverage', 'close'],
  compact = false,
}: {
  position: Position;
  free: string | null;
  leverageCap: string | null;
  planeOff: boolean;
  locked?: boolean;
  /** The positions read is old: actions priced off the mark are off. */
  stale?: boolean;
  onChanged(): void;
  only?: ActionKey[];
  /** Fold the margin and leverage actions into one Manage menu so Close always stays in view (dense tables). */
  compact?: boolean;
}) {
  const { t } = positionsCopy.useCopy();
  const { userId } = useSession();
  const note = usePendingNote(userId);
  const [open, setOpen] = useState<ActionKey | null>(null);
  const [liquidating, setLiquidating] = useState(false);
  const gate = gateActions({ position, planeOff, writerLocked: locked || note.state !== 'none', liquidating, stale });
  const shown = only.filter((key) => key in gate);
  const reason = shown.map((key) => gate[key]).find((r) => r !== null) ?? null;
  const closing = stateOf(position) === 'closing';
  const label: Record<ActionKey, string> = {
    add: t('Action add'),
    reduce: t('Action reduce'),
    leverage: t('Action leverage'),
    close: closing ? t('Action retry close') : t('Action close'),
  };
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const onRefusal = (code: string | null) => code === REFUSAL_LIQUIDATING && setLiquidating(true);
  const common = { position, onClose: () => setOpen(null), onDone: done, onRefusal };
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-nowrap items-center gap-1.5">
        {compact && shown.filter((key) => key !== 'close').length > 1 ? (
          <Menu>
            <MenuTrigger render={<Button variant="secondary" size={28} aria-label={t('Manage label', { contract: position.symbol })} />}>
              {t('Manage')}
            </MenuTrigger>
            <MenuContent align="end">
              {shown
                .filter((key) => key !== 'close')
                .map((key) => (
                  <MenuItem key={key} disabled={gate[key] !== null} onClick={() => setOpen(key)}>
                    {label[key]}
                  </MenuItem>
                ))}
            </MenuContent>
          </Menu>
        ) : null}
        {(compact && shown.filter((key) => key !== 'close').length > 1 ? shown.filter((key) => key === 'close') : shown).map((key) => (
          <Button
            key={key}
            variant={key === 'close' ? 'sell' : 'secondary'}
            size={28}
            disabled={gate[key] !== null}
            aria-label={t('Action label', { action: label[key], contract: position.symbol })}
            onClick={() => setOpen(key)}
          >
            {label[key]}
          </Button>
        ))}
      </div>
      {reason ? <span className="text-2xs text-fg-2">{t(`Reason ${reason}`)}</span> : null}
      {open === 'add' || open === 'reduce' ? <MarginDialog {...common} mode={open} free={free} /> : null}
      {open === 'leverage' ? <LeverageDialog {...common} cap={leverageCap} /> : null}
      {open === 'close' ? <CloseDialog {...common} /> : null}
    </div>
  );
}
