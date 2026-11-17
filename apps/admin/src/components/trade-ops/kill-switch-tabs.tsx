'use client';

import type { ReactNode } from 'react';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@intafaced/ui';

/** The kill switch room's two scopes: the whole trade module, and copy and bots by lead, bot type or symbol (CB-ops-03). */
export function KillSwitchTabs({
  trade,
  copyBots,
  initialTab = 'trade',
}: {
  trade: ReactNode;
  copyBots: ReactNode;
  initialTab?: 'trade' | 'copy-bots';
}) {
  return (
    <Tabs defaultValue={initialTab}>
      <TabsList divider>
        <TabsTab value="trade">Trade module</TabsTab>
        <TabsTab value="copy-bots">Copy and bots</TabsTab>
      </TabsList>
      <TabsPanel value="trade" className="pt-4">
        {trade}
      </TabsPanel>
      <TabsPanel value="copy-bots" className="pt-4">
        {copyBots}
      </TabsPanel>
    </Tabs>
  );
}
