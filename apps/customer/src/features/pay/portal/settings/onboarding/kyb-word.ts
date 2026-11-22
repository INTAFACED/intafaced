import type { portalCopy } from '../copy';

/** The business check's status in the portal's words; a status the portal has not met is shown as the service sent it. */
export const kybWord = (status: string, t: ReturnType<typeof portalCopy.useCopy>['t']) =>
  status === 'none'
    ? t('chipKyb_none')
    : status === 'pending'
      ? t('chipKyb_pending')
      : status === 'approved'
        ? t('chipKyb_approved')
        : status === 'rejected'
          ? t('chipKyb_rejected')
          : status;
