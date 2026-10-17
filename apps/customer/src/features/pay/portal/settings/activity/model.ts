import type { ActivityItem } from '../account/schemas';

/** Where an activity row leads: the page for the thing that changed. Null when nothing has a page of its own. */
export function activityHref(item: Pick<ActivityItem, 'objectType' | 'objectId' | 'action'>): string | null {
  const id = encodeURIComponent(item.objectId);
  switch (item.objectType) {
    case 'payment':
      return `/pay/payments/${id}`;
    case 'dispute':
      return `/pay/disputes/${id}`;
    case 'team':
      return '/pay/team';
    case 'kyb':
      return '/pay/compliance';
    case 'export':
      return '/pay/reports/exports';
    case 'approval':
      return '/pay/approvals';
    case 'webhook':
      return item.action.startsWith('delivery_') ? '/pay/developer/deliveries' : `/pay/developer/webhooks/${id}`;
    default:
      return null;
  }
}

/** "payout_pending" -> "pending", "evidence_added" -> "Evidence added": the verb part of an action, as plain words. */
export function actionWords(objectType: string, action: string): string {
  const prefix = { export: 'export_', approval: 'payout_', webhook: action.startsWith('delivery_') ? 'delivery_' : 'endpoint_' }[
    objectType as 'export' | 'approval' | 'webhook'
  ];
  const bare = prefix && action.startsWith(prefix) ? action.slice(prefix.length) : action;
  const words = bare.replace(/[_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
