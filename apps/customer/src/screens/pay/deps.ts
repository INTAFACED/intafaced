// The only file in the Pay screen that knows where the shared pieces come from: the kit in @intafaced/ui, the data
// layer in ../../data, and the existing personal-pay client (its mutation guard is the safety layer; UI-SPEC principle 6).
export {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
  CoinIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StateBlock,
  Tabs,
  TabsList,
  TabsTab,
  useToast,
} from '@intafaced/ui';

export { fmtAmount, refusalCopy } from '../../data';
export { dec, str } from '../../data/decimal';
export { fractionDigits } from '../../data/decimal';
export { fetchMe, resolveHandle, cleanHandle, type MeOutcome, type ResolveOutcome } from '../../data/identity';

export { useSession } from '../../features/session/session';
export { createPersonalPayApi, type PersonalPayApi } from '../../features/pay/pay-api';
export { sendInput, spaceSchema } from '../../features/pay/schemas';
export { pendingKey as bankPendingKey, pendingOutcomes } from '../../features/money/pending-outcomes';
export type { ApiClient, ApiResult } from '../../shared/api';
export { navigate } from '../../app/location';
export { isHiddenPath } from '../../app/feature-registry';
