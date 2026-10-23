import { reset } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { network } from './network.js';

beforeAll(() => network.enable());
beforeEach(async () => {
  // The current Workers plugin requires an explicit reset between tests.
  await reset();
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
