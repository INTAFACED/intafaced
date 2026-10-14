import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { withdrawFixture } from '../../../preview/fixtures/withdraw';

/**
 * PLACEHOLDER for the withdraw Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the withdraw fixture, and PreviewActionButton for every action.
 */
export default function WithdrawPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="withdraw">
      <PreviewSamplePanel fixture={withdrawFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.withdraw.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="withdraw" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
