import { useEffect, type RefObject } from 'react';

/**
 * Opens a native `<dialog>` as a modal while the component that draws it is mounted, and gives focus back to whatever held
 * it before when it goes: the focus kept in step with the dialog, for every modal the app draws.
 */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, [ref]);
}
