import { expect } from './journey.mjs';

/**
 * Something is absent from a room that has drawn. A bare `toHaveCount(0)` right after a navigation passes before the page
 * renders anything (J-campaigns-01 #3 at #8498), so it would pass on a room that then shows the thing. This shows the
 * container the thing would sit in first, then counts the thing in it.
 *
 * `locator` is a selector, read inside `container`, or a Locator; a Locator should be one the container holds
 * (`container.getByTestId(...)`), or the shown container proves nothing about it. `options` go to the shown check
 * (`{ timeout }`). garden/count-zero-needs-shown (tooling/lint/oxlint-plugin-garden/absent-rule.js) names this helper.
 */
export async function absentIn(container, locator, options = {}) {
  await expect(container, 'the container is shown before anything in it is counted absent').toBeVisible(options);
  const inside = typeof locator === 'string' ? container.locator(locator) : locator;
  await expect(inside).toHaveCount(0);
}
