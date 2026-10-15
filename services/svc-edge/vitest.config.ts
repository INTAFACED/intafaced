import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Ordinary admin fixtures may report an unconfigured screening list only
    // in an explicit local environment. Boot policy tests supply their own env.
    env: { APP_ENV: 'test' },
  },
});
