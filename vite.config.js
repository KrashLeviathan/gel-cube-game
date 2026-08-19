import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Single source of truth for the in-game version badge (src/version.js).
// package.json's version stays in sync with the `release-*` git tag that
// deploy.yml watches for because both are bumped atomically by `npm version`
// — see docs/DEPLOYMENT-INSTRUCTIONS.md "Cutting a release".
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true, // expose on LAN so phones/tablets can test
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
