import { expect } from '@playwright/test';

/**
 * The shell's one service-off notice (HM-shell-03): "<Action> needs <dependency>. It is switched off in this build." followed
 * by the allowlist code, which is also its `data-not-connected`. Checks `notice` says exactly that for `code` and `action`.
 */
export async function expectServiceOff(notice, code, action) {
  await expect(notice).toHaveAttribute('data-not-connected', code);
  await expect(notice).toHaveClass(/\bservice-off\b/);
  const text = (await notice.innerText()).replace(/\s+/g, ' ').trim();
  const match = /^(.+) needs (.+)\. It is switched off in this build\. (\S+)$/.exec(text);
  expect(match, text).not.toBeNull();
  expect(match[1]).toBe(action);
  expect(match[3]).toBe(code);
  return text;
}
