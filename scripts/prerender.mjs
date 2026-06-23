import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { build } from 'vite';

// Render the signed-out landing page to static HTML and inject it into the built
// index.html's #root, so search crawlers and no-JS visitors get real content
// instead of an empty <div>. Runs after `vite build` (see package.json
// build:web). It SSR-bundles the same React component tree the client uses — no
// duplicated markup. A throwaway bundle (web/.prerender) is built then removed.

const INDEX = 'web/dist/index.html';
const MARKER = '<div id="root"></div>';
const OUT_DIR = 'web/.prerender';

await build({
  configFile: false,
  root: 'web',
  logLevel: 'warn',
  plugins: [react()],
  build: {
    ssr: 'src/entry-prerender.tsx',
    outDir: '.prerender',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
  },
});

try {
  const entry = new URL('../web/.prerender/entry.mjs', import.meta.url).href;
  const { render } = await import(entry);
  const html = render();

  const index = readFileSync(INDEX, 'utf8');
  if (!index.includes(MARKER)) {
    throw new Error(`prerender: marker "${MARKER}" not found in ${INDEX}`);
  }
  writeFileSync(INDEX, index.replace(MARKER, `<div id="root">${html}</div>`));
  console.log(`prerender: injected ${html.length} bytes of landing HTML into ${INDEX}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}
