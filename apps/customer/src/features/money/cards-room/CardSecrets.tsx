import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BANK_CARDS_WALLET_PROVISION } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_CARDS_REVEAL } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_CARDS_PIN_SET } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_CARDS_PIN_REVEAL } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_CARDS_WALLET_TOKENS } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_CARDS_SECRETS_OFFERED } from '@intafaced/contracts/bank-cards-procedures';
import type { z } from 'zod';
import type { ApiResult } from '../../../shared/api';
import { Button, Field } from '@intafaced/ui/lit';
import { useSession } from '../../session';
import type { StepUpBegin } from '../../account';
import { useBankRecord } from '../components';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { type cardSchema, type CardWalletTokens } from '../contracts';
import { DisabledAction, Fact, ResourceView } from '../bank-settings/parts';
import { Refusal } from './CardJourney';
import { StepUpInline } from '../bank-settings/StepUpInline';
import { cardDepthCopy } from '../card-depth-copy';
import { cardSecretsCopy } from '../card-secrets-copy';
import { withPlainRefusal } from '../money-refusal-copy';

/**
 * A card's details, PIN and phone wallets (J-bank-14 #3 #4; BK-cctl-03, BK-cctl-04). Each reveal and each new PIN needs
 * a fresh confirmation for that one request; what is shown is dropped from the screen at the time svc-bank gives, and
 * showing it again asks again. Nothing is kept in the browser. Where the card issuer offers none of them, the buttons
 * stay on the screen with the reason. The TEST card partner's answers say TEST.
 */

type CardRecord = z.infer<typeof cardSchema>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Offered = { details: boolean; pin: boolean; wallet: boolean; test: boolean; walletNotOffered: boolean };

export function useSecretsOffered(): Offered | null {
  const read = useBankRecord(BANK_CARDS_SECRETS_OFFERED, undefined);
  return read.resource.status === 'ready' ? read.resource.data : null;
}

function useStepUpWords(why: 'whyDetails' | 'whyPin' | 'whyPinSet') {
  const { t } = cardSecretsCopy.useCopy();
  return {
    why: t(why),
    code: t('code'),
    codeHint: t('codeHint'),
    codeShort: t('codeShort'),
    noFactor: t('noFactor'),
    sendWithout: t('sendWithout'),
  };
}

