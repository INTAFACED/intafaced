/** Resolves after `ms` milliseconds. The one shared copy; apps, packages and services all depend on contracts. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
