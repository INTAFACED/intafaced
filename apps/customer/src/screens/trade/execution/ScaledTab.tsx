/** Scaled orders: form and cost, the batch answer per order, and recovery by reading the book back by id prefix. */
import { useCallback, useState } from 'react';
import type { Order } from '../../../features/trade/trade-api';
import { WriteNotice } from '../rooms/RoomNotices';
import { useRoomWriter } from '../rooms/write';
import { useBalances } from '../desk/data';
import { execCopy } from './copy';
import { useTradeApi, type ExecMarket } from './data';
import { matchesPrefix, scaledPrefix } from './model';
import { Why } from './parts';
import { ScaledForm, type ScaledRun } from './ScaledForm';
import { ScaledResult } from './ScaledResult';

export function ScaledTab({ markets }: { markets: readonly ExecMarket[] }) {
  const { t } = execCopy.useCopy();
  const trade = useTradeApi();
  const writer = useRoomWriter();
  const balances = useBalances();
  const [run, setRun] = useState<ScaledRun | null>(null);
  const [found, setFound] = useState<Order[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const freeOf = useCallback((asset: string) => (balances.status === 'ready' ? (balances.data[asset]?.free ?? null) : null), [balances]);

  /** Reads open and closed orders of the market and keeps those whose client id starts with this ladder's prefix. */
  async function read(nonce: string, symbol: string): Promise<boolean> {
    setChecking(true);
    const [open, closed] = await Promise.all([trade.orders('open', symbol, 500), trade.orders('closed', symbol, 500)]);
    setChecking(false);
    if (!open.ok || !closed.ok) {
      setNote(t('Could not check yet, try again'));
      return false;
    }
    const prefix = scaledPrefix(nonce);
    const mine = [...open.data, ...closed.data].filter((o) => matchesPrefix(o.clientOrderId, prefix));
    setFound(mine);
    setNote(null);
    return true;
  }

  /** The note holds `scl-<nonce>` and the market, so a check works even after a reload. */
  async function checkPending(id: string) {
    const symbol = writer.note.state === 'pending' ? writer.note.pending.symbol : (run?.symbol ?? '');
    const nonce = id.replace(/^scl-/, '');
    if (!symbol) return;
    if (await read(nonce, symbol)) writer.resolve(id);
  }

  return (
    <div className="flex flex-col gap-4">
      {balances.status === 'refused' || balances.status === 'error' ? <Why>{t('Balance unread')}</Why> : null}
      <ScaledForm
        markets={markets}
        freeOf={freeOf}
        writer={writer}
        unconfirmed={found === null && (run?.results?.some((r) => r.status === 'unknown') ?? false)}
        onRun={(next) => {
          setRun(next);
          setFound(null);
          if (next?.results) void read(next.nonce, next.symbol);
        }}
      />
      <WriteNotice writer={writer} onCheck={(id) => void checkPending(id)} done={t('Orders sent')} />
      {note ? (
        <p role="status" className="m-0 text-sm text-warn">
          {note}
        </p>
      ) : null}
      <ScaledResult
        run={run}
        found={found}
        market={markets.find((m) => m.symbol === run?.symbol) ?? null}
        writer={writer}
        checking={checking}
        onCheck={() => (run ? void read(run.nonce, run.symbol) : undefined)}
      />
    </div>
  );
}
