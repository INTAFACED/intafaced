import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useMounted } from '../../../shared/outside';
import { useResource } from '../../../shared/resource';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  KeyValue,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SegmentedControl,
} from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import { useSession } from '../../../features/session/session';
import type { ConditionalOrder, PositionPreview, Reverse, RiskStop, StopInput } from './api';
import { useConditionalOrders, useFuturesApi, useFuturesRefresh } from './data';
import { futuresRefusal } from './refusals';
import { positionsCopy } from './positions-copy';
import { newNonce, usePendingNote, useFuturesWriter, type Writer } from './hooks';
import { adjustmentId, leveragePresets, stateOf } from './model';
import {
  amountProblem,
  closeShare,
  closeSizeProblem,
  gateActions,
  pickNonce,
  riskStopProblem,
  settleOf,
  signedAmount,
  type ActionKey,
} from './positions-logic';
import { coverage, estimatedResult, legsOf, partProblem, priceProblem, sideOfMark, type Leg } from './protection-logic';
import { TriggerFacts, triggerLine } from './TriggerFacts';
import { triggersCopy } from './triggers-copy';
import type { Intent } from './write';
import { WriteNotice, sideWord } from './close-all/CloseAllDialog';

export { CloseAllDialog, WriteNotice } from './close-all/CloseAllDialog';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

const REFUSAL_LIQUIDATING = 'trade.liquidation_in_progress';

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

/**
 * The futures writer, reporting a refusal's service code to `onRefusal` as the write or look-up that met it returns, so a
 * row can disable what a live liquidation step blocks. Only while the dialog is open, as its outcome is kept only then.
 */
function useReportedWriter(onRefusal?: (code: string | null) => void): Writer {
  const writer = useFuturesWriter();
  const mounted = useMounted();
  const report = (result: Awaited<ReturnType<Writer['run']>>) => {
    if (result.kind === 'refused' && mounted.current) onRefusal?.(result.refusal.code);
    return result;
  };
  return {
    ...writer,
    run: async (intent) => report(await writer.run(intent)),
    check: async (pending, options) => report(await writer.check(pending, options)),
  };
}

/** Send one intent, or look up the unresolved one. A finished write for THIS position closes the dialog via onDone. */
function useSend(position: Position, onDone: (p: Position) => void, onRefusal?: (code: string | null) => void) {
  const writer = useReportedWriter(onRefusal);
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
      <p className="lt-muted">{t('Margin recompute')}</p>
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
      <p className="lt-muted">{t('Margin recompute')}</p>
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
      {closing ? <p className="lt-muted">{t('Close retry word')}</p> : null}
      <WriteNotice writer={writer} onCheck={() => void check()} />
    </Frame>
  );
}

/** One leg as it stands: its status in words, its trigger and the price it is judged on, and what a fired one did. */
function LegLine({ leg, order, position, t }: { leg: Leg; order: ConditionalOrder | null; position: Position; t: T }) {
  const contracts = position.contracts;
  const words = triggersCopy.useCopy().t;
  const name = leg === 'take_profit' ? t('Protect take profit') : t('Protect stop loss');
  if (order === null) return <li data-leg={leg}>{t('Protect leg', { leg: name, status: t('Protect none') })}</li>;
  const trigger = triggerLine(order, words);
  const covers = coverage(order, contracts);
  return (
    <li data-leg={leg} data-status={order.status} className="flex flex-col gap-0.5">
      <span className="font-medium">{t('Protect leg', { leg: name, status: words(`Status ${order.status}`) })}</span>
      {trigger ? <span className="lt-muted">{trigger}</span> : null}
      {covers === null ? null : covers.whole ? (
        <span className="lt-muted">{t('Protect covers whole')}</span>
      ) : (
        <span className="lt-muted">
          {t('Protect covers part', {
            part: fmtAmount(covers.part, { places: 8 }),
            size: fmtAmount(contracts, { places: 8 }),
            rest: fmtAmount(covers.rest, { places: 8 }),
          })}
        </span>
      )}
      <TriggerFacts order={order} positions={[position]} />
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
  const writer = useReportedWriter(onRefusal);
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
  const [prefilled, setPrefilled] = useState(false);
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const asset = settleOf(position.symbol) ?? '';
  // The fields start from the armed legs, once, during the render that first has the read: a save replaces both, so a
  // field left as it is keeps its leg.
  if (orders !== null && !prefilled) {
    setPrefilled(true);
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
  }
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
        {orders === null && !unreadable ? <p className="lt-muted">{t('Protect loading')}</p> : null}
        {unreadable ? <p className="text-warn">{t('Protect unreadable')}</p> : null}
        {orders !== null ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            <LegLine leg="take_profit" order={legs.take_profit} position={position} t={t} />
            <LegLine leg="stop_loss" order={legs.stop_loss} position={position} t={t} />
          </ul>
        ) : null}
        {closingNow ? <p className="text-warn">{t('Protect closing now')}</p> : null}
      </section>
      <p className="lt-muted">{t('Protect how')}</p>
      {field('take_profit', takeProfit, setTakeProfit, takeProfitPart, setTakeProfitPart)}
      {field('stop_loss', stopLoss, setStopLoss, stopLossPart, setStopLossPart)}
      <p className="lt-muted">{t('Protect replace note')}</p>
      {saved ? (
        <p role="status" className="lt-muted">
          {t(`Protect done ${saved}`)}
        </p>
      ) : null}
      {writer.outcome?.kind === 'done' ? null : <WriteNotice writer={writer} onCheck={() => void check()} />}
    </Frame>
  );
}

