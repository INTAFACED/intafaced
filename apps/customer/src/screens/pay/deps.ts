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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StateBlock,
  Switch,
  Tabs,
  TabsList,
  TabsTab,
  useToast,
  useHideBalances,
  HIDDEN_MASK,
} from '@intafaced/ui';

export { createActivityFeed, fmtAmount, refusalCopy, withDeviceHandles } from '../../data';
export type { ActivityFeed, ActivityItem, Loadable } from '../../data';
export { dec, str } from '../../data/decimal';
export { formatAmount, parseAmount } from '../../shared/money';
export { fractionDigits } from '../../data/decimal';
export { fetchMe, resolveHandle, cleanHandle, type MeOutcome, type ResolveOutcome } from '../../data/identity';
export {
  changeHandle,
  fetchHandleSettings,
  setHandleDiscoverable,
  type HandleChangeCode,
  type HandleSettings,
} from '../../data/handle-settings';

export { useSession } from '../../features/session/session';
export { createPersonalPayApi, type PersonalPayApi } from '../../features/pay/pay-api';
export { sendInput, spaceSchema } from '../../features/pay/schemas';
export { pendingKey as bankPendingKey, pendingOutcomes } from '../../features/money/pending-outcomes';
export { AccountDetailsByCurrency } from '../../features/money/AccountDetails';
export type { ApiClient, ApiResult } from '../../shared/api';
export { navigate } from '../../app/location';
export { isHiddenPath } from '../../app/feature-registry';

export {
  addRequest,
  applyPrefill,
  cleanAmount,
  cleanNote,
  contactLabel,
  contactsFrom,
  NOTE_MAX,
  parseRequestLink,
  parseRequestSearch,
  readRequests,
  readSent,
  receiptText,
  recordSent,
  removeRequest,
  requestPath,
  type Contact,
  type PaymentRequest,
  type RequestEntry,
  type SentEntry,
} from '../../features/pay/personal/personal-model';
export { encodeQr, qrPath } from '../../features/pay/personal/qr';

export { PersonalRoom } from '../../features/pay/personal/rooms/PersonalRoom';
export { personalRoomFor, requestRoomHref } from '../../features/pay/personal/rooms/rooms';
export { confirmWithStepUp } from '../../features/account/security-step-up';
