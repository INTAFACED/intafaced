import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import type { ApiResult } from '../../../shared/api';
import { MoneyDisplay } from './presentation';
import { Button, StateBlock } from '@intafaced/ui';
import type { PayoutState } from './model';
import { portalCopy } from './copy';
import { StatusChip } from './ui/StatusChip';
import { CopyReference } from './ui/CopyReference';
import { uiCopy } from './ui/copy';
import type { ChipKind } from './ui/status-vocabulary';
import { NotLiveCard } from './chrome/NotLiveCard';
import { isNotLive, notLiveReason, refusalText, refusalTitle } from './refusal';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** One page says each refusal once: the first failure to draw a given title and text keeps it, the rest draw nothing. */
type Once = { claim: (key: string, owner: string) => boolean; release: (key: string, owner: string) => void };
const RefusalOnce = createContext<Once | null>(null);
export function RefusalOnceProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<string, string>());
  const store = useRef<Once>({
    claim: (key, owner) => {
      const held = owners.current.get(key);
      if (held === undefined) owners.current.set(key, owner);
      return held === undefined || held === owner;
    },
    release: (key, owner) => {
      if (owners.current.get(key) === owner) owners.current.delete(key);
    },
  });
  return <RefusalOnce.Provider value={store.current}>{children}</RefusalOnce.Provider>;
}

/**
 * "Say each refusal once" for one refusal on the page: `claim()` is true when this part is the one that says `key`; the
 * words are given back when it goes. Outside the frame's `RefusalOnceProvider` every part says its own.
 */
export function useSaidOnce(key: string): () => boolean {
  const once = useContext(RefusalOnce);
  const id = useId();
  useEffect(() => () => once?.release(key, id), [once, key, id]);
  return () => !once || once.claim(key, id);
}

/** Loading skeleton (B11): the shape of the page that is coming, announced once to assistive tech. */
export function PortalLoading({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = portalCopy.useCopy();
  return <StateBlock kind="loading" rows={rows} label={label ?? t('loading')} />;
}

/** A feature that is not live yet. One calm card; see NotLiveCard. */
export const NotLive = NotLiveCard;

/**
 * A refusal in plain words. When the service has not switched the feature on, it is a card naming the blocker instead:
 * pass `notLive` to word it for the page, or the code's own reason (or a general one) is used.
 */
export function PortalFailure({ result, retry, notLive }: { result: Failed; retry?: () => void; notLive?: string }) {
  const { t } = portalCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  const claim = useSaidOnce(`${refusalTitle(result)}|${refusalText(result)}`);
  if (isNotLive(result)) return <NotLive reason={notLive ?? notLiveReason(result)} />;
  // The same refusal, twice on one page, is said once.
  if (!claim()) return null;
  return (
    <div data-testid="failure" className="lt-refusal" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3>{refusalTitle(result)}</h3>
      <p>{refusalText(result)}</p>
      {result.requestId && (
        <p className="lt-muted">
          {u('reference')} <CopyReference value={result.requestId} what={u('reference')} />
        </p>
      )}
      {result.reason === 'unauthorized' ? (
        <a
          className="lt-link"
          href={`/login?redirect=${encodeURIComponent(typeof location === 'undefined' ? '/pay/merchant' : location.pathname + location.search)}`}
        >
          {t('signIn')}
        </a>
      ) : (
        // Asking again never turns a "you may not" into a "yes", so a refusal for permission has no Try again.
        retry &&
        result.reason !== 'uncertain' &&
        result.reason !== 'forbidden' && (
          <Button variant="secondary" onClick={retry}>
            {t('tryAgain')}
          </Button>
        )
      )}
    </div>
  );
}

export function Money({ value, asset }: { value: string; asset: string }) {
  return (
    <span className="numeric pp-money">
      <MoneyDisplay value={value} asset={asset} unit={asset} />
    </span>
  );
}

/** One shared vocabulary per entity (B4): the words come from `ui/StatusChip`. Kept under this name for existing pages. */
export function Chip({ kind, value }: { kind: ChipKind; value: string }) {
  return <StatusChip entity={kind} value={value} />;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field pp-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Ordered steps with no clock where the service keeps none: it says so once instead of inventing times. */
export function Steps({
  items,
  label,
}: {
  items: ReadonlyArray<{ title: string; detail?: string; state: 'done' | 'current' | 'todo' | 'bad' }>;
  label: string;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <ol className="pp-timeline pp-steps-list" aria-label={label}>
      {items.map((item, i) => (
        <li key={i} className={`pp-stepitem pp-stepitem--${item.state}`}>
          <span className="pp-timeline-dot" aria-hidden="true" />
          <div>
            <strong>
              {item.title}
              <span className="lt-sr"> ({t(`stepItem_${item.state}` as 'stepItem_done')})</span>
            </strong>
            {item.detail && <p className="lt-muted">{item.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export type { PayoutState };
