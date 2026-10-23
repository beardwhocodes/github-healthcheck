import { setupNetwork } from '@msw/cloudflare';

export const network = setupNetwork();

// Preserve the old mock's refusal of unconfigured outbound requests.
network.configure({ onUnhandledFrame: 'error' });
