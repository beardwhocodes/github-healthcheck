// TS 6 enforces that side-effect imports resolve to a module with type
// declarations (TS2882); a bare `import './styles.css'` otherwise errors. This
// tsconfig sets `types: []` and intentionally doesn't pull in `vite/client`
// (see mailProvider.ts for why), so declare the CSS module ourselves. Vite
// handles the actual bundling; this only tells tsc the import is legitimate.
declare module '*.css';
