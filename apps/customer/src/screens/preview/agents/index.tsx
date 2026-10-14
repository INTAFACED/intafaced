import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { agentsFixture } from '../../../preview/fixtures/agents';

/**
 * PLACEHOLDER for the agents Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the agents fixture, and PreviewActionButton for every action.
 */
export default function AgentsPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="agents">
      <PreviewSamplePanel fixture={agentsFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.agents.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="agents" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
