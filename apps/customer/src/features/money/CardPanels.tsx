import { useRef, useState } from 'react';
import type { z } from 'zod';
import { BrandLockup } from '@intafaced/ui';
import { Button, Field } from '../../shared/ui';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import {
  addressProblems,
  buildIssueInput,
  EMPTY_ADDRESS,
  issuedMatches,
  limitProblem,
  maskedPan,
  orderBlock,
  wireAddress,
  type AddressDraft,
  type CardType,
  type OrderBlock,
  type ProgrammeInfo,
} from './card-controls';
import { CardChannelsPanel, CardLimitsPanel } from './CardSettings';
import { cardDepthCopy } from './card-depth-copy';
import { bps, positiveMoney, type ActionSpec } from './components';
import type { cardSchema } from './contracts';
import { assetSelectField, type HeldAsset } from './holdings';
import { t as copyText } from './copy';
import './bank-depth.css';

type CardRecord = z.infer<typeof cardSchema>;

/** The card as the customer pictures it. Only facts the card service returned are drawn on it. */
export function CardFace({ card }: { card: CardRecord }) {
  const { t } = cardDepthCopy.useCopy();
  const state = card.status === 'frozen' ? t('faceFrozen') : card.status === 'closed' ? t('faceClosed') : t('faceActive');
  return (
    <div
      className="bd-card"
      data-status={card.status}
      data-test={card.simulated ? 'true' : undefined}
      role="img"
      aria-label={`${maskedPan(card.panTail)} ${state}`}
    >
      <div className="bd-card__top">
        <BrandLockup size={24} title="" className="bd-card__brand" />
        <span className="bd-card__state">{card.simulated ? t('faceTest') : state}</span>
      </div>
      <div className="bd-card__pan" lang="zxx" dir="ltr">
        {maskedPan(card.panTail)}
      </div>
      <div className="bd-card__bottom">
        <span>{card.cardType === 'physical' ? t('facePhysical') : t('faceVirtual')}</span>
        <span lang="zxx" dir="ltr">
          {card.assetId ? t('faceFunding', { asset: card.assetId }) : ''}
        </span>
      </div>
    </div>
  );
}

type CopyKey = 'addressName' | 'addressLine1' | 'addressLine2' | 'addressCity' | 'addressRegion' | 'addressPostal' | 'addressCountry';
const ADDRESS_LINES: ReadonlyArray<{ key: keyof AddressDraft; label: CopyKey; optional?: boolean; autoComplete: string }> = [
  { key: 'name', label: 'addressName', autoComplete: 'shipping name' },
  { key: 'line1', label: 'addressLine1', autoComplete: 'shipping address-line1' },
  { key: 'line2', label: 'addressLine2', optional: true, autoComplete: 'shipping address-line2' },
  { key: 'city', label: 'addressCity', autoComplete: 'shipping address-level2' },
  { key: 'region', label: 'addressRegion', optional: true, autoComplete: 'shipping address-level1' },
  { key: 'postalCode', label: 'addressPostal', autoComplete: 'shipping postal-code' },
  { key: 'country', label: 'addressCountry', autoComplete: 'shipping country' },
];

