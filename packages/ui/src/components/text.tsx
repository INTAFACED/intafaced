import * as React from 'react';
import { cn } from './cn.js';
import type { TypeRole } from '../lit/contracts.js';

/**
 * Text in one of the kit's type roles (`typeRoles`, packages/ui/src/lit/contracts.ts): hero, figure, title, heading, body,
 * label and micro, each drawn from `--lit-type-<role>-size|line|weight|tracking`. A room sets type with this, never with
 * raw type classes (`text-sm`, `font-medium`: garden/no-raw-type-class). Figures and the hero take the figure face; micro
 * takes the mono face, in capitals.
 */
export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  variant: TypeRole;
  /** The element drawn; `p` by default. A heading role still needs a heading element where it heads a section. */
  as?: 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'strong' | 'small' | 'dt' | 'dd' | 'label' | 'figcaption';
}

const FACE: Partial<Record<TypeRole, string>> = {
  hero: 'var(--lit-font-figure)',
  figure: 'var(--lit-font-figure)',
  micro: 'var(--lit-font-mono)',
};

export function Text({ variant, as: Tag = 'p', className, style, ...rest }: TextProps) {
  const v = `--lit-type-${variant}`;
  return (
    <Tag
      {...rest}
      data-type-role={variant}
      className={cn('m-0', (variant === 'hero' || variant === 'figure') && 'tabular-nums', className)}
      style={{
        fontFamily: FACE[variant],
        fontSize: `var(${v}-size)`,
        lineHeight: `var(${v}-line)`,
        fontWeight: `var(${v}-weight)`,
        letterSpacing: `var(${v}-tracking)`,
        ...style,
      }}
    />
  );
}
