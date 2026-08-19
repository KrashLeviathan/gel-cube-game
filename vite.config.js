import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Single source of truth for the in-game version badge (src/version.js).
// package.json's version stays in sync with the `release-*` git tag that
// deploy.yml watches for because both are bumped atomically by `npm version`
// — see docs/DEPLOYMENT-INSTRUCTIONS.md "Cutting a release".
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

/**
 * Emits dist/sw.js from the src/sw.js template.
 *
 * The service worker has to name the files it precaches, and those names are
 * content-hashed by the build — so the list can only be written once the
 * bundle exists. This is the job vite-plugin-pwa would normally do; hand-
 * rolling it is what keeps `three` the lone dependency (see CLAUDE.md).
 *
 * The build id is a digest of every emitted file. It is what makes the worker
 * byte-different after a real change and identical after a rebuild of
 * unchanged sources, which in turn is what decides whether players get an
 * update prompt — so it must cover content, not just filenames.
 */
function serviceWorker() {
  return {
    name: 'gelcube-service-worker',
    apply: 'build',
    // After vite:build-html, so index.html is in the bundle to be hashed.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const template = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8');

      const digest = createHash('sha256');
      // Sorted so the digest doesn't ride on rollup's emission order.
      for (const fileName of Object.keys(bundle).sort()) {
        const entry = bundle[fileName];
        digest.update(fileName);
        digest.update(entry.type === 'chunk' ? entry.code : entry.source);
      }
      const build = `${pkg.version}-${digest.digest('hex').slice(0, 12)}`;

      // The shell: the entry document plus every hashed asset. Deliberately
      // NOT public/audio/* — those are optional, may be absent entirely, and
      // an addAll() is atomic, so one missing mp3 would fail the whole
      // install and leave the game with no offline support at all.
      //
      // The entry document is precached as './' (the site root), NOT
      // 'index.html'. Cloudflare Workers' static-asset serving 307-redirects
      // a request for the literal "index.html" filename to "/" — fetch()
      // follows that, so caching it stores a Response with `redirected:
      // true`. A browser refuses to satisfy a page *navigation* with a
      // respondWith() value that is a redirected response (redirect mode
      // isn't 'manual' for navigations), so every load after this worker
      // activated failed with net::ERR_FAILED. './' is what an actual
      // navigation requests, so it's never redirected and never poisoned.
      const precache = [
        './',
        ...Object.keys(bundle)
          .filter((f) => f.startsWith('assets/'))
          .sort(),
      ];

      // Throwing beats a silent miss: an unstamped worker still *deploys*,
      // then dies on the undefined identifier at install time and quietly
      // takes offline support with it.
      const stamp = (src, token, value) => {
        if (!src.includes(token)) {
          throw new Error(`sw.js template is missing the ${token} placeholder`);
        }
        return src.replaceAll(token, () => value);
      };

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: stamp(
          stamp(template, '__SW_BUILD__', build),
          '__SW_PRECACHE__',
          JSON.stringify(precache),
        ),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
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
