import type { ReactNode } from 'react';
import './preview.css';
import { PreviewCaption } from './PreviewCaption';
import { PreviewChip } from './PreviewChip';
import { PreviewSheetProvider } from './PreviewSheet';
import { previewProducts, type PreviewProductId } from './products';

/**
 * The frame every Preview screen sits in: the page title with the Preview chip, the caption, and the shared sheet. Screens
 * draw their own content as `children` and use `PreviewActionButton` for every action.
 */
export function PreviewScreen({ product, children }: { product: PreviewProductId; children: ReactNode }) {
  const { name } = previewProducts[product];
  return (
    <PreviewSheetProvider>
      <div className="if-preview" data-preview-product={product}>
        <header className="if-preview__head">
          <h1 className="if-preview__title">{name}</h1>
          <PreviewChip />
        </header>
        <PreviewCaption />
        {children}
      </div>
    </PreviewSheetProvider>
  );
}
