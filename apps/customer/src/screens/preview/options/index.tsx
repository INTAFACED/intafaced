import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { optionsFixture } from '../../../preview/fixtures/options';

/**
 * PLACEHOLDER for the options Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the options fixture, and PreviewActionButton for every action.
 */
export default function OptionsPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="options">
      <PreviewSamplePanel fixture={optionsFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.options.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="options" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
