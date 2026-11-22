import { useEffect, useMemo, useState } from 'react';
import { Link2, Share2 } from 'lucide-react';
import { Button, DecimalField, EmptyState, Field, useToast } from '@intafaced/ui/lit';
import { QrCode, Skeleton } from '@intafaced/ui/lit/templates';
import {
  addRequest,
  cleanAmount,
  cleanNote,
  createPersonalPayApi,
  encodeQr,
  navigate,
  NOTE_MAX,
  parseRequestLink,
  qrPath,
  readRequests,
  removeRequest,
  requestPath,
  requestRoomHref,
  useSession,
  type PaymentRequest,
  type RequestEntry,
} from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { absoluteLink, canShare, copyText, shareLink } from './share';
import type { IdentityState } from './identity-state';
import { AskAPerson, RequestLists } from './ServerRequests';

/** A QR code for a payment link, drawn by the kit on its fixed light plate; the value is encoded as QrCode.tsx does. */
function RequestQr({ value }: { value: string }) {
  const { t } = personalCopy.useCopy();
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  if (!drawn) return <p className="lt-hint">{t('qrFailed')}</p>;
  return <QrCode d={drawn.d} size={drawn.size} label={t('qrLabel')} failed={t('qrFailed')} data-testid="pay-qr" />;
}

/** A load that failed, with its retry: the kit's empty state, announced as an alert as before. */
function LoadFailed({ title, onRetry, retryLabel }: { title: string; onRetry: () => void; retryLabel: string }) {
  return (
    <div role="alert">
      <EmptyState
        title={title}
        action={
          <Button tone="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        }
      />
    </div>
  );
}

const DOLLAR_COINS = ['USDT', 'USDC', 'USD'];

/** Assets the customer can be paid in: the main space of each asset. Dollar coins first, then by ticker. */
export function receivableAssets(spaces: readonly { assetId: string; kind: 'primary' | 'named' }[]): string[] {
  const codes = [...new Set(spaces.filter((space) => space.kind === 'primary').map((space) => space.assetId))];
  return codes.sort((a, b) => Number(DOLLAR_COINS.includes(b)) - Number(DOLLAR_COINS.includes(a)) || a.localeCompare(b));
}

/** Request money (/pay/request): make a payment link, list the links made here, and pay a link someone sent. */
export function RequestCard({ identity }: { identity: IdentityState }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const { t } = personalCopy.useCopy();
  const [assets, setAssets] = useState<{ owner: string | null; value: 'loading' | 'error' | string[] }>({ owner: null, value: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void pay.spaces(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setAssets({ owner: userId, value: result.ok ? receivableAssets(result.data) : 'error' });
    });
    return () => controller.abort();
  }, [pay, userId, attempt]);
  const loaded = assets.owner === userId ? assets.value : 'loading';

  if (identity.status === 'loading' || loaded === 'loading')
    return (
      <div aria-busy="true" data-testid="request-loading">
        <Skeleton shape="form" />
      </div>
    );
  if (identity.status === 'error')
    return <LoadFailed title={payCopy.t('Couldn’t load your details')} onRetry={identity.retry} retryLabel={payCopy.t('Retry')} />;
  if (loaded === 'error')
    return (
      <LoadFailed
        title={payCopy.t('Couldn’t load your balances')}
        onRetry={() => {
          setAssets({ owner: null, value: 'loading' });
          setAttempt((n) => n + 1);
        }}
        retryLabel={payCopy.t('Retry')}
      />
    );
  const payeeId = identity.status === 'handles' ? identity.handle : (userId ?? '');
  return (
    <div className="lt-body" data-testid="request-card">
      {loaded.length === 0 ? null : <AskAPerson assets={loaded} onSent={() => setRevision((n) => n + 1)} />}
      <RequestLists revision={revision} />
      <p className="lt-hint">{t('reqIntro')}</p>
      {loaded.length === 0 ? (
        <EmptyState title={t('reqNoAssetsTitle')} body={t('reqNoAssetsBody')} />
      ) : (
        <CreateRequest userId={userId as string} payeeId={payeeId} assets={loaded} />
      )}
      <PayARequest />
    </div>
  );
}

