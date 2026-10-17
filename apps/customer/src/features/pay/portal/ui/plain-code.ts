/**
 * A code from the card network or the service, said as words: `product_not_received` reads "Product not received".
 * A code with no underscores (a scheme number such as 4853) is shown as it came, because that is the name a bank uses.
 */
export function plainCode(code: string): string {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(code)) return code;
  const words = code.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