const STOP_KINDS: readonly StopInput['kind'][] = ['stop_market', 'stop_limit', 'trailing_stop'];
const STOP_SOURCES: readonly StopInput['triggerSource'][] = ['mark', 'last', 'index'];

/** A reverse's outcome as it stands, or a working one still settling (J-derivatives-03 #9). */
function reverseWords(r: Reverse, t: T): string {
  const words = {
    from: sideWord(t, r.from),
    to: sideWord(t, r.to),
    size: fmtAmount(r.size, { places: 8 }),
    leverage: fmtAmount(r.leverage),
  };
  const reason = () => {
    const refusal = futuresRefusal({ code: r.refusalCode ?? undefined });
    return `${refusal.title}. ${refusal.body}`;
  };
  switch (r.status) {
    case 'done':
      return t('Reverse done', words);
    case 'opened_part':
      return t('Reverse opened part', { ...words, opened: fmtAmount(r.openedQuantity ?? '0', { places: 8 }) });
    case 'closed_only':
      return t('Reverse closed only', { ...words, reason: reason() });
    case 'close_incomplete':
      return t('Reverse close incomplete', { ...words, closed: fmtAmount(r.closedQuantity ?? '0', { places: 8 }) });
    case 'refused':
      return t('Reverse refused', { reason: reason() });
    default:
      return t('Reverse working');
  }
}

/**
 * One-tap reverse (J-derivatives-03 step 9, D-account-03): one reviewed request closes the position through the book
 * and opens the other side at the same size and leverage. The review prices the open from the service's own preview,
 * and a margin tier it moves into must be accepted, as in the ticket. A working reverse is checked by sending the same
 * request id again, which carries it on and never places a leg twice.
 */
