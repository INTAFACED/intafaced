import { copy, t as copyText, Text } from './copy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { MutationDialog, type ActionSpec, type BankActionContext } from './components';
import { BankRoutes } from './rooms';
import { RepeatBuy } from './repeat-buy';
import { Withdrawal } from './Withdrawal';
import { WithdrawalAllowlist } from './WithdrawalAllowlist';
import { WithdrawalApprovals } from './WithdrawalApprovals';
import { WithdrawalAddresses } from './WithdrawalAddresses';
import { ApproveAddress } from './ApproveAddress';
import { Deposit } from './Deposit';
import { SupportedAssets } from './SupportedAssets';
import { pendingKey, pendingOutcomes, restorePendingOutcomes } from './pending-outcomes';
import './money.css';

export function MoneyRoutes({ path }: { path: string }) {
  const { requestedLocale } = copy.useCopy();
  return (
    <div lang={requestedLocale} style={{ display: 'contents' }}>
      <MoneyRooms path={path} />
    </div>
  );
}
function MoneyRooms({ path }: { path: string }) {
  usePreferences();
  const { api, userId, session } = useSession();
  const token = session?.accessToken ?? null;
  const version = useRef({ api, userId, token, href: location.href, epoch: 0 });
  if (
    version.current.api !== api ||
    version.current.userId !== userId ||
    version.current.token !== token ||
    version.current.href !== location.href
  )
    version.current = { api, userId, token, href: location.href, epoch: version.current.epoch + 1 };
  const context = version.current;
  const mounted = useRef(true);
  type OpenedAction = { key: number; spec: ActionSpec; context: BankActionContext };
  const original = useRef<OpenedAction | null>(null);
  const nextAction = useRef(0);
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  const sameContext = () => mounted.current && version.current === context && location.href === context.href && api.canWrite();
  // canWrite here is the API's synchronous client/session identity lease,
  // not a service write permission. Owned reads still use their read contract.
  const sameReadContext = () => mounted.current && version.current === context && location.href === context.href && api.canWrite();
  const pending = pendingOutcomes(userId);
  const [action, setAction] = useState<OpenedAction | null>(null);
  const [revision, setRevision] = useState(0);
  const [, invalidateNavigation] = useState(0);
  function discard() {
    original.current = null;
    setAction(null);
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const departed = () => {
      const previous = version.current;
      if (previous.href === location.href) return;
      // Observe every full-URL departure before React can batch A→B→A.
      version.current = { ...previous, href: location.href, epoch: previous.epoch + 1 };
      original.current = null;
      // Unmount private fields and handlers in this event, before retained
      // native controls can be invoked. Dispatched journal bytes stay intact.
      flushSync(() => {
        setAction(null);
        invalidateNavigation((value) => value + 1);
      });
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      mounted.current = false;
      original.current = null;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
    };
  }, []);
  useLayoutEffect(() => {
    if (original.current && !original.current.context.current()) discard();
  }, [context]);
  useEffect(() => {
    let live = true;
    if (userId)
      void restorePendingOutcomes(userId)
        .catch(() => {
          // Unreadable or conflicting originals remain a conservative guard.
        })
        .finally(() => {
          if (live && mounted.current && version.current === context) setRevision((value) => value + 1);
        });
    return () => {
      live = false;
    };
  }, [userId, context]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (userId && event.key === pendingKey(userId)) setRevision((value) => value + 1);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [userId]);
  function open(spec: ActionSpec) {
    if (rendered.current !== rendering || !sameContext() || !userId || original.current) return;
    if (pendingOutcomes(userId).length) {
      document.getElementById('bank-unconfirmed')?.scrollIntoView({ block: 'start' });
      return;
    }
    const opened: OpenedAction = {
      key: ++nextAction.current,
      spec,
      context: { current: () => sameContext() && original.current === opened },
    };
    original.current = opened;
    setAction(opened);
  }
  const pathname = path.split('?')[0]!.replace(/\/$/, '') || '/';
  const match = pathname.match(/^\/(?:portfolio|money\/asset)\/([^/]+)(\/repeat-buy)?$/);
  let content;
  if (pathname === '/uc/recharge') content = <Deposit />;
  else if (pathname === '/uc/assets') content = <SupportedAssets />;
  else if (pathname === '/uc/withdraw/address')
    content = <WithdrawalAddresses key={`addresses:${revision}:${context.epoch}`} open={open} />;
  // Read once: the page takes the link's token out of the address bar.
  else if (pathname === '/approveAddress') content = <ApproveAddress search={new URL(context.href).search} />;
  else if (pathname === '/uc/withdraw/allowlist')
    content = (
      <WithdrawalAllowlist
        key={`withdrawal-allowlist:${context.epoch}`}
        context={{ current: sameReadContext }}
        search={new URL(context.href).search}
      />
    );
  else if (pathname === '/uc/withdraw/approvals')
    content = (
      <WithdrawalApprovals
        key={`withdrawal-approvals:${context.epoch}`}
        context={{ current: sameReadContext }}
        search={new URL(context.href).search}
      />
    );
  else if (pathname === '/uc/withdraw')
    content = (
      <Withdrawal key={`withdrawal:${context.epoch}`} context={{ current: sameReadContext }} search={new URL(context.href).search} />
    );
  else if (match?.[2])
    content = <RepeatBuy key={`${pathname}:${revision}:${context.epoch}`} asset={decodeURIComponent(match[1]!)} open={open} />;
  else
    content = (
      <BankRoutes key={`${pathname}:${revision}:${context.epoch}`} path={pathname} search={new URL(context.href).search} open={open} />
    );
  return (
    <>
      {pending.length > 0 && (
        <div id="bank-unconfirmed" data-testid="page" className="page money-pending" role="alert">
          <h2>
            <Text k="index.bank.writes.are.paused.while.an.outcome" />
          </h2>
          <p>
            <Text k="index.refreshing.quantities.cannot.prove.the.outcome.of" />
          </p>
          {pending.map((record, index) => (
            <p data-testid="money-reference" className="money-reference" key={`${record.reference}:${index}`}>
              {record.title} · {record.reference === 'unreadable' ? <Text k="pending-outcomes.recovery.required" /> : record.procedure}
              <Text k="index.reference" />
              {record.reference}
              {Object.entries(record.recordRefs).map(([key, value]) => (
                <span key={key}>
                  {' '}
                  · {key}: {value}
                </span>
              ))}
            </p>
          ))}
          <a className="button button--secondary" href="/support">
            <Text k="index.open.support" />
          </a>
        </div>
      )}
      {content}
      {action && action.context.current() && (
        <MutationDialog
          key={action.key}
          spec={action.spec}
          context={action.context}
          onClose={() => {
            if (action.context.current()) discard();
          }}
          onDone={() => {
            if (action.context.current()) setRevision((value) => value + 1);
          }}
          onPendingChange={() => {
            if (action.context.current()) setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
