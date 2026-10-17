import { supportEmail } from './support-desk';

/** The one place the support address is read. Set `VITE_SUPPORT_EMAIL` at build time to change it; the fallback is in support-desk.ts. */
export const SUPPORT_EMAIL: string = supportEmail(import.meta.env.VITE_SUPPORT_EMAIL as string | undefined);
