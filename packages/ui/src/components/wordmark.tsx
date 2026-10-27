import * as React from 'react';
import { BrandLockup } from '../brand/brand.js';

/**
 * @deprecated Use `BrandLockup`, `BrandMark` or `BrandWordmark` from `src/brand/` and choose the placement. Kept so code
 * still importing it draws the brand's top-bar lockup (24 pixels tall) rather than an old name.
 */
export function Wordmark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="wordmark" className={className} {...props}>
      <BrandLockup size={24} title="" />
    </span>
  );
}
