import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { depositFixture } from '../../../preview/fixtures/deposit';

/**
 * PLACEHOLDER for the deposit Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the deposit fixture, and PreviewActionButton for every action.
 */
export default function DepositPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="deposit">
      <PreviewSamplePanel fixture={depositFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.deposit.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="deposit" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
