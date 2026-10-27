import { z } from 'zod';
import { SUPPORT_CUSTOMER_PROPERTIES } from '@intafaced/contracts';

/** `priority,type`, a subset, or `none` (an empty list); blank is undefined. Anything else fails the boot. */
export const supportCustomerSeesEnv = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'none' ? [] : v.split(',').map((part) => part.trim())))
    .pipe(z.array(z.enum(SUPPORT_CUSTOMER_PROPERTIES)).optional()),
);
