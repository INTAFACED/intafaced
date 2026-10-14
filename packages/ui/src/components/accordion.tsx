/*
 * Structure adapted from shadcn/ui (Base UI flavour) `accordion.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/accordion.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); FAQ look: 1 px line between items, plus/chevron rotates, panel height animates.
 */
import * as React from 'react';
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { ChevronDown } from 'lucide-react';
import { cn, focusRing } from './cn.js';

export function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn('flex w-full flex-col', className)} {...props} />;
}

export function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn('border-b border-line', className)} {...props} />;
}

export function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'group flex min-h-14 flex-1 items-center justify-between gap-4 py-4 text-left text-md font-medium text-fg',
          'transition-colors duration-(--if-t-fast) ease-if hover:text-fg-2',
          focusRing,
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-fg-2 transition-transform duration-(--if-t-fast) ease-if group-data-panel-open:rotate-180"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionPanel({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-panel"
      className="h-(--accordion-panel-height) overflow-hidden transition-[height] duration-(--if-t-tab) ease-if data-ending-style:h-0 data-starting-style:h-0"
      {...props}
    >
      <div className={cn('pb-4 text-base text-fg-2', className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { AccordionPanel as AccordionContent };
