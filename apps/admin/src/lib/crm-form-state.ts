/**
 * A form's main button is neutral until the form has something to save, and solid lime only then. It is never lime while
 * disabled. The stylesheet reads `data-primary`, so the rule lives in one place.
 */
export function submitProps({ disabled, changed }: { disabled: boolean; changed: boolean }) {
  return { disabled, 'data-primary': changed && !disabled ? ('true' as const) : ('false' as const) };
}