/** Drop what was shown at `expiresAt`, and on leaving the screen. */
function useDropAt(expiresAt: string | null, drop: () => void) {
  const latest = useRef(drop);
  latest.current = drop;
  useEffect(() => {
    if (!expiresAt) return;
    const left = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timer = setTimeout(() => latest.current(), left);
    return () => clearTimeout(timer);
  }, [expiresAt]);
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The full card number, expiry and security code, after a fresh confirmation each time. */
export function CardDetailsReveal({ card, offered }: { card: CardRecord; offered: Offered | null }) {
  const { api } = useSession();
  const { t } = cardSecretsCopy.useCopy();
  const depth = cardDepthCopy.useCopy().t;
  const words = useStepUpWords('whyDetails');
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<ProcedureOutput<typeof BANK_CARDS_REVEAL> | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  useDropAt(shown?.expiresAt ?? null, () => setShown(null));
  if (!offered?.details || card.status === 'closed') return <DisabledAction label={depth('detailsShow')} reason={depth('detailsReason')} />;

  async function reveal(revealId: string, stepUpApprovalId: string | null) {
    setBusy(true);
    setFailure(null);
    const done = await api.call(BANK_CARDS_REVEAL, { cardId: card.id, revealId, ...(stepUpApprovalId ? { stepUpApprovalId } : {}) });
    setBusy(false);
    setAsking(null);
    if (!done.ok) return setFailure(withPlainRefusal(done));
    setShown(done.data);
  }
  const request = (revealId: string): StepUpBegin => ({
    scope: 'bank.step_up.cards.reveal',
    purpose: 'cards.reveal',
    target: card.id,
    fields: { cardId: card.id, revealId },
  });
  return (
    <div data-testid="card-details-reveal">
      {shown ? (
        <>
          <dl className="lt-kv" aria-label={depth('detailsTitle')}>
            <Fact label={t('pan')}>
              <span lang="zxx" dir="ltr" data-testid="card-pan">
                {shown.pan}
              </span>
            </Fact>
            <Fact label={t('expiry')}>
              <span lang="zxx" dir="ltr" data-testid="card-expiry">
                {shown.expiry}
              </span>
            </Fact>
            <Fact label={t('cvv')}>
              <span lang="zxx" dir="ltr" data-testid="card-cvv">
                {shown.cvv}
              </span>
            </Fact>
          </dl>
          {shown.test && <p className="lt-hint">{t('testDetails')}</p>}
          <p className="lt-hint" role="status">
            {t('hidesAt', { time: timeOf(shown.expiresAt) })}
          </p>
          <Button tone="quiet" onClick={() => setShown(null)}>
            {t('hide')}
          </Button>
        </>
      ) : asking ? (
        <>
          <StepUpInline request={() => request(asking)} words={words} disabled={busy} onApproved={(id) => void reveal(asking, id)} />
          <Button tone="quiet" disabled={busy} onClick={() => setAsking(null)}>
            {t('cancel')}
          </Button>
        </>
      ) : (
        <Button tone="secondary" onClick={() => setAsking(crypto.randomUUID())}>
          {depth('detailsShow')}
        </Button>
      )}
      {failure && <Refusal failure={failure} />}
    </div>
  );
}

/** View the PIN, or set a new one, each after a fresh confirmation. */
export function CardPinPanel({ card, offered }: { card: CardRecord; offered: Offered | null }) {
  const { api } = useSession();
  const { t } = cardSecretsCopy.useCopy();
  const depth = cardDepthCopy.useCopy().t;
  const viewWords = useStepUpWords('whyPin');
  const setWords = useStepUpWords('whyPinSet');
  const [asking, setAsking] = useState<{ kind: 'view' | 'set'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [shown, setShown] = useState<ProcedureOutput<typeof BANK_CARDS_PIN_REVEAL> | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  useDropAt(shown?.expiresAt ?? null, () => setShown(null));
  if (!offered?.pin || card.status === 'closed') {
    return (
      <div className="lt-actions">
        <DisabledAction label={depth('pinView')} reason={depth('pinReason')} />
        <DisabledAction label={depth('pinChange')} reason={depth('pinReason')} />
      </div>
    );
  }

  async function send(kind: 'view' | 'set', id: string, stepUpApprovalId: string | null) {
    setBusy(true);
    setFailure(null);
    const approval = stepUpApprovalId ? { stepUpApprovalId } : {};
    if (kind === 'view') {
      const read = await api.call(BANK_CARDS_PIN_REVEAL, { cardId: card.id, revealId: id, ...approval });
      setBusy(false);
      setAsking(null);
      if (!read.ok) return setFailure(withPlainRefusal(read));
      setShown(read.data);
      return;
    }
    const set = await api.call(BANK_CARDS_PIN_SET, { cardId: card.id, commandId: id, pin, ...approval });
    setBusy(false);
    setAsking(null);
    setPin('');
    if (!set.ok) return setFailure(withPlainRefusal(set));
    setDone(true);
  }
  function startSet(event: FormEvent) {
    event.preventDefault();
    setDone(false);
    if (!/^\d{4,12}$/.test(pin)) return setProblem(t('pinDigits'));
    setProblem(null);
    setAsking({ kind: 'set', id: crypto.randomUUID() });
  }
  const request = (kind: 'view' | 'set', id: string): StepUpBegin =>
    kind === 'view'
      ? { scope: 'bank.step_up.cards.pinReveal', purpose: 'cards.pinReveal', target: card.id, fields: { cardId: card.id, revealId: id } }
      : { scope: 'bank.step_up.cards.pinSet', purpose: 'cards.pinSet', target: card.id, fields: { cardId: card.id, commandId: id } };
  return (
    <div data-testid="card-pin">
      {shown ? (
        <>
          <dl className="lt-kv">
            <Fact label={t('pin')}>
              <span lang="zxx" dir="ltr" data-testid="card-pin-shown">
                {shown.pin}
              </span>
            </Fact>
          </dl>
          {shown.test && <p className="lt-hint">{t('testPin')}</p>}
          <p className="lt-hint" role="status">
            {t('hidesAt', { time: timeOf(shown.expiresAt) })}
          </p>
          <Button tone="quiet" onClick={() => setShown(null)}>
            {t('hide')}
          </Button>
        </>
      ) : asking ? (
        <>
          <StepUpInline
            request={() => request(asking.kind, asking.id)}
            words={asking.kind === 'view' ? viewWords : setWords}
            disabled={busy}
            onApproved={(id) => void send(asking.kind, asking.id, id)}
          />
          <Button
            tone="quiet"
            disabled={busy}
            onClick={() => {
              setAsking(null);
              setPin('');
            }}
          >
            {t('cancel')}
          </Button>
        </>
      ) : (
        <>
          <Button tone="secondary" onClick={() => setAsking({ kind: 'view', id: crypto.randomUUID() })}>
            {depth('pinView')}
          </Button>
          <form onSubmit={startSet} aria-label={depth('pinChange')}>
            <Field
              label={t('pinField')}
              error={problem ?? undefined}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(event) => setPin(event.target.value.trim())}
              data-testid="card-pin-field"
            />
            <Button tone="primary" type="submit">
              {t('pinSubmit')}
            </Button>
          </form>
          {done && (
            <p className="lt-hint" role="status">
              {t('pinDone')}
            </p>
          )}
          {offered.test && <p className="lt-hint">{t('testPin')}</p>}
        </>
      )}
      {failure && <Refusal failure={failure} />}
    </div>
  );
}

/** Add the card to a phone wallet, and the wallets it is in with each one's state. */
export function CardWalletPanel({ card, offered }: { card: CardRecord; offered: Offered | null }) {
  const depth = cardDepthCopy.useCopy().t;
  const read = useBankRecord(BANK_CARDS_WALLET_TOKENS, { cardId: card.id }, Boolean(offered?.wallet));
  if (!offered?.wallet) {
    // The partner's own no reads as the partner's; otherwise no issuer that adds cards to phone wallets is connected.
    const reason = offered?.walletNotOffered ? depth('walletNotOffered') : depth('walletReason');
    return (
      <div className="lt-actions" data-testid="card-wallets" data-offered={offered?.walletNotOffered ? 'not-by-partner' : 'no-issuer'}>
        <DisabledAction label={depth('walletApple')} reason={reason} />
        <DisabledAction label={depth('walletGoogle')} reason={reason} />
      </div>
    );
  }
  return (
    <ResourceView resource={read.resource} reload={read.reload}>
      {(tokens) => <Wallets card={card} tokens={tokens} reload={read.reload} />}
    </ResourceView>
  );
}

function Wallets({ card, tokens, reload }: { card: CardRecord; tokens: CardWalletTokens; reload: () => void }) {
  const { api } = useSession();
  const { t } = cardSecretsCopy.useCopy();
  const depth = cardDepthCopy.useCopy().t;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const active = card.status === 'active';
  const name = (wallet: 'apple' | 'google') => (wallet === 'apple' ? t('walletAppleName') : t('walletGoogleName'));
  const state = (s: 'added' | 'paused' | 'closed') =>
    s === 'added' ? t('walletAdded') : s === 'paused' ? t('walletPaused') : t('walletClosed');
  async function add(wallet: 'apple' | 'google') {
    setBusy(true);
    setFailure(null);
    // In the browser there is no phone wallet to hand a nonce over, so each try sends its own; the card partner's
    // payload is not kept here, and the token row is svc-bank's.
    const done = await api.call(BANK_CARDS_WALLET_PROVISION, {
      cardId: card.id,
      provisionId: crypto.randomUUID(),
      wallet,
      nonce: crypto.randomUUID(),
    });
    setBusy(false);
    if (!done.ok) return setFailure(withPlainRefusal(done));
    reload();
  }
  return (
    <div data-testid="card-wallets">
      {tokens.tokens.length ? (
        <ul aria-label={t('walletList')}>
          {tokens.tokens.map((token) => (
            <li key={token.id} data-wallet={token.wallet} data-state={token.state}>
              {name(token.wallet)}: {state(token.state)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="lt-hint">{t('walletNone')}</p>
      )}
      {active ? (
        <div className="lt-actions">
          <Button tone="secondary" disabled={busy} onClick={() => void add('apple')}>
            {depth('walletApple')}
          </Button>
          <Button tone="secondary" disabled={busy} onClick={() => void add('google')}>
            {depth('walletGoogle')}
          </Button>
        </div>
      ) : (
        <p className="lt-hint">{t('walletInactive')}</p>
      )}
      {tokens.test && <p className="lt-hint">{t('testWallet')}</p>}
      {failure && <Refusal failure={failure} />}
    </div>
  );
}
