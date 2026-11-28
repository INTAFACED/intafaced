import type { z } from 'zod';
import type { mandateSchema } from '../../schemas';
import { extensionCopy as c } from './copy';

type Mandate = z.infer<typeof mandateSchema>;

/** Plain words for a charge path and a billing cadence, so no raw service value reaches the screen. */
export const pathLabel = (path: string) =>
  path === 'crypto_invoice'
    ? c.t('cryptoInvoice')
    : path === 'card'
      ? c.t('pathCard')
      : path === 'card_mandate'
        ? c.t('pathCardMandate')
        : path;
export const cadenceLabel = (cadence: Mandate['cadence']) => c.t(`cadence_${cadence}`);
