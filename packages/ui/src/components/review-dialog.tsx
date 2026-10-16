import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog.js';

/** Controlled review surface. The caller owns dismissal rules and submission lifetime. */
export function ReviewDialog({
  title,
  children,
  onClose,
  closeLabel,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={closeLabel} className="max-h-[calc(100dvh-32px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