function CreateRequest({ userId, payeeId, assets }: { userId: string; payeeId: string; assets: string[] }) {
  const { t, requestedLocale } = personalCopy.useCopy();
  const toast = useToast();
  const [asset, setAsset] = useState(assets[0] ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [made, setMade] = useState<RequestEntry | null>(null);
  const [list, setList] = useState<RequestEntry[]>(() => readRequests(userId));
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const chosen = assets.includes(asset) ? asset : (assets[0] ?? '');
  const valid = cleanAmount(amount);
  const reason = valid === null ? t('reqNeedAmount') : chosen === '' ? t('reqNeedAsset') : null;

  function create() {
    if (reason !== null || valid === null) return;
    const path = requestPath({ to: payeeId, amount: valid, asset: chosen, note });
    const entry: RequestEntry = {
      id: crypto.randomUUID(),
      path,
      to: payeeId,
      amount: valid,
      asset: chosen,
      note: cleanNote(note),
      at: new Date().toISOString(),
    };
    addRequest(userId, entry);
    setList(readRequests(userId));
    setMade(entry);
    setFailed(false);
  }
  async function copy(entry: RequestEntry) {
    const ok = await copyText(absoluteLink(entry.path));
    if (ok) toast.add({ title: t('linkCopied'), timeout: 2000 });
    setFailed(!ok);
  }
  async function share(entry: RequestEntry) {
    const result = await shareLink(absoluteLink(entry.path), t('shareTitle'));
    if (result === 'failed') await copy(entry);
  }
  const when = (iso: string) => new Date(iso).toLocaleString(requestedLocale);

  return (
    <>
      {made ? (
        <div className="lt-review" data-testid="request-made">
          <h3>{t('reqReady')}</h3>
          <p className="lt-hint">{t('reqReadyHint')}</p>
          <RequestQr value={absoluteLink(made.path)} />
          <p className="lt-mono" data-testid="request-link">
            {absoluteLink(made.path)}
          </p>
          {failed ? <p role="alert">{t('copyLinkFailed')}</p> : null}
          <div className="lt-actions">
            <Button tone="primary" onClick={() => void copy(made)}>
              <Link2 size={16} aria-hidden="true" />
              {t('copyLink')}
            </Button>
            {canShare() ? (
              <Button tone="secondary" onClick={() => void share(made)}>
                <Share2 size={16} aria-hidden="true" />
                {t('share')}
              </Button>
            ) : null}
            <Button
              tone="quiet"
              onClick={() => {
                setMade(null);
                setAmount('');
                setNote('');
              }}
            >
              {t('reqMakeAnother')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="lt-review"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div className="lt-actions" data-testid="request-amount-field">
            <div className="lt-field">
              <select aria-label={t('reqAsset')} value={chosen} onChange={(event) => setAsset(event.target.value)}>
                {assets.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            {/* A typed "," is the decimal point; a pasted "1,234.56" is cleaned to 1234.56. */}
            <DecimalField
              label={t('reqAmount')}
              aria-label={t('reqAmount')}
              placeholder="0"
              precision={18}
              typedMark="either"
              value={amount}
              onValueChange={setAmount}
              data-testid="request-amount"
            />
          </div>
          <Field
            id="request-note"
            label={t('reqNote')}
            hint={t('reqNoteHint')}
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            autoComplete="off"
            placeholder={t('notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" tone="primary" size="lg" block disabled={reason !== null} data-testid="request-create">
            {reason ?? t('reqCreate')}
          </Button>
        </form>
      )}

      <div className="lt-review" role="note">
        <p className="lt-held">{t('reqDeviceOnlyTitle')}</p>
        <p className="lt-hint">{t('reqDeviceOnlyBody')}</p>
      </div>

      <div className="lt-review" data-testid="request-list">
        <h3>{t('reqListTitle')}</h3>
        {list.length === 0 ? (
          <p className="lt-hint">{t('reqListEmpty')}</p>
        ) : (
          <ul className="lt-steps">
            {list.map((entry) => (
              <li key={entry.id} className="lt-review" data-testid="request-row">
                <div className="lt-title-row">
                  <span>{entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : t('reqAnyAmount')}</span>
                  <span className="lt-hint">{when(entry.at)}</span>
                </div>
                {entry.note ? <div className="lt-hint">{entry.note}</div> : null}
                {shownCode === entry.id ? <RequestQr value={absoluteLink(entry.path)} /> : null}
                <div className="lt-actions">
                  <a className="lt-button lt-button-secondary" href={requestRoomHref(entry.id)}>
                    {t('reqDetails')}
                  </a>
                  <Button tone="secondary" onClick={() => void copy(entry)}>
                    {t('copyLink')}
                  </Button>
                  <Button tone="secondary" onClick={() => setShownCode(shownCode === entry.id ? null : entry.id)}>
                    {shownCode === entry.id ? t('reqHideCode') : t('reqShowCode')}
                  </Button>
                  <Button
                    tone="quiet"
                    onClick={() => {
                      removeRequest(userId, entry.id);
                      setList(readRequests(userId));
                      if (made?.id === entry.id) setMade(null);
                    }}
                  >
                    {t('reqRemove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button tone="secondary" disabled aria-describedby="request-cancel-reason">
          {t('reqCancel')}
        </Button>
        <p className="lt-hint" id="request-cancel-reason">
          {t('reqCancelReason')}
        </p>
      </div>
    </>
  );
}

/** Pay a request: check a link someone sent, show what it asks, then hand it to Send, which still reviews everything. */
function PayARequest() {
  const { t } = personalCopy.useCopy();
  const [raw, setRaw] = useState('');
  const [checked, setChecked] = useState<{ kind: 'idle' } | { kind: 'invalid' } | { kind: 'ok'; request: PaymentRequest; path: string }>({
    kind: 'idle',
  });
  function check() {
    const request = parseRequestLink(raw, location.origin);
    if (!request) return setChecked({ kind: 'invalid' });
    setChecked({ kind: 'ok', request, path: requestPath(request) });
  }
  return (
    <div className="lt-review" data-testid="request-pay">
      <h3>{t('reqPayTitle')}</h3>
      <p className="lt-hint">{t('reqPayIntro')}</p>
      <Field
        id="request-pay-link"
        label={t('reqPayLabel')}
        type="text"
        value={raw}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={t('reqPayPlaceholder')}
        onChange={(event) => {
          setRaw(event.target.value);
          setChecked({ kind: 'idle' });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            check();
          }
        }}
      />
      {checked.kind === 'invalid' ? <p role="alert">{t('reqPayInvalid')}</p> : null}
      {checked.kind === 'ok' ? (
        <dl className="lt-kv" data-testid="request-pay-summary">
          <div>
            <dt>{t('reqPayWho')}</dt>
            <dd>{checked.request.kind === 'handle' ? `@${checked.request.to}` : checked.request.to}</dd>
          </div>
          <div>
            <dt>{t('reqPayAmount')}</dt>
            <dd>
              {checked.request.amount && checked.request.asset ? `${checked.request.amount} ${checked.request.asset}` : t('reqAnyAmount')}
            </dd>
          </div>
          {checked.request.note ? (
            <div>
              <dt>{t('reqPayNote')}</dt>
              <dd>{checked.request.note}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {checked.kind === 'ok' ? (
        <Button tone="primary" size="lg" block onClick={() => navigate(checked.path)} data-testid="request-pay-continue">
          {t('reqPayContinue')}
        </Button>
      ) : (
        <Button tone="secondary" size="lg" block disabled={raw.trim() === ''} onClick={check}>
          {t('reqPayCheck')}
        </Button>
      )}
    </div>
  );
}
