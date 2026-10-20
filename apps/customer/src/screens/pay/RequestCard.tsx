import { useEffect, useMemo, useState } from 'react';
import { Link2, Share2 } from 'lucide-react';
import {
  addRequest,
  AmountInput,
  Button,
  CoinIcon,
  cleanAmount,
  cleanNote,
  createPersonalPayApi,
  navigate,
  NOTE_MAX,
  parseRequestLink,
  readRequests,
  removeRequest,
  requestPath,
  requestRoomHref,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StateBlock,
  useSession,
  useToast,
  type PaymentRequest,
  type RequestEntry,
} from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { absoluteLink, canShare, copyText, shareLink } from './share';
import { QrCode } from './QrCode';
import type { IdentityState } from './identity-state';

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
      <div className="pay-body pay-body--skeleton" aria-busy="true" data-testid="request-loading">
        <Skeleton height={104} />
        <Skeleton height={132} />
        <Skeleton height={56} circle />
      </div>
    );
  if (identity.status === 'error')
    return (
      <StateBlock kind="error" title={payCopy.t('Couldn’t load your details')} onRetry={identity.retry} retryLabel={payCopy.t('Retry')} />
    );
  if (loaded === 'error')
    return (
      <StateBlock
        kind="error"
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
    <div className="pay-body" data-testid="request-card">
      <p className="pay-hint">{t('reqIntro')}</p>
      {loaded.length === 0 ? (
        <StateBlock kind="empty" title={t('reqNoAssetsTitle')} body={t('reqNoAssetsBody')} />
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
  const items = useMemo(() => Object.fromEntries(assets.map((code) => [code, code])), [assets]);
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
        <div className="pay-block" data-testid="request-made">
          <h3 className="pay-section-title">{t('reqReady')}</h3>
          <p className="pay-hint">{t('reqReadyHint')}</p>
          <QrCode value={absoluteLink(made.path)} />
          <p className="pay-link" data-testid="request-link">
            {absoluteLink(made.path)}
          </p>
          {failed ? (
            <p className="pay-problem" role="alert">
              {t('copyLinkFailed')}
            </p>
          ) : null}
          <div className="pay-row-actions">
            <Button variant="primary" size={40} onClick={() => void copy(made)}>
              <Link2 size={16} aria-hidden="true" />
              {t('copyLink')}
            </Button>
            {canShare() ? (
              <Button variant="secondary" size={40} onClick={() => void share(made)}>
                <Share2 size={16} aria-hidden="true" />
                {t('share')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size={40}
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
          className="pay-body"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div className="pay-field" data-testid="request-amount-field">
            <span className="pay-field__label">{t('reqAmount')}</span>
            <div className="pay-field__main">
              <Select items={items} value={chosen} onValueChange={(value) => typeof value === 'string' && setAsset(value)}>
                <SelectTrigger className="pay-asset" aria-label={t('reqAsset')}>
                  {chosen ? <CoinIcon asset={chosen} size={28} /> : null}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AmountInput
                size="hero"
                aria-label={t('reqAmount')}
                value={amount}
                onValueChange={setAmount}
                precision={18}
                placeholder="0"
                className="pay-amount"
              />
            </div>
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="request-note">
              {t('reqNote')}
            </label>
            <input
              id="request-note"
              className="pay-text"
              type="text"
              value={note}
              maxLength={NOTE_MAX}
              autoComplete="off"
              placeholder={t('notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
            <span className="pay-hint">{t('reqNoteHint')}</span>
          </div>
          <Button type="submit" variant="primary" size={56} fullWidth disabled={reason !== null} data-testid="request-create">
            {reason ?? t('reqCreate')}
          </Button>
        </form>
      )}

      <div className="pay-reason" role="note">
        <p className="pay-reason__title">{t('reqDeviceOnlyTitle')}</p>
        <p className="pay-reason__body">{t('reqDeviceOnlyBody')}</p>
      </div>

      <div className="pay-block" data-testid="request-list">
        <h3 className="pay-section-title">{t('reqListTitle')}</h3>
        {list.length === 0 ? (
          <p className="pay-empty">{t('reqListEmpty')}</p>
        ) : (
          <ul className="pay-list">
            {list.map((entry) => (
              <li key={entry.id} data-testid="request-row">
                <div className="pay-list__main">
                  <span>{entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : t('reqAnyAmount')}</span>
                  <span className="pay-list__sub">{when(entry.at)}</span>
                </div>
                {entry.note ? <div className="pay-list__sub">{entry.note}</div> : null}
                {shownCode === entry.id ? <QrCode value={absoluteLink(entry.path)} /> : null}
                <div className="pay-row-actions">
                  <Button variant="secondary" size={32} nativeButton={false} render={<a href={requestRoomHref(entry.id)} />}>
                    {t('reqDetails')}
                  </Button>
                  <Button variant="secondary" size={32} onClick={() => void copy(entry)}>
                    {t('copyLink')}
                  </Button>
                  <Button variant="secondary" size={32} onClick={() => setShownCode(shownCode === entry.id ? null : entry.id)}>
                    {shownCode === entry.id ? t('reqHideCode') : t('reqShowCode')}
                  </Button>
                  <Button
                    variant="ghost"
                    size={32}
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
        <Button variant="secondary" size={40} disabled aria-describedby="request-cancel-reason">
          {t('reqCancel')}
        </Button>
        <p className="pay-hint" id="request-cancel-reason">
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
    <div className="pay-block" data-testid="request-pay">
      <h3 className="pay-section-title">{t('reqPayTitle')}</h3>
      <p className="pay-hint">{t('reqPayIntro')}</p>
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="request-pay-link">
          {t('reqPayLabel')}
        </label>
        <input
          id="request-pay-link"
          className="pay-text"
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
      </div>
      {checked.kind === 'invalid' ? (
        <p className="pay-problem" role="alert">
          {t('reqPayInvalid')}
        </p>
      ) : null}
      {checked.kind === 'ok' ? (
        <dl className="pay-quote" data-testid="request-pay-summary">
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
        <Button variant="primary" size={48} fullWidth onClick={() => navigate(checked.path)} data-testid="request-pay-continue">
          {t('reqPayContinue')}
        </Button>
      ) : (
        <Button variant="secondary" size={48} fullWidth disabled={raw.trim() === ''} onClick={check}>
          {t('reqPayCheck')}
        </Button>
      )}
    </div>
  );
}
