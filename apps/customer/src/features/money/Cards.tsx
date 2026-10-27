import { useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { Button } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { currentOwnerRecord, ReportedTime, useBankView } from './bank-context';
import { cardCopy } from './card-copy';
import { bps, Continuation, funds, ResourceView, Section, useBankRead, usePageLimit, type ActionSpec } from './components';
import type { bankReads, cardSchema } from './contracts';
import { t as copyText, Text } from './copy';
import { CardControlPanels, CardFace, OrderCard } from './CardPanels';
import { maskedPan, orderBlock, type OrderBlock } from './card-controls';
import { useHoldings } from './holdings';
import { useSession } from '../session/session';

type CardRecord = z.infer<typeof cardSchema>;
type CardDecision = z.infer<(typeof bankReads)['cards.authorizations']>[number];

export function CardReference({ id }: { id: string }) {
  const { Copy } = cardCopy.useCopy();
  return (
    <details className="money-card-details">
      <summary>
        <Copy k="details" />
      </summary>
      <dl data-testid="money-card-reference" className="money-card-reference">
        <dt>
          <Copy k="reference" />
        </dt>
        <dd lang="zxx" dir="ltr">
          {id}
        </dd>
      </dl>
    </details>
  );
}

function CardIdentity({ card }: { card: CardRecord }) {
  const { Copy } = cardCopy.useCopy();
  return (
    <div data-testid="money-card-identity" className="money-card-identity">
      <CardFace card={card} />
      <h3>
        <Text k={card.simulated ? 'rooms.simulation.record' : 'rooms.card'} /> ·{' '}
        <bdi lang="zxx" dir="ltr">
          {card.panTail}
        </bdi>{' '}
        ·{' '}
        <bdi lang="und" dir="auto">
          {card.status}
        </bdi>
      </h3>
      <CardReference id={card.id} />
      <p className="money-caption">
        <Copy k="issuer" />:{' '}
        <bdi lang="und" dir="auto">
          {card.issuer}
        </bdi>
        {card.simulated && <Text k="rooms.not.a.live.card" />}
      </p>
      <dl className="money-card-assets">
        <div>
          <dt>
            <Copy k="funding" />
          </dt>
          <dd lang="zxx" dir="ltr">
            {card.assetId || <Copy k="assetUnavailable" />}
          </dd>
        </div>
        <div>
          <dt>
            <Copy k="settlement" />
          </dt>
          <dd lang="zxx" dir="ltr">
            {card.settlementAssetId || <Copy k="assetUnavailable" />}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function CardQuantity({ value, asset }: { value: string; asset: string }) {
  const { Copy } = cardCopy.useCopy();
  return asset.trim() ? (
    <span className="money-card-quantity" lang="zxx" dir="ltr">
      <span className="numeric">{funds(value, '').trimEnd()}</span>
      <span className="money-caption">{asset}</span>
    </span>
  ) : (
    <Copy k="assetUnavailable" />
  );
}

function CardConfiguration({ card, expanded = false }: { card: CardRecord; expanded?: boolean }) {
  const { Copy } = cardCopy.useCopy();
  return (
    <details data-testid="money-card-configuration" className="money-card-configuration" open={expanded}>
      <summary>
        <Copy k="configured" />
      </summary>
      <dl>
        <div>
          <dt>
            <Copy k="limit" />
          </dt>
          <dd>
            <CardQuantity value={card.perAuthorizationLimit} asset={card.assetId} />
          </dd>
        </div>
        <div>
          <dt>
            <Copy k="cashback" />
          </dt>
          <dd lang="zxx" dir="ltr">
            {bps(card.cashbackBps)}
          </dd>
        </div>
      </dl>
    </details>
  );
}

export function CardActions({
  card,
  programme,
  disabled,
  open,
}: {
  card: CardRecord;
  /** What the card service says its programme is. Only a card that belongs to that programme can be frozen or closed. */
  programme: { id: string; simulated: boolean } | null | undefined;
  disabled?: boolean;
  open: (spec: ActionSpec) => void;
}) {
  const current = useBankView();
  const { Copy, t } = cardCopy.useCopy();
  // A card from another issuer (or a live card under the simulation label) is never changed from here: the programme
  // would only update this record while the real issuer keeps approving payments.
  const changeable = !!programme && programme.id !== 'none' && card.issuer === programme.id && card.simulated === programme.simulated;
  const protect = (spec: ActionSpec) => {
    if (!disabled && changeable && card.status !== 'closed' && current() && !document.querySelector('[role="dialog"]')) open(spec);
  };
  if (card.status === 'closed' || !changeable)
    return (
      <p className="money-caption">
        <Copy k={card.status === 'closed' ? 'closedNote' : 'noProgrammeNote'} />
      </p>
    );
  // The review shows the card by its last four digits, never its reference.
  const cardFact: [string, string] = [copyText('rooms.card'), maskedPan(card.panTail)];
  const verifyOutcome: ActionSpec['verifyOutcome'] = (data, input) =>
    !!data &&
    typeof data === 'object' &&
    'id' in data &&
    typeof data.id === 'string' &&
    typeof input.cardId === 'string' &&
    data.id.toLowerCase() === input.cardId.toLowerCase() &&
    'status' in data &&
    data.status === input.status;
  return (
    <div className="actions">
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          protect({
            title: card.status === 'frozen' ? copyText('rooms.unfreeze.card') : copyText('rooms.freeze.card'),
            procedure: 'cards.setStatus',
            facts: [cardFact, [copyText('rooms.funding.asset'), card.assetId]],
            notes: [
              card.simulated
                ? t(card.status === 'frozen' ? 'simUnfreeze' : 'simFreeze')
                : card.status === 'frozen'
                  ? copyText('rooms.resume.issuer.use.of.this.existing.card')
                  : copyText('rooms.ask.the.issuer.to.freeze.this.existing'),
            ],
            input: () => ({ cardId: card.id, status: card.status === 'frozen' ? 'active' : 'frozen' }),
            verifyOutcome,
          })
        }
      >
        {card.status === 'frozen' ? copyText('rooms.unfreeze') : copyText('rooms.freeze')}
      </Button>
      <Button
        variant="ghost"
        disabled={disabled}
        onClick={() =>
          protect({
            title: copyText('rooms.close.card'),
            procedure: 'cards.setStatus',
            facts: [cardFact],
            notes: [card.simulated ? t('simClose') : copyText('rooms.close.this.card.this.action.does.not')],
            input: () => ({ cardId: card.id, status: 'closed' }),
            verifyOutcome,
          })
        }
      >
        <Text k="rooms.close.card" />
      </Button>
    </div>
  );
}

function Decision({ row, asset }: { row: CardDecision; asset: string }) {
  const { Copy } = cardCopy.useCopy();
  return (
    <article data-testid="money-card-decision" className="money-card-decision">
      <header>
        <h4 lang="und" dir="auto">
          {row.decision}
        </h4>
        <dl data-testid="money-card-status" className="money-card-status">
          <dt>
            <Copy k="status" />
          </dt>
          <dd lang="und" dir="auto">
            {row.status || <Copy k="emptyValue" />}
          </dd>
        </dl>
      </header>
      <dl data-testid="money-card-funding" className="money-card-funding">
        <dt className="money-visually-hidden">
          <Copy k="quantity" />
        </dt>
        <dd>
          <CardQuantity value={row.amount} asset={asset} />
        </dd>
      </dl>
      <dl data-testid="money-card-decision-time" className="money-card-decision-time">
        <div>
          <dt className="money-visually-hidden">
            <Copy k="decidedAt" />
          </dt>
          <dd>
            <ReportedTime value={row.decidedAt} />
          </dd>
        </div>
        <div>
          <dt>
            <Copy k="category" />
          </dt>
          <dd lang="und" dir="auto">
            {row.merchantCategory === null ? (
              <Copy k="categoryAbsent" />
            ) : row.merchantCategory === '' ? (
              <Copy k="emptyValue" />
            ) : (
              row.merchantCategory
            )}
          </dd>
        </div>
      </dl>
      <dl data-testid="money-card-authorization" className="money-card-authorization">
        <dt>
          <Copy k="authorization" />
        </dt>
        <dd lang="zxx" dir="ltr">
          {row.authorizationRef === '' ? <Copy k="emptyReference" /> : row.authorizationRef}
        </dd>
      </dl>
      {row.declineCode !== null && (
        <dl data-testid="money-card-decline" className="money-card-decline">
          <dt>
            <Copy k="decline" />
          </dt>
          <dd lang="zxx" dir="ltr">
            {row.declineCode === '' ? <Copy k="emptyValue" /> : row.declineCode}
          </dd>
        </dl>
      )}
      {row.conversion && (
        <div data-testid="money-card-conversion" className="money-card-conversion">
          <h5>
            <Copy k="conversion" />
          </h5>
          <dl>
            <div>
              <dt>
                <Copy k="settlementAmount" />
              </dt>
              <dd>
                <CardQuantity value={row.conversion.settlementAmount} asset={row.conversion.settlementAssetId} />
              </dd>
            </div>
            <div>
              <dt>
                <Copy k="rate" />
              </dt>
              <dd lang="zxx" dir="ltr">
                {asset.trim() && row.conversion.settlementAssetId.trim() ? (
                  `${displayAmount(row.conversion.rate)} ${row.conversion.settlementAssetId} / ${asset}`
                ) : (
                  <Copy k="assetUnavailable" />
                )}
              </dd>
            </div>
            <div>
              <dt>
                <Copy k="quality" />
              </dt>
              <dd lang="und" dir="auto">
                {row.conversion.rateQuality || <Copy k="emptyValue" />}
              </dd>
            </div>
            <div>
              <dt>
                <Copy k="rateTime" />
              </dt>
              <dd>
                <ReportedTime value={row.conversion.rateAsOf} />
              </dd>
            </div>
          </dl>
        </div>
      )}
    </article>
  );
}

function CardRead({
  card,
  programme,
  open,
  refreshCards,
  orderBlocked,
}: {
  card: CardRecord;
  programme: { id: string; simulated: boolean } | null | undefined;
  orderBlocked: OrderBlock;
  open: (spec: ActionSpec) => void;
  refreshCards: () => void;
}) {
  const { Copy, t, languageFor, directionFor } = cardCopy.useCopy();
  const current = useBankView();
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('cards.authorizations', { cardId: card.id, limit });
  const failure = query.resource.status === 'failed' ? query.resource.failure : null;
  const notFound = failure?.status === 400 && failure.code === 'bank.card_not_found';
  const [previouslyMissing, setPreviouslyMissing] = useState(false);
  useLayoutEffect(() => {
    if (notFound) setPreviouslyMissing(true);
    else if (query.resource.status === 'ready') setPreviouslyMissing(false);
  }, [notFound, query.resource.status]);
  const showFacts = !notFound && (!previouslyMissing || query.resource.status === 'ready');
  const retry = () => {
    if (current()) query.reload();
  };
  return (
    <>
      {showFacts ? <CardIdentity card={card} /> : <CardReference id={card.id} />}
      <div
        className="money-card-history"
        role="region"
        aria-label={t('decisions')}
        lang={languageFor('decisions')}
        dir={directionFor('decisions')}
      >
        <header>
          <h3>
            <Copy k="decisions" />
          </h3>
          <p className="money-caption">
            <Copy k="newest" params={{ limit }} />
          </p>
        </header>
        {notFound ? (
          <div className="money-card-missing" role="status">
            <h4>
              <Copy k="notFound" />
            </h4>
            <p>
              <Copy k="notFoundNote" />
            </p>
            <div className="actions">
              <Button onClick={retry}>
                <Copy k="retry" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  if (current()) refreshCards();
                }}
              >
                <Copy k="refreshCards" />
              </Button>
            </div>
            <details>
              <summary>
                <Copy k="serviceDetail" />
              </summary>
              <p lang="und" dir="auto">
                {failure.message}
              </p>
              <code lang="zxx" dir="ltr">
                {failure.code}
              </code>
            </details>
          </div>
        ) : (
          <ResourceView resource={query.resource} reload={retry}>
            {(rows) => (
              <>
                {rows.length ? (
                  <ol className="money-card-decisions">
                    {rows.map((row, index) => (
                      <li key={`${row.id}:${index}`}>
                        <Decision row={row} asset={card.assetId} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="money-card-missing" role="status">
                    <h4>
                      <Copy k="empty" />
                    </h4>
                    <p>
                      <Copy k="emptyNote" />
                    </p>
                  </div>
                )}
                <div className="money-card-continuation">
                  <p className="money-caption">
                    <Copy k="count" params={{ count: rows.length, limit }} />
                  </p>
                  <p className="money-caption">
                    <Copy k="noReceipt" />
                  </p>
                  <p className="money-caption">
                    <Copy k={limit === 200 ? 'cap' : 'window'} />
                  </p>
                  <div className="actions">
                    {rows.length >= limit && limit < 200 && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (current()) setLimit(Math.min(200, limit + 50));
                        }}
                      >
                        <Copy k="more" params={{ limit: Math.min(200, limit + 50) }} />
                      </Button>
                    )}
                    <Button variant="ghost" onClick={retry}>
                      <Copy k="refreshDecisions" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </ResourceView>
        )}
      </div>
      {showFacts && (
        <>
          <CardConfiguration card={card} expanded />
          <CardActions card={card} programme={programme} open={open} />
          <CardControlPanels card={card} orderBlock={orderBlocked} open={open} />
        </>
      )}
    </>
  );
}

const SELECTED_KEY = 'intafaced.customer.bank.card-selected.v1:';
/** The card the customer was looking at, kept for this tab so a confirmed change does not close its card. */
function readSelected(userId: string | null): string | null {
  try {
    const id = userId ? sessionStorage.getItem(SELECTED_KEY + userId) : null;
    return id && currentOwnerRecord([{ id }], id) ? id : null;
  } catch {
    return null;
  }
}
function keepSelected(userId: string | null, id: string | null) {
  try {
    if (!userId) return;
    if (id) sessionStorage.setItem(SELECTED_KEY + userId, id);
    else sessionStorage.removeItem(SELECTED_KEY + userId);
  } catch {
    // The card simply is not remembered.
  }
}

export function OwnerCards({ open }: { open: (spec: ActionSpec) => void }) {
  const { Copy, t, languageFor, directionFor } = cardCopy.useCopy();
  const current = useBankView();
  const [limit, setLimit] = usePageLimit();
  const programme = useBankRead('cards.programme', undefined);
  const query = useBankRead('cards.list', { limit });
  const held = useHoldings();
  const orderProgramme =
    programme.resource.status === 'loading'
      ? undefined
      : programme.resource.status === 'ready'
        ? { id: programme.resource.data.id, simulated: programme.resource.data.simulated }
        : null;
  const orderAssets = held.resource.status === 'ready' ? held.resource.data.assets : held.resource.status === 'failed' ? [] : undefined;
  const ordering = orderBlock(orderProgramme, orderAssets?.length);
  const { userId } = useSession();
  const [selected, choose] = useState<{ id: string; serial: number } | null>(() => {
    const id = readSelected(userId);
    return id ? { id, serial: 1 } : null;
  });
  const setSelected = (next: { id: string; serial: number } | null) => {
    keepSelected(userId, next?.id ?? null);
    choose(next);
  };
  const serial = useRef(selected ? 1 : 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLSpanElement>(null);
  const rows = query.resource.status === 'ready' ? query.resource.data : [];
  const card = selected ? currentOwnerRecord(rows, selected.id) : undefined;
  const other = card ? rows.filter((row) => row.id !== card.id) : rows;
  const refresh = () => {
    if (current()) query.reload();
  };
  const arrive = (element: HTMLElement | null) => {
    if (!current() || document.querySelector('[role="dialog"]')) return;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'start' });
  };
  useLayoutEffect(() => {
    if (selected) arrive(heading.current);
    else if (serial.current) arrive(listHeading.current);
  }, [selected?.serial]);
  return (
    <div data-testid="money-owner-cards" className="money-owner-cards" lang={languageFor('records')} dir={directionFor('records')}>
      <div data-testid="money-card-programme" className="money-card-programme">
        <ResourceView
          resource={programme.resource}
          reload={() => {
            if (current()) programme.reload();
          }}
        >
          {(info) => (
            <>
              <h3 lang={info.id === 'none' ? undefined : 'und'} dir="auto">
                {info.id === 'none' ? <Text k="rooms.card.issuer.is.not.connected" /> : info.displayName}
              </h3>
              {info.id !== 'none' && (
                <p className="money-caption">
                  {info.simulated ? (
                    <Text k="rooms.simulation.programme.it.does.not.issue.a" />
                  ) : (
                    <Text k="rooms.issuer.programme.confirmed.by.the.service" />
                  )}
                </p>
              )}
            </>
          )}
        </ResourceView>
      </div>
      <OrderCard open={open} programme={orderProgramme} assets={orderAssets} />
      {selected && (
        <section data-testid="money-selected-card" className="money-selected-card" aria-labelledby="money-selected-card-heading">
          <header>
            <h2 id="money-selected-card-heading" ref={heading} tabIndex={-1}>
              <Copy k="selected" />
            </h2>
            <Button
              variant="ghost"
              onClick={() => {
                if (current() && !document.querySelector('[role="dialog"]')) setSelected(null);
              }}
            >
              <Copy k="return" />
            </Button>
          </header>
          {!card && <CardReference id={selected.id} />}
          <ResourceView resource={query.resource} reload={refresh}>
            {() =>
              card ? (
                <CardRead
                  key={JSON.stringify([card.id, card.assetId, card.settlementAssetId, selected.serial])}
                  card={card}
                  programme={orderProgramme}
                  open={open}
                  refreshCards={refresh}
                  orderBlocked={ordering}
                />
              ) : (
                <div className="money-card-missing" role="status">
                  <h3>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflict' : 'missing'} />
                  </h3>
                  <p>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflictNote' : 'missingNote'} />
                  </p>
                  <Button variant="secondary" onClick={refresh}>
                    <Copy k="refreshCards" />
                  </Button>
                </div>
              )
            }
          </ResourceView>
        </section>
      )}
      <Section
        title={
          <span id="money-card-list-heading" ref={listHeading} tabIndex={-1}>
            <Copy k={card ? 'other' : 'records'} />
          </span>
        }
        actions={
          <Button variant="ghost" onClick={refresh}>
            <Copy k="refreshCards" />
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={refresh}>
          {() => (
            <>
              {other.length ? (
                other.map((row, index) => (
                  <article data-testid="money-card-record" className="money-card-record" key={`${row.id}:${index}`}>
                    <CardIdentity card={row} />
                    <div className="money-card-record-actions">
                      <Button
                        variant="secondary"
                        aria-label={t('inspect', { reference: row.id })}
                        lang={languageFor('inspect')}
                        dir={directionFor('inspect')}
                        aria-controls="money-selected-card-heading"
                        disabled={!currentOwnerRecord(rows, row.id)}
                        onClick={() => {
                          if (current() && currentOwnerRecord(rows, row.id) === row && !document.querySelector('[role="dialog"]'))
                            setSelected({ id: row.id, serial: ++serial.current });
                        }}
                      >
                        <Text k="rooms.decisions.and.declines" />
                      </Button>
                      <CardActions card={row} programme={orderProgramme} disabled={!currentOwnerRecord(rows, row.id)} open={open} />
                    </div>
                    <CardConfiguration card={row} />
                  </article>
                ))
              ) : (
                <div className="money-card-missing" role="status">
                  <h3>
                    <Copy k={card ? 'noOther' : 'noCards'} />
                  </h3>
                  <p>
                    <Copy k="listWindow" />
                  </p>
                </div>
              )}
              <Continuation
                count={rows.length}
                limit={limit}
                onMore={() => {
                  if (current()) setLimit(Math.min(200, limit + 50));
                }}
              />
              <p className="money-caption">
                <Copy k="listWindow" />
              </p>
            </>
          )}
        </ResourceView>
      </Section>
    </div>
  );
}
