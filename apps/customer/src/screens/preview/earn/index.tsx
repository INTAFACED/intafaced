import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { earnFixture } from '../../../preview/fixtures/earn';

/**
 * PLACEHOLDER for the earn Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the earn fixture, and PreviewActionButton for every action.
 */
export default function EarnPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="earn">
      <PreviewSamplePanel fixture={earnFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.earn.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="earn" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
