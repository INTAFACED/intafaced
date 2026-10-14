import { useEffect, useRef, useState } from 'react';
import { useDataEnv } from '../../../../data/hooks';
import { useSession } from '../../../../features/session/session';
import type { Order } from '../../../../features/trade/trade-api';
import type { DeskMarket } from '../market';
import { ticketCopy } from './copy';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from './deps';
import { cancelAllOrders, countBySymbol, type CancelAllResult } from './cancel-all';
import './ticket.css';

/** The most open orders the desk lists. At this many there may be more; the service cancels every one of them. */
export const OPEN_LIST_CAP = 100;

type Scope = { kind: 'market'; symbol: string } | { kind: 'all' };

/**
 * "Cancel all" above the Open orders table: this market or every market, always behind a confirmation that says how
 * many orders and where. Money held for the orders is released by the service as each one is cancelled.
 */
export function CancelAll({ rows, market, onDone }: { rows: readonly Order[]; market: DeskMarket; onDone: () => void }) {
  const { t } = ticketCopy.useCopy();
  const { api } = useSession();
  const env = useDataEnv();
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<CancelAllResult | null>(null);

  // The result is news for a moment, not a permanent fact.
  useEffect(() => {
    if (result === null) return;
    const timer = setTimeout(() => setResult(null), 15_000);
    return () => clearTimeout(timer);
  }, [result]);

  const inMarket = rows.filter((order) => order.symbol === market.symbol);
  const scoped = scope === null ? [] : scope.kind === 'market' ? inMarket : rows;
  const capped = scope?.kind === 'all' && rows.length >= OPEN_LIST_CAP;

  async function confirm() {
    if (busyRef.current || scope === null) return;
    busyRef.current = true;
    setBusy(true);
    env.poller.recordExternalRequest();
    // One DELETE per click. Nothing here retries it: on a doubtful answer the person checks Open orders.
    const outcome = await cancelAllOrders(api, scope.kind === 'market' ? scope.symbol : undefined);
    busyRef.current = false;
    setBusy(false);
    setScope(null);
    setResult(outcome);
    onDone();
  }

  if (rows.length === 0 && result === null) return null;
  const pair = market.symbol;
  const title =
    scoped.length === 1 ? t('Cancel all title one') : t('Cancel all title', { count: capped ? `${scoped.length}+` : scoped.length });
  return (
    <div className="tk-cancelall">
      {rows.length > 0 ? (
        <Menu>
          <MenuTrigger render={<Button variant="secondary" size={28} disabled={rows.length === 0} aria-label={t('Cancel all menu')} />}>
            {t('Cancel all')}
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem disabled={inMarket.length === 0} onClick={() => setScope({ kind: 'market', symbol: market.symbol })}>
              {t('Cancel all this market', { pair })} · {t('Cancel all count', { count: inMarket.length })}
            </MenuItem>
            <MenuItem disabled={rows.length === 0} onClick={() => setScope({ kind: 'all' })}>
              {t('Cancel all every market')} · {t('Cancel all count', { count: capped ? `${rows.length}+` : rows.length })}
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
      {result ? (
        <span
          className={`tk-cancelall-note${result.kind === 'done' ? '' : ' tk-cancelall-note--bad'}`}
          role="status"
          data-result={result.kind}
        >
          {result.kind === 'done'
            ? result.cancelled === 0
              ? t('Cancel all done none')
              : result.cancelled === 1
                ? t('Cancel all done one')
                : t('Cancel all done', { count: result.cancelled })
            : result.kind === 'unsure'
              ? t('Cancel all unsure')
              : t('Cancel all failed')}
        </span>
      ) : null}
      <AlertDialog
        open={scope !== null}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) setScope(null);
        }}
      >
        {scope ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>
                {scope.kind === 'market' ? t('Cancel all body market', { pair: scope.symbol }) : t('Cancel all body every')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {scope.kind === 'all' ? (
              <ul className="tk-cancelall-list">
                {countBySymbol(rows).map((row) => (
                  <li key={row.symbol}>{t('Orders in market', { pair: row.symbol, count: row.count })}</li>
                ))}
              </ul>
            ) : null}
            {capped ? <p className="dk-note dk-note--warn">{t('Cancel all more', { count: OPEN_LIST_CAP })}</p> : null}
            <p className="dk-note">{t('Cancel all filled note')}</p>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="secondary" size={40} disabled={busy} />}>{t('Cancel all keep')}</AlertDialogClose>
              <Button variant="sell" shape="pill" size={40} loading={busy} onClick={() => void confirm()}>
                {busy ? t('Cancel all busy') : t('Cancel all confirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
