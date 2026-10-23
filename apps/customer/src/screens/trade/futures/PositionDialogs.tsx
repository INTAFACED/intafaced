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
  SegmentedControl,
} from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import { useSession } from '../../../features/session/session';
import type { ConditionalOrder, StopInput } from './api';
import { useConditionalOrders, useFuturesRefresh } from './data';
import { positionsCopy } from './positions-copy';
import { newNonce, usePendingNote, useFuturesWriter, type Writer } from './hooks';
import { adjustmentId, closeAllPlan, leveragePresets, stateOf } from './model';
import {
  amountProblem,
  closeAllReduce,
  closeShare,
  closeSizeProblem,
  gateActions,
  hasUnresolved,
  pickNonce,
  remainingIds,
  resultOf,
  settleOf,
  signedAmount,
  startCloseAll,
  stopsRun,
  tally,
  type ActionKey,
  type CloseAllState,
  type CloseResult,
} from './positions-logic';
import { coverage, estimatedResult, legsOf, partProblem, priceProblem, sideOfMark, type Leg } from './protection-logic';
import { TriggerFacts, triggerLine } from './TriggerFacts';
import { triggersCopy } from './triggers-copy';
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
      {/* A tall dialog (take profit and stop loss with their sizes) scrolls inside itself on a short screen, so its title
          and close stay reachable. */}
      <DialogContent closeLabel={t('Dialog close')} className="max-h-[calc(100dvh-32px)] overflow-y-auto">
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
export function WriteNotice({ writer, onCheck }: { writer: Writer; onCheck: () => void }) {
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
    // A close answers with the position as it now stands; when that read failed, the order is the record and the room re-reads.
    if (result.kind === 'done' && (result.position?.id ?? position.id) === position.id) onDone(result.position ?? position);
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
  // Empty is the whole position; any other size is a partial close.
  const [sizeRaw, setSizeRaw] = useState('');
  const size = sizeRaw.trim() === '' ? position.contracts : sizeRaw;
  const problem = closeSizeProblem(size, position.contracts);
  const submit = () => {
    // A close is a reduce-only market order through the book, bounded at the position's bankruptcy price.
    // The same position and size reuse one clientCloseId; a retry replays that order.
    if (position.id === null || problem !== null) return;
    nonce.current = pickNonce(nonce.current, `close:${position.id}:${size}`, newNonce);
    void send({
      op: 'close',
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      size,
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
          <Button
            variant="sell"
            loading={writer.busy}
            disabled={writer.note.state !== 'none' || position.id === null || problem !== null}
            onClick={submit}
          >
            {closing ? t('Retry close button') : sizeRaw.trim() === '' ? t('Close button') : t('Close part button')}
          </Button>
        </>
      }
    >
      <Field
        label={t('Close size field')}
        hint={t('Close size hint', { size: fmtAmount(position.contracts, { places: 8 }) })}
        error={sizeRaw !== '' && problem ? t(`Close problem ${problem}`) : undefined}
      >
        <Input kind="decimal" value={sizeRaw} onValueChange={setSizeRaw} precision={8} />
      </Field>
      <div role="group" aria-label={t('Close share group')} className="flex flex-wrap gap-2">
        {[25, 50, 75, 100].map((pct) => (
          <Button
            key={pct}
            variant="secondary"
            size={28}
            onClick={() => setSizeRaw(pct === 100 ? '' : (closeShare(position.contracts, pct) ?? ''))}
          >
            {t('Close share', { pct: String(pct) })}
          </Button>
        ))}
      </div>
      <p>{t('Close mark word')}</p>
      {closing ? <p className="text-fg-2">{t('Close retry word')}</p> : null}
      <WriteNotice writer={writer} onCheck={() => void check()} />
    </Frame>
  );
}

/** One leg as it stands: its status in words, its trigger and the price it is judged on, and what a fired one did. */
function LegLine({ leg, order, contracts, t }: { leg: Leg; order: ConditionalOrder | null; contracts: string; t: T }) {
  const words = triggersCopy.useCopy().t;
  const name = leg === 'take_profit' ? t('Protect take profit') : t('Protect stop loss');
  if (order === null) return <li data-leg={leg}>{t('Protect leg', { leg: name, status: t('Protect none') })}</li>;
  const trigger = triggerLine(order, words);
  const covers = coverage(order, contracts);
  return (
    <li data-leg={leg} data-status={order.status} className="flex flex-col gap-0.5">
      <span className="font-medium">{t('Protect leg', { leg: name, status: words(`Status ${order.status}`) })}</span>
      {trigger ? <span className="text-fg-2">{trigger}</span> : null}
      {covers === null ? null : covers.whole ? (
        <span className="text-fg-2">{t('Protect covers whole')}</span>
      ) : (
        <span className="text-fg-2">
          {t('Protect covers part', {
            part: fmtAmount(covers.part, { places: 8 }),
            size: fmtAmount(contracts, { places: 8 }),
            rest: fmtAmount(covers.rest, { places: 8 }),
          })}
        </span>
      )}
      <TriggerFacts order={order} />
    </li>
  );
}

/**
 * A position's take profit and stop loss (J-derivatives-03 steps 1, 2, 6). Saving replaces both legs, so the fields
 * start from what is armed, and nothing is sent until that has been read. The dialog stays open after a save and keeps
 * reading; once a leg fires and the position closes, the Orders tab keeps the record.
 */
export function ProtectionDialog({ position, onClose, onRefusal }: Omit<DialogBase, 'onDone'>) {
  const { t } = positionsCopy.useCopy();
  const writer = useFuturesWriter();
  const read = useConditionalOrders(true);
  const refresh = useFuturesRefresh();
  const orders = read.status === 'ready' ? read.data : read.status === 'empty' ? [] : null;
  const unreadable = read.status === 'error' || read.status === 'refused';
  const legs = legsOf(orders ?? [], position.id);
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfitPart, setTakeProfitPart] = useState('');
  const [stopLossPart, setStopLossPart] = useState('');
  const [saved, setSaved] = useState<'set' | 'removed' | 'checked' | null>(null);
  const prefilled = useRef(false);
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const asset = settleOf(position.symbol) ?? '';
  const refusal = writer.outcome?.kind === 'refused' ? writer.outcome.refusal.code : undefined;
  useEffect(() => {
    if (refusal !== undefined) onRefusal?.(refusal);
  }, [refusal, onRefusal]);
  // The fields start from the armed legs, once: a save replaces both, so a field left as it is keeps its leg.
  useEffect(() => {
    if (orders === null || prefilled.current) return;
    prefilled.current = true;
    const tp = legs.take_profit;
    const sl = legs.stop_loss;
    if (tp?.status === 'armed') {
      setTakeProfit(tp.triggerPrice ?? '');
      if (tp.wholePosition === false) setTakeProfitPart(tp.quantity);
    }
    if (sl?.status === 'armed') {
      setStopLoss(sl.triggerPrice ?? '');
      if (sl.wholePosition === false) setStopLossPart(sl.quantity);
    }
  }, [orders, legs.take_profit, legs.stop_loss]);
  const edit = (set: (v: string) => void) => (value: string) => {
    setSaved(null);
    set(value);
  };
  const problems = { take_profit: priceProblem(takeProfit), stop_loss: priceProblem(stopLoss) };
  // A size counts only beside its leg's price: a leg with no price is not sent, so its size is never a problem.
  const partOf = (price: string, part: string) => (price.trim() === '' ? null : partProblem(part, position.contracts));
  const parts = { take_profit: partOf(takeProfit, takeProfitPart), stop_loss: partOf(stopLoss, stopLossPart) };
  const anyProblem = Object.values(problems).some((p) => p !== null) || Object.values(parts).some((p) => p !== null);
  const anyArmed = legs.take_profit?.status === 'armed' || legs.stop_loss?.status === 'armed';
  // A fired leg is closing the position through the book; a replace would not stop it and would arm a second one.
  const closingNow = legs.take_profit?.status === 'triggered' || legs.stop_loss?.status === 'triggered';
  const ready = orders !== null && !unreadable && !closingNow;
  const blocked = !ready || writer.note.state !== 'none' || position.id === null;

  const save = async (tp: string | null, sl: string | null, tpPart: string | null = null, slPart: string | null = null) => {
    if (blocked || position.id === null) return;
    // The same request re-sends the same request id (a replay); anything new, or a send after a finished one, is a new id.
    const key = `protect:${position.id}:${tp ?? ''}/${tpPart ?? ''}:${sl ?? ''}/${slPart ?? ''}`;
    nonce.current = pickNonce(nonce.current, key, newNonce);
    const result = await writer.run({
      op: 'protection',
      input: {
        symbol: position.symbol,
        positionId: position.id,
        takeProfit: tp,
        stopLoss: sl,
        takeProfitQuantity: tp === null ? null : tpPart,
        stopLossQuantity: sl === null ? null : slPart,
        clientRequestId: `tpsl:${nonce.current.nonce}`,
      },
    });
    if (result.kind === 'done') {
      nonce.current = null;
      setSaved(tp === null && sl === null ? 'removed' : 'set');
      if (tp === null) {
        setTakeProfit('');
        setTakeProfitPart('');
      }
      if (sl === null) {
        setStopLoss('');
        setStopLossPart('');
      }
      refresh();
    }
  };
  // An unresolved replace is sent again with the same request id, which the service replays.
  const check = async () => {
    if (writer.note.state !== 'pending') return;
    const result = await writer.check(writer.note.pending);
    if (result.kind === 'done') {
      nonce.current = null;
      setSaved('checked');
      refresh();
    }
  };
  const trimmed = (v: string) => (v.trim() === '' ? null : v.trim());

  const field = (leg: Leg, value: string, set: (v: string) => void, part: string, setPart: (v: string) => void) => {
    const side = sideOfMark(position, leg);
    const size = part.trim() === '' || parts[leg] ? null : part.trim();
    const estimate = value.trim() === '' || problems[leg] ? null : signedAmount(estimatedResult(position, value.trim(), size), 8);
    return (
      <div className="flex flex-col gap-2">
        <Field
          label={t(leg === 'take_profit' ? 'Protect field take profit' : 'Protect field stop loss', { quote: asset })}
          hint={side === null ? undefined : t(`Protect side ${side}`)}
          error={problems[leg] ? t('Protect problem invalid') : undefined}
        >
          <Input kind="decimal" value={value} onValueChange={edit(set)} precision={8} trailing={asset} disabled={orders === null} />
          {value.trim() !== '' && !problems[leg] ? (
            <span className="text-2xs text-fg-2">
              {estimate === null
                ? t('Protect estimate unknown')
                : size === null
                  ? t('Protect estimate', { result: estimate, asset })
                  : t('Protect estimate part', { result: estimate, asset, size: fmtAmount(size, { places: 8 }) })}
            </span>
          ) : null}
        </Field>
        <Field
          label={t(leg === 'take_profit' ? 'Protect part take profit' : 'Protect part stop loss')}
          hint={t('Protect part hint', { size: fmtAmount(position.contracts, { places: 8 }) })}
          error={parts[leg] ? t(`Protect part problem ${parts[leg]}`) : undefined}
        >
          <Input kind="decimal" value={part} onValueChange={edit(setPart)} precision={8} disabled={orders === null} />
        </Field>
      </div>
    );
  };

  return (
    <Frame
      title={t('Protect title')}
      onClose={onClose}
      description={
        position.markPrice === null
          ? t('Protect line no mark', {
              contract: position.symbol,
              side: sideWord(t, position.side),
              size: fmtAmount(position.contracts, { places: 8 }),
            })
          : t('Protect line', {
              contract: position.symbol,
              side: sideWord(t, position.side),
              size: fmtAmount(position.contracts, { places: 8 }),
              mark: fmtPrice(position.markPrice, null),
            })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Dialog close')}
          </Button>
          {anyArmed ? (
            <Button variant="secondary" loading={writer.busy} disabled={blocked} onClick={() => void save(null, null)}>
              {t('Protect remove')}
            </Button>
          ) : null}
          <Button
            loading={writer.busy}
            disabled={blocked || anyProblem || (!trimmed(takeProfit) && !trimmed(stopLoss))}
            onClick={() => void save(trimmed(takeProfit), trimmed(stopLoss), trimmed(takeProfitPart), trimmed(stopLossPart))}
          >
            {t('Protect save')}
          </Button>
        </>
      }
    >
      <section aria-label={t('Protect current')} className="flex flex-col gap-1 rounded-sm border border-line p-3">
        <h3 className="text-sm font-medium">{t('Protect current')}</h3>
        {orders === null && !unreadable ? <p className="text-fg-2">{t('Protect loading')}</p> : null}
        {unreadable ? <p className="text-warn">{t('Protect unreadable')}</p> : null}
        {orders !== null ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            <LegLine leg="take_profit" order={legs.take_profit} contracts={position.contracts} t={t} />
            <LegLine leg="stop_loss" order={legs.stop_loss} contracts={position.contracts} t={t} />
          </ul>
        ) : null}
        {closingNow ? <p className="text-warn">{t('Protect closing now')}</p> : null}
      </section>
      <p className="text-fg-2">{t('Protect how')}</p>
      {field('take_profit', takeProfit, setTakeProfit, takeProfitPart, setTakeProfitPart)}
      {field('stop_loss', stopLoss, setStopLoss, stopLossPart, setStopLossPart)}
      <p className="text-fg-2">{t('Protect replace note')}</p>
      {saved ? (
        <p role="status" className="text-fg-2">
          {t(`Protect done ${saved}`)}
        </p>
      ) : null}
      {writer.outcome?.kind === 'done' ? null : <WriteNotice writer={writer} onCheck={() => void check()} />}
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

const STOP_KINDS: readonly StopInput['kind'][] = ['stop_market', 'stop_limit', 'trailing_stop'];
const STOP_SOURCES: readonly StopInput['triggerSource'][] = ['mark', 'last', 'index'];

/**
 * A stop on a position (J-derivatives-03 step 5): a stop market, a stop limit or a trailing stop, judged on the mark or
 * the last trade. It is always the closing side and reduce-only; the service refuses one that would open or enlarge,
 * a field its kind does not take, and the index, which is not published here. The stops armed on the position are
 * listed under the form.
 */
export function StopDialog({ position, onClose, onRefusal }: Omit<DialogBase, 'onDone'>) {
  const { t } = positionsCopy.useCopy();
  const words = triggersCopy.useCopy().t;
  const writer = useFuturesWriter();
  const read = useConditionalOrders(true);
  const refresh = useFuturesRefresh();
  const [kind, setKind] = useState<StopInput['kind']>('stop_market');
  const [source, setSource] = useState<StopInput['triggerSource']>('mark');
  const [size, setSize] = useState(position.contracts);
  const [trigger, setTrigger] = useState('');
  const [limit, setLimit] = useState('');
  const [distance, setDistance] = useState('');
  const [armed, setArmed] = useState(false);
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const asset = settleOf(position.symbol) ?? '';
  const refusal = writer.outcome?.kind === 'refused' ? writer.outcome.refusal.code : undefined;
  useEffect(() => {
    if (refusal !== undefined) onRefusal?.(refusal);
  }, [refusal, onRefusal]);
  const edit = (set: (v: string) => void) => (value: string) => {
    setArmed(false);
    set(value);
  };
  const takes = { trigger: kind !== 'trailing_stop', limit: kind === 'stop_limit', distance: kind === 'trailing_stop' };
  const sizeProblem = closeSizeProblem(size, position.contracts);
  const required = (value: string) => (value.trim() === '' ? 'empty' : priceProblem(value));
  const problems = {
    trigger: takes.trigger ? required(trigger) : null,
    limit: takes.limit ? required(limit) : null,
    distance: takes.distance ? required(distance) : null,
  };
  const anyProblem = sizeProblem !== null || Object.values(problems).some((p) => p !== null);
  const blocked = writer.note.state !== 'none' || position.id === null;
  const stops =
    read.status === 'ready'
      ? read.data.filter((o) => o.positionId === position.id && o.attachment === null && (o.status === 'armed' || o.status === 'triggered'))
      : [];

  const place = async () => {
    if (blocked || anyProblem) return;
    const input: Omit<StopInput, 'clientOrderId'> = {
      symbol: position.symbol,
      kind,
      side: position.side === 'long' ? 'sell' : 'buy',
      quantity: size.trim(),
      ...(takes.trigger ? { triggerPrice: trigger.trim() } : {}),
      ...(takes.limit ? { limitPrice: limit.trim() } : {}),
      ...(takes.distance ? { trailingDistance: distance.trim() } : {}),
      triggerSource: source,
    };
    // The same stop re-sends the same client id (a replay); anything changed, or a send after an armed one, is new.
    nonce.current = pickNonce(nonce.current, `stop:${position.id}:${JSON.stringify(input)}`, newNonce);
    const result = await writer.run({ op: 'place-trigger', input: { ...input, clientOrderId: `stop:${nonce.current.nonce}` } });
    if (result.kind === 'done') {
      nonce.current = null;
      setArmed(true);
      refresh();
    }
  };
  const check = async () => {
    if (writer.note.state !== 'pending') return;
    const result = await writer.check(writer.note.pending);
    if (result.kind === 'done') {
      nonce.current = null;
      setArmed(true);
      refresh();
    }
  };
  const price = (label: string, hint: string, value: string, set: (v: string) => void, problem: string | null) => (
    <Field label={label} hint={hint} error={problem === 'invalid' ? t('Stop problem invalid') : undefined}>
      <Input kind="decimal" value={value} onValueChange={edit(set)} precision={8} trailing={asset} />
    </Field>
  );

  return (
    <Frame
      title={t('Stop title')}
      onClose={onClose}
      description={
        position.markPrice === null
          ? t('Stop line', {
              contract: position.symbol,
              side: sideWord(t, position.side),
              size: fmtAmount(position.contracts, { places: 8 }),
            })
          : t('Stop line mark', {
              contract: position.symbol,
              side: sideWord(t, position.side),
              size: fmtAmount(position.contracts, { places: 8 }),
              mark: fmtPrice(position.markPrice, null),
            })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Dialog close')}
          </Button>
          <Button loading={writer.busy} disabled={blocked || anyProblem} onClick={() => void place()}>
            {t('Stop place')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <span className="text-fg-2">{t('Stop kind')}</span>
        <SegmentedControl
          aria-label={t('Stop kind')}
          size={32}
          value={kind}
          onValueChange={(v) => {
            setArmed(false);
            setKind(v as StopInput['kind']);
          }}
          items={STOP_KINDS.map((k) => ({ value: k, label: t(`Stop kind ${k}`) }))}
        />
        <p className="text-2xs text-fg-2">{t(`Stop kind how ${kind}`)}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-fg-2">{t('Stop source')}</span>
        <SegmentedControl
          aria-label={t('Stop source')}
          size={32}
          value={source}
          onValueChange={(v) => {
            setArmed(false);
            setSource(v as StopInput['triggerSource']);
          }}
          items={STOP_SOURCES.map((k) => ({ value: k, label: t(`Stop source ${k}`) }))}
        />
        <p className="text-2xs text-fg-2">{t(`Stop source how ${source}`)}</p>
      </div>
      <Field
        label={t('Stop size')}
        hint={t('Stop size hint', { size: fmtAmount(position.contracts, { places: 8 }) })}
        error={sizeProblem && size.trim() !== '' ? t(`Close problem ${sizeProblem}`) : undefined}
      >
        <Input kind="decimal" value={size} onValueChange={edit(setSize)} precision={8} />
      </Field>
      {takes.trigger
        ? price(
            t('Stop trigger', { quote: asset }),
            t(position.side === 'long' ? 'Stop trigger hint below' : 'Stop trigger hint above'),
            trigger,
            setTrigger,
            problems.trigger,
          )
        : null}
      {takes.limit ? price(t('Stop limit', { quote: asset }), t('Stop limit hint'), limit, setLimit, problems.limit) : null}
      {takes.distance
        ? price(t('Stop distance', { quote: asset }), t('Stop distance hint'), distance, setDistance, problems.distance)
        : null}
      {armed ? (
        <p role="status" className="text-fg-2">
          {t('Stop done')}
        </p>
      ) : null}
      {writer.outcome?.kind === 'done' ? null : <WriteNotice writer={writer} onCheck={() => void check()} />}
      <section aria-label={t('Stop armed')} className="flex flex-col gap-1 rounded-sm border border-line p-3">
        <h3 className="text-sm font-medium">{t('Stop armed')}</h3>
        {read.status === 'loading' ? <p className="text-fg-2">{t('Protect loading')}</p> : null}
        {read.status === 'error' || read.status === 'refused' ? <p className="text-warn">{t('Stop unreadable')}</p> : null}
        {read.status === 'ready' || read.status === 'empty' ? (
          stops.length === 0 ? (
            <p className="text-fg-2">{t('Stop armed none')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {stops.map((o) => {
                const line = triggerLine(o, words);
                return (
                  <li key={o.id} data-stop={o.kind} data-status={o.status} className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {t('Stop armed line', {
                        kind: words(`Kind ${o.kind}`),
                        size: fmtAmount(o.quantity, { places: 8 }),
                        status: words(`Status ${o.status}`),
                      })}
                    </span>
                    {line ? <span className="text-fg-2">{line}</span> : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </section>
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
  only = ['add', 'reduce', 'leverage', 'protect', 'stop', 'close'],
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
    protect: t('Action protect'),
    stop: t('Action stop'),
    close: closing ? t('Action retry close') : t('Action close'),
  };
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const onRefusal = (code: string | null) => code === REFUSAL_LIQUIDATING && setLiquidating(true);
  const common = { position, onClose: () => setOpen(null), onDone: done, onRefusal };
  return (
    // The menu and the dialogs render in portals, and React still bubbles their clicks to the table row, which would
    // open the position's detail on top of them. Nothing in here is a click on the row.
    <div className="flex flex-col items-start gap-1" onClick={(event) => event.stopPropagation()}>
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
      {open === 'protect' ? <ProtectionDialog {...common} /> : null}
      {open === 'stop' ? <StopDialog {...common} /> : null}
      {open === 'close' ? <CloseDialog {...common} /> : null}
    </div>
  );
}
