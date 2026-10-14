import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { copyFixture } from '../../../preview/fixtures/copy';

/**
 * PLACEHOLDER for the copy Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the copy fixture, and PreviewActionButton for every action.
 */
export default function CopyPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="copy">
      <PreviewSamplePanel fixture={copyFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.copy.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="copy" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