export function ReverseDialog({ position, onClose, onRefusal }: Omit<DialogBase, 'onDone'>) {
  const { t } = positionsCopy.useCopy();
  const api = useFuturesApi();
  const writer = useReportedWriter(onRefusal);
  const refresh = useFuturesRefresh();
  const to = position.side === 'long' ? 'short' : 'long';
  const [review, setReview] = useState<{ status: 'loading' } | { status: 'ready'; data: PositionPreview } | { status: 'error' }>({
    status: 'loading',
  });
  const [tierAccepted, setTierAccepted] = useState(false);
  const [moved, setMoved] = useState(false);
  const [result, setResult] = useState<Reverse | null>(null);
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const priceOpen = useCallback(
    (signal?: AbortSignal) =>
      position.leverage === null
        ? Promise.resolve(null)
        : api
            .preview({ symbol: position.symbol, side: to, size: position.contracts, leverage: position.leverage, type: 'market' }, signal)
            .then((answer) => (answer.ok ? answer.data : null)),
    [api, position.symbol, position.contracts, position.leverage, to],
  );
  // The open is priced for this size and leverage; a new size or leverage prices it again, and the last figures stay on
  // screen until the new answer arrives. Reverse itself re-prices just before sending (setReview in run).
  const { userId } = useSession();
  const priced = useResource<PositionPreview | null>(
    (signal) => priceOpen(signal).then((data) => ({ ok: true as const, data })),
    `futures:reverse:price:${userId ?? ''}:${position.symbol}:${to}:${position.contracts}:${position.leverage ?? ''}`,
  );
  const [pricedSeen, setPricedSeen] = useState<typeof priced.resource | null>(null);
  if (position.leverage !== null && priced.resource.status === 'ready' && priced.resource !== pricedSeen) {
    setPricedSeen(priced.resource);
    const data = priced.resource.data;
    setReview(data ? { status: 'ready', data } : { status: 'error' });
  }

  const preview = review.status === 'ready' ? review.data : null;
  const tier = preview?.riskTier ?? null;
  const tierNeeded = tier?.confirmRequired === true;
  const working = result !== null && (result.status === 'closing' || result.status === 'opening');
  // A refused reverse changed nothing, so it may be tried again as a new request.
  const finished = result !== null && !working && result.status !== 'refused';
  const words = {
    contract: position.symbol,
    from: sideWord(t, position.side),
    to: sideWord(t, to),
    size: fmtAmount(position.contracts, { places: 8 }),
    leverage: position.leverage === null ? '—' : fmtAmount(position.leverage),
  };
  const off =
    position.id === null ||
    position.leverage === null ||
    preview === null ||
    (tierNeeded && !tierAccepted) ||
    writer.note.state !== 'none' ||
    finished;

  const run = async () => {
    if (position.id === null) return;
    let confirmTier = tierNeeded && tier ? tier.projected : undefined;
    if (!working) {
      // The mark moves: the review is priced again just before a new reverse is sent, and a changed margin tier is
      // shown for acceptance instead of being sent unaccepted.
      setMoved(false);
      const fresh = await priceOpen();
      if (fresh === null) {
        setReview({ status: 'error' });
        return;
      }
      setReview({ status: 'ready', data: fresh });
      const freshTier = fresh.riskTier ?? null;
      if (freshTier?.confirmRequired === true && (!tierAccepted || freshTier.projected !== tier?.projected)) {
        setTierAccepted(false);
        setMoved(true);
        return;
      }
      confirmTier = freshTier?.confirmRequired === true ? freshTier.projected : undefined;
    }
    // The same position re-sends the same request id, so a check carries on the reverse already started.
    nonce.current = pickNonce(nonce.current, `reverse:${position.id}`, newNonce);
    const outcome = await writer.run({
      op: 'reverse',
      input: {
        positionId: position.id,
        symbol: position.symbol,
        clientRequestId: `reverse:${nonce.current.nonce}`,
        ...(confirmTier !== undefined ? { confirmTier } : {}),
      },
    });
    if (outcome.kind === 'done' && outcome.reverse) {
      setResult(outcome.reverse);
      refresh();
      // A reverse that refused changed nothing: another try is a new request.
      if (outcome.reverse.status === 'refused') nonce.current = null;
    }
  };
  const check = async () => {
    if (writer.note.state !== 'pending') return;
    const outcome = await writer.check(writer.note.pending);
    if (outcome.kind === 'done' && outcome.reverse) {
      setResult(outcome.reverse);
      refresh();
    }
  };
  const money = (v: string | null | undefined) => (v == null ? null : fmtAmount(v));
  const price = (v: string | null | undefined) => (v == null ? null : fmtPrice(v, null));

  return (
    <Frame
      title={t('Reverse title')}
      onClose={onClose}
      description={t('Reverse summary', words)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {finished ? t('Reverse finished') : t('Cancel')}
          </Button>
          {working ? (
            <Button variant="secondary" loading={writer.busy} disabled={writer.note.state !== 'none'} onClick={() => void run()}>
              {t('Reverse check')}
            </Button>
          ) : (
            <Button variant={to === 'long' ? 'buy' : 'sell'} loading={writer.busy} disabled={off} onClick={() => void run()}>
              {t('Reverse button', { to: sideWord(t, to) })}
            </Button>
          )}
        </>
      }
    >
      {position.leverage === null ? <p className="text-warn">{t('Reverse no leverage')}</p> : null}
      <section aria-label={t('Reverse review', { to: sideWord(t, to) })} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('Reverse review', { to: sideWord(t, to) })}</h3>
        {review.status === 'loading' && position.leverage !== null ? (
          <p className="lt-muted">{t('Reverse review loading', { to: sideWord(t, to) })}</p>
        ) : null}
        {review.status === 'error' ? <p className="text-warn">{t('Reverse review error', { to: sideWord(t, to) })}</p> : null}
        {preview ? (
          <KeyValue
            density="dense"
            unknownLabel="—"
            items={[
              { label: t('Reverse mark'), value: price(preview.markPrice) },
              { label: t('Reverse margin'), value: money(preview.initialMargin) },
              { label: t('Reverse fee'), value: money(preview.estimatedFee) },
              { label: t('Reverse liquidation'), value: price(preview.liquidationPrice) },
              ...(tier ? [{ label: t('Reverse tier'), value: t('Reverse tier value', { tier: String(tier.projected) }) }] : []),
            ]}
          />
        ) : null}
        {moved ? <p className="text-warn">{t('Reverse review moved')}</p> : null}
        {tierNeeded && tier ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={tierAccepted} disabled={finished} onCheckedChange={(v) => setTierAccepted(v === true)} />
            <span>{t('Reverse tier accept', { tier: String(tier.projected), to: sideWord(t, to) })}</span>
          </label>
        ) : null}
      </section>
      {result ? (
        <div role="status" data-reverse={result.status} className="flex flex-col gap-1 rounded-sm border border-line p-3">
          <p className={result.status === 'done' ? 'font-medium' : 'text-warn'}>{reverseWords(result, t)}</p>
          {result.closeOrderId || result.openOrderId ? (
            <p className="text-2xs text-fg-3">
              {t('Reverse legs', { close: result.closeOrderId ?? '—', open: result.openOrderId ?? '—' })}
            </p>
          ) : null}
        </div>
      ) : null}
      <WriteNotice writer={writer} onCheck={() => void check()} />
    </Frame>
  );
}

