'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusTag,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@intafaced/ui';
import { UiScope } from './ui-scope';

const OWNERS = { both: 'Both founders', nitro: 'Nitro', phantom: 'Phantom' } as const;

/**
 * Internal smoke sheet: one of each kit part the new CRM screens will use, themed by `ui-kit.css`. Mounted on no
 * page. It exists so a test can prove the kit renders inside the console, and so a throwaway route can be pointed at it
 * to look at the theme. Labels are placeholder text, not CRM data. The kit has no "Badge"; `StatusTag` is its pill.
 */
export function UiSmoke() {
  return (
    <UiScope className="flex flex-col gap-4 p-6" aria-label="UI kit smoke sheet" role="region">
      <TooltipProvider>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary" size={32}>
            Secondary
          </Button>
          <Button variant="ghost" size={32}>
            Ghost
          </Button>
          <StatusTag status="filled" label="Replied" />
          <StatusTag status="pending" label="Waiting on us" />
          <StatusTag status="failed" label="Overdue" />
        </div>

        <Tabs defaultValue="investors">
          <TabsList divider>
            <TabsTab value="investors">Investors</TabsTab>
            <TabsTab value="everyone">Everyone else</TabsTab>
            <TabsTab value="mine">Mine</TabsTab>
          </TabsList>
          <TabsPanel value="investors" className="py-3 text-sm text-fg-2">
            Investors panel
          </TabsPanel>
          <TabsPanel value="everyone" className="py-3 text-sm text-fg-2">
            Everyone else panel
          </TabsPanel>
          <TabsPanel value="mine" className="py-3 text-sm text-fg-2">
            Mine panel
          </TabsPanel>
        </Tabs>

        <div className="flex flex-wrap items-center gap-3">
          <Menu>
            <MenuTrigger render={<Button variant="secondary" size={32} />}>Actions</MenuTrigger>
            <MenuContent>
              <MenuGroup>
                <MenuLabel>Hand over</MenuLabel>
                <MenuItem>Hand to Phantom</MenuItem>
                <MenuItem>Hand to Nitro</MenuItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuItem>Export</MenuItem>
            </MenuContent>
          </Menu>

          <Select items={OWNERS} defaultValue="both">
            <SelectTrigger size={32} className="w-44" aria-label="Owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(OWNERS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Dialog>
            <DialogTrigger render={<Button variant="secondary" size={32} />}>Dialog</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Decline this enquiry</DialogTitle>
                <DialogDescription>Smoke-sheet text. Nothing here is saved or sent.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="primary" size={32}>
                  Confirm
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size={32} />}>Hover or focus me</TooltipTrigger>
            <TooltipContent>Help text sits on a raised surface.</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </UiScope>
  );
}
