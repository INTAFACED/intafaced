// The only file in this screen that knows where the shared pieces come from: the kit in @intafaced/ui, the data layer in
// ../../data and the feature registry (same arrangement as screens/home/deps.ts and screens/money/deps.ts).
export {
  Button,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Switch,
  Tabs,
  TabsList,
  TabsTab,
  StateBlock,
  StatusTag,
} from '@intafaced/ui';
export { refusalCopy, useDataEnv, useSource } from '../../data';
export type { Loadable } from '../../data';
export { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
export { navigate } from '../../app/location';
