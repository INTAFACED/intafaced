import { useState } from 'react';
import { ticketCopy } from './copy';
import { ADVANCED_KINDS, FIELDS, type AdvancedKind, type FieldUnit } from './advanced';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
} from './deps';
import type { DeskMarket } from '../market';
import { placesOf } from '../text';
import './ticket.css';

type Words = ReturnType<typeof ticketCopy.useCopy>['t'];

/**
 * LOCAL PLACEHOLDER for the shared Preview kit (branch feat/m4-preview-registry, apps/customer/src/preview/), which had not
 * landed when this was built. Swap these two exports for the kit's chip and sheet; nothing else in the ticket changes.
 */
export function PreviewChip({ className }: { className?: string }) {
  const { t } = ticketCopy.useCopy();
  return (
    <span className={`tk-chip${className ? ` ${className}` : ''}`} title={t('Preview chip label')}>
      {t('Preview')}
    </span>
  );
}

/** "Preview: this order type isn't live yet. Nothing was sent." */
export function NothingSentSheet({ open, typeName, onClose }: { open: boolean; typeName: string; onClose: () => void }) {
  const { t } = ticketCopy.useCopy();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent className="dk-review">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('Sheet title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('Sheet body', { type: typeName })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="primary" size={40} />}>{t('Sheet close')}</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function typeName(kind: AdvancedKind, t: Words): string {
  switch (kind) {
    case 'stop':
      return t('Type stop');
    case 'stop-limit':
      return t('Type stop-limit');
    case 'tp-sl':
      return t('Type tp-sl');
    case 'trailing':
      return t('Type trailing');
    case 'oco':
      return t('Type oco');
    case 'iceberg':
      return t('Type iceberg');
    case 'twap':
      return t('Type twap');
  }
}

export function typeAbout(kind: AdvancedKind, t: Words): string {
  switch (kind) {
    case 'stop':
      return t('About stop');
    case 'stop-limit':
      return t('About stop-limit');
    case 'tp-sl':
      return t('About tp-sl');
    case 'trailing':
      return t('About trailing');
    case 'oco':
      return t('About oco');
    case 'iceberg':
      return t('About iceberg');
    case 'twap':
      return t('About twap');
  }
}

export function fieldLabel(label: (typeof FIELDS)[AdvancedKind][number]['label'], t: Words): string {
  switch (label) {
    case 'Trigger price':
      return t('Trigger price');
    case 'Limit price':
      return t('Limit price');
    case 'Take-profit price':
      return t('Take-profit price');
    case 'Stop-loss price':
      return t('Stop-loss price');
    case 'Stop-limit price':
      return t('Stop-limit price');
    case 'Callback rate':
      return t('Callback rate');
    case 'Activation price':
      return t('Activation price');
    case 'Visible amount':
      return t('Visible amount');
    case 'Duration':
      return t('Duration');
    case 'Slices':
      return t('Slices');
    case 'Amount':
      return t('Amount');
    case 'Price':
      return t('Price');
  }
}

function unitOf(unit: FieldUnit, market: DeskMarket): { text: string; precision: number } {
  switch (unit) {
    case 'quote':
      return { text: market.quote, precision: placesOf(market.tickSize) };
    case 'base':
      return { text: market.base, precision: placesOf(market.lotSize) };
    case 'percent':
      return { text: '%', precision: 2 };
    case 'minutes':
      return { text: 'min', precision: 0 };
    case 'count':
      return { text: '', precision: 0 };
  }
}

function PreviewSide({
  kind,
  side,
  market,
  onSubmit,
}: {
  kind: AdvancedKind;
  side: 'buy' | 'sell';
  market: DeskMarket;
  onSubmit: () => void;
}) {
  const { t } = ticketCopy.useCopy();
  // What is typed here stays here: it is not read by anything and nothing is built from it.
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form
      className="dk-form"
      data-side={side}
      aria-label={t('Preview form', { side: side === 'buy' ? t('Buy') : t('Sell'), type: typeName(kind, t) })}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {FIELDS[kind].map((field) => {
        const unit = unitOf(field.unit, market);
        return (
          <AmountInput
            key={field.key}
            label={fieldLabel(field.label, t)}
            aria-label={fieldLabel(field.label, t)}
            value={values[field.key] ?? ''}
            onValueChange={(next) => setValues((current) => ({ ...current, [field.key]: next }))}
            precision={unit.precision}
            unit={unit.text || undefined}
            placeholder="0"
          />
        );
      })}
      <Button type="submit" variant={side} shape="rounded" size={40} fullWidth>
        {side === 'buy' ? t('Preview buy button', { asset: market.base }) : t('Preview sell button', { asset: market.base })}
      </Button>
    </form>
  );
}

/** A not-yet-live order type: the form, a Preview chip, and a submit that only opens the "nothing was sent" sheet. */
export function PreviewTicket({ kind, market }: { kind: AdvancedKind; market: DeskMarket }) {
  const { t } = ticketCopy.useCopy();
  const [sheet, setSheet] = useState(false);
  return (
    <div className="tk-preview" data-kind={kind}>
      <p className="tk-preview-caption">
        <PreviewChip /> <span>{typeAbout(kind, t)}</span> <span>{t('Preview caption')}</span>
      </p>
      <div className="dk-forms">
        <PreviewSide kind={kind} side="buy" market={market} onSubmit={() => setSheet(true)} />
        <PreviewSide kind={kind} side="sell" market={market} onSubmit={() => setSheet(true)} />
      </div>
      <NothingSentSheet open={sheet} typeName={typeName(kind, t)} onClose={() => setSheet(false)} />
    </div>
  );
}

export { ADVANCED_KINDS };
