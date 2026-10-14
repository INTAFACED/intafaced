import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { botsFixture } from '../../../preview/fixtures/bots';

/**
 * PLACEHOLDER for the bots Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the bots fixture, and PreviewActionButton for every action.
 */
export default function BotsPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="bots">
      <PreviewSamplePanel fixture={botsFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.bots.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="bots" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
