'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `checkbox.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/checkbox.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); lime when checked, near-black tick.
 */
import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Check, Minus } from 'lucide-react';
import { cn, focusRing } from './cn.js';

/** 20 px box. Wrap it with its text in a `<label>` so the whole row is the hit area. */
export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-xs border border-line-strong bg-field text-on-lime',
        'transition-colors duration-(--if-t-fast) ease-if hover:bg-raised',
        'data-checked:border-lime data-checked:bg-lime data-indeterminate:border-lime data-indeterminate:bg-lime',
        'data-disabled:cursor-not-allowed data-disabled:opacity-40',
        focusRing,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="inline-flex data-unchecked:hidden">
        {props.indeterminate ? (
          <Minus size={14} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Check size={14} strokeWidth={2.5} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