/**
 * A stop on a position (J-derivatives-03 step 5): a stop market, a stop limit or a trailing stop, judged on the mark or
 * the last trade. It is always the closing side and reduce-only; the service refuses one that would open or enlarge,
 * a field its kind does not take, and the index, which is not published here. The stops armed on the position are
 * listed under the form.
 */
export function StopDialog({ position, onClose, onRefusal }: Omit<DialogBase, 'onDone'>) {
  const { t } = positionsCopy.useCopy();
  const words = triggersCopy.useCopy().t;
  const writer = useReportedWriter(onRefusal);
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
        <span className="lt-muted">{t('Stop kind')}</span>
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
        <span className="lt-muted">{t('Stop source')}</span>
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
        <p role="status" className="lt-muted">
          {t('Stop done')}
        </p>
      ) : null}
      {writer.outcome?.kind === 'done' ? null : <WriteNotice writer={writer} onCheck={() => void check()} />}
      <section aria-label={t('Stop armed')} className="flex flex-col gap-1 rounded-sm border border-line p-3">
        <h3 className="text-sm font-medium">{t('Stop armed')}</h3>
        {read.status === 'loading' ? <p className="lt-muted">{t('Protect loading')}</p> : null}
        {read.status === 'error' || read.status === 'refused' ? <p className="text-warn">{t('Stop unreadable')}</p> : null}
        {read.status === 'ready' || read.status === 'empty' ? (
          stops.length === 0 ? (
            <p className="lt-muted">{t('Stop armed none')}</p>
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
                    {line ? <span className="lt-muted">{line}</span> : null}
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

/** What a position's pre-liquidation stop is, in words: its level and close price, that it fired, or none. */
export function riskStopLines(stop: RiskStop, t: T): string[] {
  if (stop.status === 'none') return [t('Risk stop none')];
  if (stop.status === 'ended') return [t('Risk stop ended line')];
  if (stop.status === 'fired') {
    const status = stop.closeOrder?.status ?? '—';
    const ratio = stop.firedRatio === null ? '—' : fmtAmount(stop.firedRatio, { places: 4 });
    return [t(status === 'failed' || status === 'cancelled' ? 'Risk stop fired failed' : 'Risk stop fired line', { ratio, status })];
  }
  return [
    t('Risk stop armed line', { level: stop.level ?? '—' }),
    stop.triggerPrice === null
      ? t('Risk stop price unknown', { reason: stop.triggerPriceReason ?? '—' })
      : t('Risk stop price line', { price: fmtAmount(stop.triggerPrice, { places: 18 }) }),
  ];
}

/**
 * A pre-liquidation stop: the trader picks a margin-ratio level, and the service closes the whole position with one
 * market order when the ratio reaches it. The dialog shows the ratio now and the stop as the service holds it.
 */
export function RiskStopDialog({ position, onClose, onDone, onRefusal }: DialogBase) {
  const { t } = positionsCopy.useCopy();
  const api = useFuturesApi();
  const [level, setLevel] = useState('');
  const nonce = useRef<{ key: string; nonce: string } | null>(null);
  const { writer, send, check } = useSend(position, onDone, onRefusal);
  const id = position.id;
  // A position with no id has no stop to read: it stays loading, as it always has.
  const { resource } = useResource<RiskStop>(
    (signal) => (id === null ? new Promise<never>(() => {}) : api.riskStop(id, signal)),
    `risk-stop:${id ?? ''}`,
  );
  const read: { status: 'loading' } | { status: 'ready'; stop: RiskStop } | { status: 'error' } =
    resource.status === 'ready'
      ? { status: 'ready', stop: resource.data }
      : resource.status === 'failed'
        ? { status: 'error' }
        : { status: 'loading' };
  const stop = read.status === 'ready' ? read.stop : null;
  const problem = riskStopProblem(level, stop?.marginRatio ?? null);
  const go = (value: string | null) => {
    if (id === null) return;
    nonce.current = pickNonce(nonce.current, `risk-stop:${id}:${value ?? 'clear'}`, newNonce);
    void send({
      op: 'risk-stop',
      input: { symbol: position.symbol, positionId: id, level: value, clientRequestId: `risk-stop:${nonce.current.nonce}`.slice(0, 64) },
    });
  };
  const idle = writer.note.state === 'none' && !writer.busy;
  return (
    <Frame
      title={t('Risk stop title')}
      onClose={onClose}
      description={t('Risk stop description', { contract: position.symbol, side: sideWord(t, position.side) })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          {stop?.status === 'armed' ? (
            <Button variant="secondary" disabled={!idle} onClick={() => go(null)}>
              {t('Risk stop clear')}
            </Button>
          ) : null}
          <Button
            loading={writer.busy}
            disabled={problem !== null || !idle || id === null || stop === null}
            onClick={() => go(level.trim())}
          >
            {t('Risk stop save')}
          </Button>
        </>
      }
    >
      {read.status === 'loading' ? <p className="lt-muted">{t('Risk stop loading')}</p> : null}
      {read.status === 'error' ? <p className="text-warn">{t('Risk stop unknown')}</p> : null}
      {stop ? (
        <KeyValue
          density="dense"
          items={[
            {
              label: t('Risk stop now'),
              value:
                stop.marginRatio === null
                  ? t('Risk stop ratio unknown', { reason: stop.marginRatioReason ?? '—' })
                  : `${fmtAmount(stop.marginRatio, { places: 4 })}%`,
            },
            {
              label: t('Risk stop liquidation'),
              value: stop.liquidationPrice === null ? '—' : fmtPrice(stop.liquidationPrice, null),
            },
          ]}
        />
      ) : null}
      <Field
        label={t('Risk stop level')}
        error={level !== '' && problem && problem !== 'empty' ? t(`Risk stop problem ${problem}`) : undefined}
        hint={t('Risk stop level hint')}
      >
        <Input kind="decimal" value={level} onValueChange={setLevel} precision={16} trailing="%" />
      </Field>
      <WriteNotice writer={writer} onCheck={() => void check()} />
      <section aria-label={t('Risk stop current')} className="flex flex-col gap-1 rounded-sm border border-line p-3">
        <h3 className="text-sm font-medium">{t('Risk stop current')}</h3>
        {stop
          ? riskStopLines(stop, t).map((line) => (
              <p key={line} className="m-0 text-fg-2">
                {line}
              </p>
            ))
          : null}
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
  only = ['add', 'reduce', 'leverage', 'protect', 'stop', 'riskStop', 'reverse', 'close'],
  compact = false,
  onReverse,
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
  /**
   * Opens the reverse dialog above the table. A reverse closes this row's position, and the next read drops the row,
   * so its outcome is shown by a dialog the row does not own. Without it the dialog stays in the row.
   */
  onReverse?(position: Position): void;
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
    riskStop: t('Action riskStop'),
    reverse: t('Action reverse'),
    close: closing ? t('Action retry close') : t('Action close'),
  };
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const onRefusal = (code: string | null) => code === REFUSAL_LIQUIDATING && setLiquidating(true);
  const common = { position, onClose: () => setOpen(null), onDone: done, onRefusal };
  const choose = (key: ActionKey) => (key === 'reverse' && onReverse ? onReverse(position) : setOpen(key));
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
                  <MenuItem key={key} disabled={gate[key] !== null} onClick={() => choose(key)}>
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
            onClick={() => choose(key)}
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
      {open === 'riskStop' ? <RiskStopDialog {...common} /> : null}
      {open === 'reverse' ? <ReverseDialog {...common} /> : null}
      {open === 'close' ? <CloseDialog {...common} /> : null}
    </div>
  );
}
