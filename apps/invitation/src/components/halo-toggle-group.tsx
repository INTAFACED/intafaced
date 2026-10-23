'use client';

/**
 * Segmented control (single-select toggle group) aligned with `HaloButtonPolished`:
 * frosted track, gradient rim, sliding thumb using the same layout spring as the button.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { motion, useReducedMotion } from 'motion/react';

import { cn } from '../lib/utils';

/** Matches `layoutSpring` in `halo-button-polished.tsx`. */
const layoutSpring = {
  type: 'spring' as const,
  bounce: 0.12,
  damping: 34,
  stiffness: 420,
};

export interface HaloToggleGroupItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface HaloToggleGroupProps {
  items: HaloToggleGroupItem[];
  /** Selected value; omit for uncontrolled usage with `defaultValue`. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (next: string) => void;
  className?: string;
  /** Frosted track + backdrop blur (matches card/button translucent mode). */
  translucent?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
}

export function HaloToggleGroup({
  items,
  value: valueProp,
  defaultValue,
  onValueChange,
  className,
  translucent = true,
  disabled = false,
  'aria-label': ariaLabel,
}: HaloToggleGroupProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [thumb, setThumb] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const isControlled = valueProp !== undefined;
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? items[0]?.value ?? '');
  const selected = isControlled ? (valueProp ?? '') : uncontrolled;

  const setSelected = useCallback(
    (next: string) => {
      if (!isControlled) {
        setUncontrolled(next);
      }
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const groupValue = useMemo(() => (selected ? [selected] : []), [selected]);

  const measureThumb = useCallback(() => {
    const track = trackRef.current;
    const active = selected ? itemRefs.current.get(selected) : undefined;
    if (!(track && active)) {
      setThumb({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const tr = track.getBoundingClientRect();
    const br = active.getBoundingClientRect();
    setThumb({
      x: br.left - tr.left,
      y: br.top - tr.top,
      height: br.height,
      width: br.width,
    });
  }, [selected]);

  useLayoutEffect(() => {
    measureThumb();
  }, [measureThumb]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(() => measureThumb());
    ro.observe(track);
    return () => ro.disconnect();
  }, [measureThumb]);

  return (
    <div className={cn('relative inline-flex max-w-full rounded-xl p-px', className)}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
        <motion.div
          animate={{
            opacity: translucent ? 0.72 : 0.5,
          }}
          className="absolute inset-x-0 bottom-0 h-1/2"
          transition={{ duration: reduceMotion ? 0 : 0.25, ease: 'easeOut' }}
        >
          <motion.div
            animate={{ left: '35%' }}
            className="-bottom-4 absolute h-14 w-44 blur-xl"
            style={{
              background: 'linear-gradient(90deg, #b9f65a, #455039, #bccdd5, #424c50)',
            }}
            transition={{
              duration: reduceMotion ? 0.01 : 6,
              ease: 'easeInOut',
              repeat: reduceMotion ? 0 : 0,
            }}
          />
          <motion.div
            animate={{ left: '55%' }}
            className="-bottom-3 absolute h-11 w-36 blur-lg"
            style={{
              background: 'linear-gradient(90deg, #515a44, #b9f65a, #b9f65a)',
            }}
            transition={{
              duration: reduceMotion ? 0.01 : 5,
              ease: 'easeInOut',
              repeat: reduceMotion ? 0 : 0,
            }}
          />
        </motion.div>
      </div>

      <div
        className={cn(
          'relative rounded-xl border border-border/90',
          'shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.05)]',
          'dark:border-border dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_1px_2px_rgba(0,0,0,0.35),0_4px_20px_rgba(0,0,0,0.35)]',
          translucent && 'backdrop-blur-xl backdrop-saturate-150',
        )}
        style={{
          background: translucent
            ? 'linear-gradient(to bottom, color-mix(in oklch, var(--card) 82%, transparent) 0%, color-mix(in oklch, var(--card) 70%, transparent) 100%)'
            : 'linear-gradient(to bottom, var(--card) 0%, color-mix(in oklch, var(--card) 94%, var(--muted)) 100%)',
        }}
      >
        <div className="relative p-1" ref={trackRef}>
          <motion.div
            animate={{
              x: thumb.width > 0 ? thumb.x : 0,
              width: thumb.width,
              y: thumb.y,
              height: thumb.height,
            }}
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-0 left-0 rounded-[10px]',
              'border border-border/70',
              'bg-gradient-to-b from-background/95 to-muted/40',
              'shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_8px_rgba(0,0,0,0.06)]',
              'dark:border-white/10 dark:from-card/95 dark:to-muted/25',
              'dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_4px_12px_rgba(0,0,0,0.35)]',
            )}
            initial={false}
            style={{ opacity: selected ? 1 : 0 }}
            transition={reduceMotion ? { duration: 0 } : layoutSpring}
          />

          <ToggleGroup
            className="relative z-1 flex min-w-0 flex-col gap-2"
            disabled={disabled}
            aria-label={ariaLabel}
            orientation="vertical"
            multiple={false}
            onValueChange={(next) => {
              const first = next[0];
              if (typeof first === 'string') {
                setSelected(first);
              }
            }}
            value={groupValue}
          >
            {items.map((item) => (
              <Toggle
                type="button"
                className={cn(
                  'relative flex min-h-16 min-w-0 flex-1 items-center justify-start rounded-xl px-5 py-4',
                  'font-medium text-muted-foreground text-base tracking-tight antialiased',
                  'outline-none transition-colors duration-200 ease-out',
                  'focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  'disabled:pointer-events-none disabled:opacity-50',
                  'aria-pressed:text-foreground',
                )}
                disabled={item.disabled}
                key={item.value}
                ref={(el) => {
                  if (el) {
                    itemRefs.current.set(item.value, el);
                  } else {
                    itemRefs.current.delete(item.value);
                  }
                }}
                value={item.value}
              >
                {item.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </div>
    </div>
  );
}
