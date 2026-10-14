import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { ifcFixture } from '../../../preview/fixtures/ifc';

/**
 * PLACEHOLDER for the ifc Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the ifc fixture, and PreviewActionButton for every action.
 */
export default function IfcPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="ifc">
      <PreviewSamplePanel fixture={ifcFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.ifc.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="ifc" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
