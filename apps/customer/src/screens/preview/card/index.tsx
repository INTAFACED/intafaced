import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { cardFixture } from '../../../preview/fixtures/card';

/**
 * PLACEHOLDER for the card Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the card fixture, and PreviewActionButton for every action.
 */
export default function CardPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="card">
      <PreviewSamplePanel fixture={cardFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.card.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="card" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
