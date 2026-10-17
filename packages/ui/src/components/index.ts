/** Public surface of the redesign UI kit. `../index.ts` re-exports this barrel. */
export { cn } from './cn.js';
export { Wordmark } from './wordmark.js';
export { Button, buttonVariants, type ButtonProps } from './button.js';
export { Tabs, TabsList, TabsTab, TabsPanel, TabsTrigger, TabsContent, type TabsListProps } from './tabs.js';
export { ToggleGroup, ToggleGroupItem, type ToggleGroupProps, type ToggleGroupVariant } from './toggle-group.js';
export { SegmentedControl, type SegmentedControlProps, type SegmentedItem } from './segmented.js';
export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuItem,
  MenuLinkItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from './menu.js';
export { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription, PopoverClose } from './popover.js';
export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
  NavigationMenuCard,
  type NavigationMenuCardProps,
} from './navigation-menu.js';
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog.js';
export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from './alert-dialog.js';
export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './tooltip.js';
export { ToastProvider, useToast, type ToastOptions } from './toast.js';
export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator } from './select.js';
export {
  Autocomplete,
  AutocompleteInput,
  AutocompleteContent,
  AutocompleteList,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteItem,
  AutocompleteEmpty,
  type AutocompleteInputProps,
} from './autocomplete.js';
export { Checkbox } from './checkbox.js';
export { Switch } from './switch.js';
export { Collapsible, CollapsibleTrigger, CollapsiblePanel, CollapsibleContent } from './collapsible.js';
export { Accordion, AccordionItem, AccordionTrigger, AccordionPanel, AccordionContent } from './accordion.js';
export { Skeleton, type SkeletonProps } from './skeleton.js';
export {
  Money,
  Amount,
  Price,
  Pct,
  ChangeText,
  HideBalancesProvider,
  useHideBalances,
  signDirection,
  UNKNOWN,
  HIDDEN_MASK,
  type Direction,
  type PctProps,
  type ChangeTextProps,
} from './numbers.js';
export { HeroNumber, type HeroNumberProps } from './hero-number.js';
export { Sparkline, sparklineGeometry, thinSeries, type SparklineProps, type SparklineGeometry } from './sparkline.js';
export { CoinIcon, hasCoinArt, type CoinIconProps } from './coin-icon.js';
export { StatusTag, type StatusKind, type StatusTagProps } from './status-tag.js';
export { StateBlock, type StateBlockProps, type StateAction } from './state-block.js';
export { AmountInput, type AmountInputProps } from './amount-input.js';
export {
  parseTyped,
  parsePasted,
  stepDecimal,
  roundDecimal,
  decimalsOf,
  isCompleteAmount,
  isPositiveAmount,
  type DecimalSeparator,
} from './amount-input-logic.js';

/* Shared screen kit (feat/ui-kit-core): the parts every customer screen builds from. See docs/ui-kit.md. */
export { type Density } from './density.js';
export { Table, type TableProps, type TableColumn, type TableLabels } from './table.js';
export { sortRows, nextSort, compareDecimal, type SortState, type SortDirection, type SortType } from './table-logic.js';
export { Input, type InputProps, type TextInputProps, type DecimalInputProps } from './input.js';
export { Field, useFieldContext, type FieldProps } from './field.js';
export { Page, PageHeader, PageBody, PageSection, Breadcrumbs } from './page.js';
export type { PageProps, PageWidth, PageHeaderProps, PageBodyProps, PageSectionProps, BreadcrumbsProps, BreadcrumbItem } from './page.js';
export { EmptyState, type EmptyStateProps, type EmptyStateAction, type EmptyStateVariant, type EmptyStateSize } from './empty-state.js';
export { Stat, type StatProps, type StatSize } from './stat.js';
export { KeyValue, type KeyValueProps, type KeyValueItem } from './key-value.js';
export { Badge, type BadgeProps, type BadgeTone, type BadgeVariant } from './badge.js';
export { StatusChip, type StatusChipProps } from './status-chip.js';
export { freshnessOf, formatAsOf, msUntilFreshnessChange, type Freshness, type FreshnessInput } from './freshness.js';
export { useFreshnessClock, type UseFreshnessClockOptions } from './use-freshness-clock.js';

/* Pay portal components (feat/pay-portal-nav-options). */
export { DataTable } from './data-table.js';
export { ChoiceGroup } from './choice-group.js';
export { ReviewDialog } from './review-dialog.js';