/** The delivery address on one line, as the review and the confirmation read it back. */
export function addressLine(address: AddressDraft): string {
  const wire = wireAddress(address);
  return [
    wire.name,
    wire.line1,
    'line2' in wire ? wire.line2 : '',
    wire.city,
    'region' in wire ? wire.region : '',
    wire.postalCode,
    wire.country,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Order a card: virtual, or physical with a delivery address. Wired to `cards.issue`; blocked with the real reason otherwise. */
type CardCopy = ReturnType<typeof cardDepthCopy.forLocale>;
/** The review for ordering a card: virtual, or physical with the delivery address read back in full. */
export function orderSpec(copy: CardCopy, assets: HeldAsset[], cardType: CardType, address: AddressDraft): ActionSpec {
  const { t } = copy;
  const physical = cardType === 'physical';
  return {
    title: t('orderTitle'),
    procedure: 'cards.issue',
    fields: [
      assetSelectField(t('orderFunding'), t('orderFundingHint'), assets, 'assetId'),
      {
        ...positiveMoney(undefined, 'perAuthorizationLimit', t('orderLimit')),
        hint: undefined,
        validate: (value) => (limitProblem(value) ? copyText('components.enter.an.exact.decimal.amount.greater.than') : null),
      },
    ],
    facts: [
      [t('factCardType'), physical ? t('orderPhysical') : t('orderVirtual')],
      ...(physical ? [[t('factDeliverTo'), addressLine(address)] as [string, string]] : []),
    ],
    notes: [t('orderLead'), t('orderNote'), ...(physical ? [t('orderPhysicalNote')] : [])],
    submit: t('orderButton'),
    // The request id is the card id: ordering the same card again returns the same card, never a second one.
    input: (values, requestId) => buildIssueInput(requestId, { ...values, cardType, address }),
    verifyOutcome: issuedMatches,
  };
}

export function OrderCard({
  open,
  programme,
  assets,
}: {
  open: (spec: ActionSpec) => void;
  programme: ProgrammeInfo | undefined;
  assets: HeldAsset[] | undefined;
}) {
  const copy = cardDepthCopy.useCopy();
  const { t } = copy;
  const block = orderBlock(programme, assets?.length);
  const [cardType, setCardType] = useState<CardType>('virtual');
  const [address, setAddress] = useState<AddressDraft>(EMPTY_ADDRESS);
  const [checked, setChecked] = useState(false);
  const form = useRef<HTMLFieldSetElement>(null);
  const problems = cardType === 'physical' ? addressProblems(address) : {};
  const reason =
    block === 'loading'
      ? t('blockLoading')
      : block === 'none'
        ? t('blockNone')
        : block === 'simulated'
          ? t('blockSimulated')
          : block === 'noAssets'
            ? t('blockNoAssets')
            : null;
  const order = () => {
    if (block !== null || !assets) return;
    if (Object.keys(problems).length > 0) {
      setChecked(true);
      // After the errors have rendered, move to the first line that needs fixing.
      setTimeout(() => form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    open(orderSpec(copy, assets, cardType, address));
  };
  return (
    <DepthPanel title={t('orderTitle')} lead={t('orderLead')} id="order-card">
      <div className="bd-choice-row" role="radiogroup" aria-label={t('orderType')}>
        {(['virtual', 'physical'] as const).map((type) => (
          <label key={type} className={`bd-choice ${cardType === type ? 'bd-choice--on' : ''}`}>
            <input
              type="radio"
              name="card-type"
              value={type}
              checked={cardType === type}
              onChange={() => {
                setCardType(type);
                setChecked(false);
              }}
            />
            <strong>{type === 'virtual' ? t('orderVirtual') : t('orderPhysical')}</strong>
            <span className="money-caption">{type === 'virtual' ? t('orderVirtualBody') : t('orderPhysicalBody')}</span>
          </label>
        ))}
      </div>
      {cardType === 'physical' && (
        <fieldset className="bd-address" ref={form} disabled={block !== null}>
          <legend className="bd-subhead">{t('addressTitle')}</legend>
          {ADDRESS_LINES.map(({ key, label, optional, autoComplete }) => {
            const problem = checked ? (problems[key] as 'required' | 'country' | undefined) : undefined;
            return (
              <Field
                key={key}
                name={key}
                label={t(label)}
                value={address[key]}
                required={!optional}
                autoComplete={autoComplete}
                autoCapitalize={key === 'country' ? 'characters' : undefined}
                maxLength={key === 'country' ? 2 : undefined}
                hint={key === 'country' ? t('addressCountryHint') : undefined}
                error={problem ? (problem === 'country' ? t('addressCountryInvalid') : t('addressRequired')) : undefined}
                onChange={(event) => setAddress({ ...address, [key]: event.target.value })}
              />
            );
          })}
          <p className="money-caption">{t('orderPhysicalNote')}</p>
        </fieldset>
      )}
      <div className="actions">
        <Button onClick={order} disabled={block !== null} aria-describedby={reason ? 'order-card-why' : undefined}>
          {t('orderButton')}
        </Button>
      </div>
      {reason && (
        <p id="order-card-why" className="money-caption" role="status">
          {reason}
        </p>
      )}
    </DepthPanel>
  );
}

/** Everything else a card owner expects, laid out in full. Limits and channels are live; the rest says why it cannot be used. */
export function CardControlPanels({
  card,
  orderBlock: blocked = null,
  open,
}: {
  card: CardRecord;
  orderBlock?: OrderBlock;
  open: (spec: ActionSpec) => void;
}) {
  const { t } = cardDepthCopy.useCopy();
  return (
    <div className="bd-grid" data-card={card.id}>
      <CardLimitsPanel card={card} open={open} />
      <CardChannelsPanel card={card} open={open} />
      <DepthPanel title={t('detailsTitle')}>
        <dl className="bd-facts">
          <Fact label={t('lastFour')}>
            <span lang="zxx" dir="ltr">
              {maskedPan(card.panTail)}
            </span>
          </Fact>
          <Fact label={t('fundingLabel')}>
            <span lang="zxx" dir="ltr">
              {card.assetId || '—'}
            </span>
          </Fact>
          <Fact label={t('factCardType')}>{card.cardType === 'physical' ? t('orderPhysical') : t('orderVirtual')}</Fact>
          {card.shippingAddress && (
            <Fact label={t('factDeliverTo')}>
              {[
                card.shippingAddress.name,
                card.shippingAddress.line1,
                card.shippingAddress.line2,
                card.shippingAddress.city,
                card.shippingAddress.region,
                card.shippingAddress.postalCode,
                card.shippingAddress.country,
              ]
                .filter(Boolean)
                .join(', ')}
            </Fact>
          )}
          <Fact label={t('rewardsRate')}>{card.cashbackBps > 0 ? bps(card.cashbackBps) : t('rewardsRateNone')}</Fact>
        </dl>
        <DisabledAction label={t('detailsShow')} reason={t('detailsReason')} />
      </DepthPanel>
      <DepthPanel title={t('pinTitle')}>
        <div className="actions">
          <DisabledAction label={t('pinView')} reason={t('pinReason')} />
          <DisabledAction label={t('pinChange')} reason={t('pinReason')} />
        </div>
      </DepthPanel>
      <DepthPanel title={t('walletTitle')}>
        <div className="actions">
          <DisabledAction label={t('walletApple')} reason={t('walletReason')} />
          <DisabledAction label={t('walletGoogle')} reason={t('walletReason')} />
        </div>
      </DepthPanel>
      <DepthPanel title={t('rewardsTitle')}>
        <dl className="bd-facts">
          <Fact label={t('rewardsBalance')}>{t('disabledBecause')}</Fact>
        </dl>
        <p className="money-caption">{t('rewardsReason')}</p>
      </DepthPanel>
      <DepthPanel title={t('replaceTitle')}>
        <p>{t('replaceBody')}</p>
        {blocked ? (
          <DisabledAction
            label={t('orderButton')}
            reason={
              blocked === 'loading'
                ? t('blockLoading')
                : blocked === 'none'
                  ? t('blockNone')
                  : blocked === 'simulated'
                    ? t('blockSimulated')
                    : t('blockNoAssets')
            }
          />
        ) : (
          <a className="button button--secondary" href="#order-card">
            {t('orderButton')}
          </a>
        )}
      </DepthPanel>
    </div>
  );
}
