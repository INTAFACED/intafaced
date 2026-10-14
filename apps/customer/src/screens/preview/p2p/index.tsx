import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { p2pFixture } from '../../../preview/fixtures/p2p';

/**
 * PLACEHOLDER for the p2p Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the p2p fixture, and PreviewActionButton for every action.
 */
export default function P2pPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="p2p">
      <PreviewSamplePanel fixture={p2pFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.p2p.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="p2p" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
