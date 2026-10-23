import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Keep the integration suite on real Workers and D1; only outbound GitHub calls are mocked.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
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
          // Bootstrap-admin list (env-sourced since the hardening pass): the
          // admin/rate-limit tests exercise copyjosh as the permanent admin.
          ADMIN_LOGINS: 'copyjosh',
        },
      },
    }),
  ],
  test: {
    include: ['tests/integration/**/*.itest.ts'],
    // Workers cannot read Vitest 5's host-side transformed-module cache.
    fsModuleCache: false,
    setupFiles: ['./tests/integration/setup.ts'],
    // Retain the former singleWorker execution order.
    maxWorkers: 1,
    fileParallelism: false,
  },
});
