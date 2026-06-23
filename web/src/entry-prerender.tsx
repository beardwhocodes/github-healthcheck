import { renderToString } from 'react-dom/server';

import { SignedOut } from './components/SignedOut.js';

// Rendered at build time by scripts/prerender.mjs and injected into
// web/dist/index.html's #root, so search crawlers and no-JS visitors get the
// full landing page instead of an empty <div>. The browser discards this and
// re-renders via createRoot (main.tsx) — no hydration is required, so there are
// no server/client matching constraints.
export function render(): string {
  return renderToString(<SignedOut />);
}
