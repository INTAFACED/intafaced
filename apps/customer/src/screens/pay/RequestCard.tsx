import { useEffect, useMemo, useState } from 'react';
import { Link2, Share2 } from 'lucide-react';
import { AmountField, AssetIcon, Button, EmptyState, StatusNote, useToast } from '@intafaced/ui/lit';
import { KeyValue, SelectField, Skeleton, TextField } from '@intafaced/ui/lit/templates';
import {
  addRequest,
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
  useSession,
  type PaymentRequest,
  type RequestEntry,
} from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { absoluteLink, canShare, copyText, shareLink } from './share';
import { QrCode } from './QrCode';
import type { IdentityState } from './identity-state';
import { AskAPerson, RequestLists } from './ServerRequests';

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
      <div className="lt-stack" aria-busy="true" data-testid="request-loading">
        <Skeleton shape="figure" />
        <Skeleton shape="form" count={2} />
      </div>
    );
  if (identity.status === 'error')
    return (
      <StatusNote
        tone="error"
        title={payCopy.t('Couldn’t load your details')}
        actions={<Button onClick={identity.retry}>{payCopy.t('Retry')}</Button>}
      />
    );
  if (loaded === 'error')
    return (
      <StatusNote
        tone="error"
        title={payCopy.t('Couldn’t load your balances')}
        actions={
          <Button
            onClick={() => {
              setAssets({ owner: null, value: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            {payCopy.t('Retry')}
          </Button>
        }
      />
    );
  const payeeId = identity.status === 'handles' ? identity.handle : (userId ?? '');
  return (
    <div className="lt-stack" data-testid="request-card">
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
        <div className="lt-stack" data-testid="request-made">
          <h3>{t('reqReady')}</h3>
          <p className="lt-hint">{t('reqReadyHint')}</p>
          <QrCode value={absoluteLink(made.path)} />
          <p className="lt-mono" data-testid="request-link">
            {absoluteLink(made.path)}
          </p>
          {failed ? <StatusNote tone="error">{t('copyLinkFailed')}</StatusNote> : null}
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
          className="lt-stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div className="lt-stack" data-testid="request-amount-field">
            <SelectField label={t('reqAsset')} value={chosen} options={assets} onChange={setAsset} />
            <AmountField
              size="hero"
              label={t('reqAmount')}
              value={amount}
              onChange={setAmount}
              precision={18}
              placeholder="0"
              unit={chosen ? <AssetIcon asset={chosen} /> : undefined}
            />
          </div>
          <TextField
            id="request-note"
            label={t('reqNote')}
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            autoComplete="off"
            placeholder={t('notePlaceholder')}
            hint={t('reqNoteHint')}
            onChange={setNote}
          />
          <Button type="submit" tone="primary" size="lg" block disabled={reason !== null} data-testid="request-create">
            {reason ?? t('reqCreate')}
          </Button>
        </form>
      )}

      <StatusNote title={t('reqDeviceOnlyTitle')}>{t('reqDeviceOnlyBody')}</StatusNote>

      <div className="lt-stack" data-testid="request-list">
        <h3>{t('reqListTitle')}</h3>
        {list.length === 0 ? (
          <EmptyState title={t('reqListEmpty')} />
        ) : (
          <ul className="lt-rows">
            {list.map((entry) => (
              <li key={entry.id} data-testid="request-row">
                <div className="lt-actions">
                  <span>{entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : t('reqAnyAmount')}</span>
                  <span className="lt-muted">{when(entry.at)}</span>
                </div>
                {entry.note ? <div className="lt-muted">{entry.note}</div> : null}
                {shownCode === entry.id ? <QrCode value={absoluteLink(entry.path)} /> : null}
                <div className="lt-actions">
                  <a className="lt-button lt-button-secondary" href={requestRoomHref(entry.id)}>
                    {t('reqDetails')}
                  </a>
                  <Button onClick={() => void copy(entry)}>{t('copyLink')}</Button>
                  <Button onClick={() => setShownCode(shownCode === entry.id ? null : entry.id)}>
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
        <Button disabled aria-describedby="request-cancel-reason">
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
    <div className="lt-stack" data-testid="request-pay">
      <h3>{t('reqPayTitle')}</h3>
      <p className="lt-hint">{t('reqPayIntro')}</p>
      <TextField
        id="request-pay-link"
        label={t('reqPayLabel')}
        type="text"
        value={raw}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={t('reqPayPlaceholder')}
        onChange={(value) => {
          setRaw(value);
          setChecked({ kind: 'idle' });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            check();
          }
        }}
      />
      {checked.kind === 'invalid' ? <StatusNote tone="error">{t('reqPayInvalid')}</StatusNote> : null}
      {checked.kind === 'ok' ? (
        <div data-testid="request-pay-summary">
          <KeyValue
            rows={[
              { label: t('reqPayWho'), value: checked.request.kind === 'handle' ? `@${checked.request.to}` : checked.request.to },
              {
                label: t('reqPayAmount'),
                value:
                  checked.request.amount && checked.request.asset
                    ? `${checked.request.amount} ${checked.request.asset}`
                    : t('reqAnyAmount'),
              },
              ...(checked.request.note ? [{ label: t('reqPayNote'), value: checked.request.note }] : []),
            ]}
          />
        </div>
      ) : null}
      {checked.kind === 'ok' ? (
        <Button tone="primary" size="lg" block onClick={() => navigate(checked.path)} data-testid="request-pay-continue">
          {t('reqPayContinue')}
        </Button>
      ) : (
        <Button size="lg" block disabled={raw.trim() === ''} onClick={check}>
          {t('reqPayCheck')}
        </Button>
      )}
    </div>
  );
}
