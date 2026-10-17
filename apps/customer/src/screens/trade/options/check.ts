import { useCallback, useState } from 'react';
import { useDeskApi, useRefreshPrivate } from '../desk/data';
import { roomWords } from '../rooms/refusals';
import type { RoomWriter } from '../rooms/write';
import { optionsCopy } from './copy';

/**
 * "Check status" for an unconfirmed request: read the original from the service, and drop the device note only when
 * the service proves what happened. A place is looked up by its client order id; a cancel by the order id itself.
 * Nothing here sends the request again.
 */
export function useCheckStatus(writer: RoomWriter, fallbackSymbol: string | null) {
  const { t } = optionsCopy.useCopy();
  const api = useDeskApi();
  const refresh = useRefreshPrivate();
  const [note, setNote] = useState<string | null>(null);

  const check = useCallback(
    async (id: string) => {
      const pending = writer.note.state === 'pending' ? writer.note.pending : null;
      const symbol = pending?.symbol ?? fallbackSymbol;
      if (!symbol) return setNote(t('Check no market'));
      const kind = pending?.kind ?? 'place';
      if (kind !== 'place' && kind !== 'cancel') return setNote(t('Check in another room'));
      setNote(t('Checking'));
      const result = kind === 'cancel' ? await api.order({ id, symbol }) : await api.reconcile(id, symbol);
      if (result.ok) {
        writer.resolve(id);
        refresh();
        return setNote(t('Checked order', { status: result.data.status }));
      }
      const words = roomWords({ reason: result.reason, message: result.message, code: result.code });
      setNote(`${words.title}. ${words.body}`);
    },
    [api, fallbackSymbol, refresh, t, writer],
  );
  return { check, note };
}
