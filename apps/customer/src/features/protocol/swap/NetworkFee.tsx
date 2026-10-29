import type { ProtocolSwapFees } from '@intafaced/contracts/protocol-swap';
import { Failure, Field } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import type { Resource } from '../../../shared/resource';
import { swapCopy } from './copy';
import { FEE_LEVELS, toGwei, type ChosenFee, type FeeChoice } from './fee';

/** Why the chosen fee cannot be used, in a sentence, or null. A blank custom fee is not an alert, only a reason. */
export function feeRefusal(
  fees: ProtocolSwapFees | null,
  chosen: ChosenFee | null,
  customText: string,
  language: Parameters<typeof swapCopy.forLocale>[0],
): string | null {
  const { t } = swapCopy.forLocale(language);
  if (!fees || !chosen || chosen.ok) return null;
  if (chosen.reason === 'over_cap') return t('feeOverCap', { cap: toGwei(BigInt(fees.feeCapWei)) });
  if (chosen.reason === 'under_base') return t('feeUnderBase', { base: toGwei(BigInt(fees.baseFeePerGasWei)) });
  return customText.trim() === '' ? null : t('feeCustomInvalid');
}

/**
 * The swap form's "Network fee" choice (D-swap-11): Slow, Normal and Fast as the service read them from the last blocks,
 * or a custom most per gas, and who pays. The radios are always there; while the levels are read, or when they are
 * refused, each says so and the refusal is shown in words.
 */
export function NetworkFee({
  fees,
  retry,
  choice,
  onChoice,
  custom,
  onCustom,
  refusal,
}: {
  fees: Resource<ProtocolSwapFees>;
  retry: () => void;
  choice: FeeChoice;
  onChoice: (choice: FeeChoice) => void;
  custom: string;
  onCustom: (text: string) => void;
  refusal: string | null;
}) {
  const { language } = usePreferences();
  const { t } = swapCopy.forLocale(language);
  const ready = fees.status === 'ready' ? fees.data : null;
  const time = ready ? new Date(ready.asOf).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  return (
    <div data-swap-fee>
      <div role="radiogroup" aria-label={t('networkFee')} className="protocol-actions">
        {[...FEE_LEVELS, 'custom' as const].map((entry) => {
          const level = ready && entry !== 'custom' ? ready.levels[entry] : null;
          const hint =
            entry === 'custom'
              ? t('feeCustomHint')
              : level
                ? t('feeLevelHint', {
                    max: toGwei(BigInt(level.maxFeePerGasWei)),
                    priority: toGwei(BigInt(level.maxPriorityFeePerGasWei)),
                  })
                : fees.status === 'failed'
                  ? t('feeNotRead')
                  : t('feeReading');
          return (
            <label key={entry} className="field field--check">
              <input type="radio" name="swap-fee" value={entry} checked={choice === entry} onChange={() => onChoice(entry)} />
              <span>{t(`fee_${entry}`)}</span> <small className="muted numeric">{hint}</small>
            </label>
          );
        })}
      </div>
      {choice === 'custom' && (
        <Field
          label={t('customFee')}
          hint={
            ready
              ? t('customFeeHint', { cap: toGwei(BigInt(ready.feeCapWei)), base: toGwei(BigInt(ready.baseFeePerGasWei)) })
              : t('feeLoading')
          }
          inputMode="decimal"
          value={custom}
          autoComplete="off"
          onChange={(event) => onCustom(event.target.value)}
        />
      )}
      {fees.status === 'failed' && <Failure result={fees.failure} retry={retry} />}
      {ready && <p className="muted">{t('feeFrom', { blocks: String(ready.blocks), asOf: time })}</p>}
      {refusal && <p role="alert">{refusal}</p>}
      {ready && <p data-testid="fee-line">{ready.sponsored ? t('feeSponsored') : t('feePaid')}</p>}
    </div>
  );
}
