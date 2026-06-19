import { defineConfig } from 'vitest/config';

// The detection engine is pure (no Workers runtime APIs), so we test it in the
// default Node environment. Worker/integration tests can be added later with
// @cloudflare/vitest-pool-workers.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
