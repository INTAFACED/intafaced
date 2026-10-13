/**
 * A form's main button is neutral until the form has something to save, and solid lime only then. It is never lime while
 * disabled. The stylesheet reads `data-primary`, so the rule lives in one place.
 *
 * `refused` is for a save the server will turn down (the form is based on an older version of the enquiry): it stays neutral
 * but enabled, because lime means "this is the action to take", and here the action to take is to discard and reload.
 */
export function submitProps({ disabled, changed, refused = false }: { disabled: boolean; changed: boolean; refused?: boolean }) {
  return { disabled, 'data-primary': changed && !disabled && !refused ? ('true' as const) : ('false' as const) };
}
