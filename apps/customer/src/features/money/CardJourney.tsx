import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { Button, Dialog, Field } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { useBankRead } from './components';
import { bankWrites, type cardSchema } from './contracts';
import { cardOrderCopy } from './card-order-copy';
import { StepUpConfirm } from './StepUpConfirm';

/**
 * Each card's own panels on /bank/cards for getting a card (J-bank-13): its status in words, how many payments a
 * single-use card has used, a physical card's delivery with the address change, activation behind a fresh confirmation,
 * and the lost or stolen report. Every figure and state is the bank's own answer; nothing here works one out.
 */

type CardRecord = z.infer<typeof cardSchema>;
type Copy = ReturnType<typeof cardOrderCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const SAY: Record<string, (t: Copy) => string> = {
  'bank.card_address_locked': (t) => t('addressLocked'),
  'bank.step_up_unavailable': (t) => t('stepUpOff'),
};

export function Refusal({ failure }: { failure: Failed }) {
  const { t } = cardOrderCopy.useCopy();
  const code = failure.code ?? '';
  const said = SAY[code]?.(t) ?? failure.message;
  return (
    <p role="alert" className="error-text" data-code={code}>
      {said} {code.includes('.') ? t('reference', { code }) : null}
    </p>
  );
}

/** A request id that is the same for the same card and the same report: retrying a report is the same report. */
export async function reportId(cardId: string, reason: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`card-report:${cardId}:${reason}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function statusWord(t: Copy, status: CardRecord['status']): string {
  if (status === 'inactive') return t('statusInactive');
  if (status === 'frozen') return t('statusFrozen');
  if (status === 'closed') return t('statusClosed');
  return t('statusActive');
}

/** How many payments a single-use or n-use card has used; read only for a card that has a limit. */
function Uses({ card }: { card: CardRecord }) {
  return card.usesAllowed == null ? null : <UsesOf cardId={card.id} limit={card.usesAllowed} />;
}

function UsesOf({ cardId, limit }: { cardId: string; limit: number }) {
  const { t } = cardOrderCopy.useCopy();
  const uses = useBankRead('cards.uses', { cardId });
  const made = uses.resource.status === 'ready' ? uses.resource.data.usesMade : null;
  return (
    <p className="money-caption" data-testid="card-uses">
      {limit === 1 ? t('singleUseCard') : t('usesCard', { limit: String(limit) })}
      {made !== null && (
        <>
          {' '}
          ·{' '}
          {limit === 1
            ? t('usesMade', { made: String(made), limit: '1' })
            : t('usesMadePlural', { made: String(made), limit: String(limit) })}
        </>
      )}
    </p>
  );
}

const dateOf = (iso: string) =>
  new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
const addressLine = (a: { name: string; line1: string; line2: string | null; city: string; postalCode: string; country: string }) =>
  [a.name, a.line1, a.line2, a.city, a.postalCode, a.country].filter(Boolean).join(', ');

function ChangeAddress({
  cardId,
  current,
  onDone,
  onClose,
}: {
  cardId: string;
  current: Record<string, string>;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = cardOrderCopy.useCopy();
  const { api } = useSession();
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const address = {
      name: draft.name ?? '',
      line1: draft.line1 ?? '',
      ...(draft.line2 ? { line2: draft.line2 } : {}),
      city: draft.city ?? '',
      postalCode: draft.postalCode ?? '',
      country: draft.country ?? '',
    };
    const result = await api.mutate('bank', 'cards.updateShipping', { cardId, requestId, address }, bankWrites['cards.updateShipping']);
    setBusy(false);
    if (!result.ok) return setFailure(result);
    onDone();
  }
  const field = (key: string, label: string) => (
    <Field label={label} value={draft[key] ?? ''} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
  );
  return (
    <Dialog title={t('changeAddress')} onClose={onClose}>
      <form className="form-stack" onSubmit={save} noValidate>
        {field('name', t('name'))}
        {field('line1', t('line1'))}
        {field('line2', t('line2'))}
        {field('city', t('city'))}
        {field('postalCode', t('postalCode'))}
        <Button type="submit" disabled={busy}>
          {t('saveAddress')}
        </Button>
        {failure && <Refusal failure={failure} />}
      </form>
    </Dialog>
  );
}

function Delivery({ card }: { card: CardRecord }) {
  const { t } = cardOrderCopy.useCopy();
  const delivery = useBankRead('cards.delivery', { cardId: card.id });
  const [changing, setChanging] = useState(false);
  if (delivery.resource.status === 'loading') return null;
  if (delivery.resource.status === 'failed') {
    return (
      <section className="form-stack" data-testid="card-delivery">
        <h4 className="bd-subhead">{t('deliveryTitle')}</h4>
        <Refusal failure={delivery.resource.failure} />
      </section>
    );
  }
  const d = delivery.resource.data;
  const speed = d.speed === 'express' ? t('express') : d.speed === 'signed' ? t('signed') : t('standard');
  const state = t(d.state);
  return (
    <section className="form-stack" data-testid="card-delivery" data-state={d.state}>
      <h4 className="bd-subhead">{t('deliveryTitle')}</h4>
      <p>{t('deliveryDesign', { name: d.designName ?? d.designId ?? '' })}</p>
      <p>{t('deliverySpeed', { speed })}</p>
      <p>{t('deliveryState', { state })}</p>
      <p data-testid="card-delivery-estimate">{t('expectedBy', { date: dateOf(d.expectedBy) })}</p>
      <div data-testid="card-tracking" data-code={d.trackingRef ? '' : 'hardware'}>
        <strong>{t('tracking')}</strong>{' '}
        {d.trackingRef ? t('trackingRef', { carrier: d.carrier ?? '', ref: d.trackingRef }) : t('hardware')}
      </div>
      <p data-testid="card-delivery-address">
        {t('deliverTo')}: {addressLine(d.address)}
      </p>
      {d.history.length > 0 && (
        <div data-testid="card-address-history">
          <strong>{t('history')}</strong>
          <ul>
            {d.history.map((h) => (
              <li key={h.changedAt}>
                {addressLine(h.address)} · {dateOf(h.changedAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.status !== 'closed' && (
        <Button variant="secondary" onClick={() => setChanging(true)}>
          {t('changeAddress')}
        </Button>
      )}
      {changing && (
        <ChangeAddress
          cardId={card.id}
          current={{
            name: d.address.name,
            line1: d.address.line1,
            line2: d.address.line2 ?? '',
            city: d.address.city,
            postalCode: d.address.postalCode,
            country: d.address.country,
          }}
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            delivery.reload();
          }}
        />
      )}
    </section>
  );
}

function Activate({ card, onDone, onClose }: { card: CardRecord; onDone: () => void; onClose: () => void }) {
  const { t } = cardOrderCopy.useCopy();
  const { api } = useSession();
  const [failure, setFailure] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  async function activate(stepUpApprovalId: string | null) {
    setBusy(true);
    setFailure(null);
    const result = await api.mutate(
      'bank',
      'cards.activate',
      { cardId: card.id, ...(stepUpApprovalId ? { stepUpApprovalId } : {}) },
      bankWrites['cards.activate'],
    );
    setBusy(false);
    if (!result.ok) return setFailure(result);
    onDone();
  }
  return (
    <Dialog title={t('activate')} onClose={onClose}>
      <StepUpConfirm
        request={() => ({ scope: 'bank.step_up.cards.activate', purpose: 'cards.activate', target: card.id, fields: { cardId: card.id } })}
        words={{
          why: t('activateWhy'),
          code: t('activateCode'),
          codeHint: t('activateHint'),
          codeShort: t('activateShort'),
          noFactor: t('activateNoFactor'),
          sendWithout: t('activateWithout'),
        }}
        disabled={busy}
        onApproved={(id) => void activate(id)}
      />
      {failure && <Refusal failure={failure} />}
    </Dialog>
  );
}

function Report({ card, onDone, onClose }: { card: CardRecord; onDone: (replacementId: string) => void; onClose: () => void }) {
  const { t } = cardOrderCopy.useCopy();
  const { api } = useSession();
  const [reason, setReason] = useState<'lost' | 'stolen'>('lost');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const replacementId = await reportId(card.id, reason);
    const result = await api.mutate('bank', 'cards.replace', { cardId: card.id, replacementId, reason }, bankWrites['cards.replace']);
    setBusy(false);
    if (!result.ok) return setFailure(result);
    onDone(result.data.id);
  }
  return (
    <Dialog title={t('report')} onClose={onClose}>
      <form className="form-stack" onSubmit={send}>
        <p className="muted">{t('reportLead')}</p>
        <fieldset>
          {(['lost', 'stolen'] as const).map((r) => (
            <label key={r} className="choice">
              <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} /> {t(r)}
            </label>
          ))}
        </fieldset>
        <Button type="submit" variant="danger" disabled={busy}>
          {t('reportConfirm')}
        </Button>
        {failure && <Refusal failure={failure} />}
      </form>
    </Dialog>
  );
}

/** The getting-a-card panels for one card in the list. */
export function CardJourney({ card, reload }: { card: CardRecord; reload: () => void }) {
  const { t } = cardOrderCopy.useCopy();
  const [dialog, setDialog] = useState<'activate' | 'report' | null>(null);
  const [replaced, setReplaced] = useState<string | null>(null);
  return (
    <div className="form-stack" data-testid="card-journey">
      <p data-testid="card-status" data-status={card.status}>
        {t('statusLabel', { status: statusWord(t, card.status) })}
      </p>
      <Uses card={card} />
      {card.cardType === 'physical' && <Delivery card={card} />}
      <div className="actions">
        {card.status === 'inactive' && <Button onClick={() => setDialog('activate')}>{t('activate')}</Button>}
        {(card.status === 'active' || card.status === 'inactive' || card.status === 'frozen') && (
          <Button variant="secondary" onClick={() => setDialog('report')}>
            {t('report')}
          </Button>
        )}
      </div>
      {replaced && (
        <p role="status" data-testid="card-report-result" data-card-id={replaced}>
          {t('reported')}
        </p>
      )}
      {dialog === 'activate' && (
        <Activate
          card={card}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      {dialog === 'report' && (
        <Report
          card={card}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            setReplaced(id);
            reload();
          }}
        />
      )}
    </div>
  );
}
