import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, type ButtonProps } from '@intafaced/ui';
import './preview.css';
import { previewCopy } from './copy';
import { previewProducts, type PreviewProductId } from './products';

interface PreviewSheetApi {
  /** Opens the "Preview: nothing was sent" sheet for this product. */
  open: (product: PreviewProductId) => void;
}
const SheetContext = createContext<PreviewSheetApi | null>(null);

/**
 * Wraps a Preview screen (PreviewScreen does it for you). Owns the one shared "Preview: nothing was sent" sheet. It sends
 * nothing: there is no request in this file, by design (see preview/README.md and preview-isolation.test.ts).
 */
export function PreviewSheetProvider({ children }: { children: ReactNode }) {
  const { t } = previewCopy.useCopy();
  const [product, setProduct] = useState<PreviewProductId | null>(null);
  const open = useCallback((id: PreviewProductId) => setProduct(id), []);
  const api = useMemo(() => ({ open }), [open]);
  return (
    <SheetContext.Provider value={api}>
      {children}
      <Dialog open={product !== null} onOpenChange={(next) => !next && setProduct(null)}>
        <DialogContent className="if-preview-sheet" data-testid="preview-sheet">
          <DialogHeader>
            <DialogTitle>{t('Sheet title')}</DialogTitle>
            <DialogDescription>{t('Sheet body', { product: product ? previewProducts[product].name : '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="primary" size={40} onClick={() => setProduct(null)}>
              {t('OK')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SheetContext.Provider>
  );
}

/** For a trigger that is not a button (a row, a card). Must be inside a PreviewSheetProvider. */
export function usePreviewSheet(): PreviewSheetApi {
  const api = useContext(SheetContext);
  if (!api) throw new Error('usePreviewSheet must be used inside a PreviewSheetProvider (PreviewScreen provides one).');
  return api;
}

/** A button that opens the sheet instead of doing anything. Use it for EVERY action button in a Preview screen. */
export function PreviewActionButton({ product, onClick: _ignored, ...props }: Omit<ButtonProps, 'type'> & { product: PreviewProductId }) {
  const { open } = usePreviewSheet();
  return <Button {...props} type="button" onClick={() => open(product)} />;
}
