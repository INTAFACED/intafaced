import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { futuresFixture } from '../../../preview/fixtures/futures';

/**
 * PLACEHOLDER for the futures Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the futures fixture, and PreviewActionButton for every action.
 */
export default function FuturesPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="futures">
      <PreviewSamplePanel fixture={futuresFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.futures.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="futures" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
