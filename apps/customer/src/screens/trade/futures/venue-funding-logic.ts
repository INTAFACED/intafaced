/** A funding interval in hours when it is whole hours, else in seconds. */
export function intervalText(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds}s`;
}
