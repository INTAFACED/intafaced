'use client';

import type { ReactNode } from 'react';
import { Badge, Page, PageBody, PageHeader, StatusChip } from '@intafaced/ui';
import { DeskNav } from './desk-nav';

/**
 * Frame for every desk room: room switcher, title, a data-freshness chip, and the body.
 * `asOf` is when the data on the page was read; `state` says whether it could be read at all.
 */
export function DeskPage(props: {
  title: string;
  description: string;
  asOf?: string | null;
  state?: 'live' | 'unknown' | 'refused';
  stateReason?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <DeskNav />
      <Page width="full" density="dense" landmark={false}>
        <PageHeader
          title={props.title}
          description={props.description}
          actions={
            <div className="flex items-center gap-3">
              {props.state ? (
                <StatusChip
                  kind={props.state}
                  asOf={props.asOf ?? undefined}
                  showAsOf={props.state === 'live'}
                  reason={props.stateReason}
                  density="dense"
                />
              ) : null}
              <Badge tone="warn" variant="outline" density="dense">
                Operator
              </Badge>
              {props.actions}
            </div>
          }
        />
        <PageBody>{props.children}</PageBody>
      </Page>
    </>
  );
}
