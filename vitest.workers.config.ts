import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Integration tests that drive REAL requests through the Worker (Hono middleware
// + routes) against a REAL miniflare D1 — the only way to prove the authz
// boundary (requireAdmin / requireNotSuspended) actually blocks, which pure
// tests cannot. Kept separate from the fast node suite (vitest.config.ts) and
// matched by *.itest.ts so the two never overlap.
export default defineWorkersConfig({
  test: {
    include: ['tests/integration/**/*.itest.ts'],
    poolOptions: {
      workers: {
        main: './src/index.ts',
        singleWorker: true,
        miniflare: {
          compatibilityDate: '2024-12-18',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: {
            APP_URL: 'https://test.local',
            GITHUB_CLIENT_ID: 'test-client-id',
            ALERT_FROM_EMAIL: 'noreply@test.local',
            GITHUB_CLIENT_SECRET: 'test-client-secret',
            SESSION_SECRET: 'integration-test-session-secret-0123456789abcdef',
          },
        },
      },
    },
  },
});
