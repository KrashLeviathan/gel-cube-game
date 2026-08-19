# Deployment Instructions

This project is a static [Vite](https://vitejs.dev/) + [Three.js](https://threejs.org/)
game — there's no server-side code. It builds to a `dist/` folder of static
assets and is served by a **Cloudflare Worker** (using Workers' built-in
static-assets support, configured in [`wrangler.toml`](../wrangler.toml)) at:

> **https://gelatinous-cube-game.krashleviathan.com**

This mirrors how the parent site (`krashleviathan-site`, serving
`krashleviathan.com`) is already deployed — a Worker with a route attached,
rather than a separate Cloudflare Pages project.

CI/CD is handled by two GitHub Actions workflows:

| Workflow | File                                                              | Trigger                                       | Purpose                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI       | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)         | Every push to `main` and every PR into `main` | Installs deps, runs the maze verifier, and confirms the production build succeeds                                                                                       |
| Deploy   | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Push of a tag matching `release-*`            | Builds the game and publishes `dist/` to the `gelatinous-cube-game` Worker via [`wrangler deploy`](https://developers.cloudflare.com/workers/wrangler/commands/#deploy) |

Nothing deploys automatically on every commit to `main` — deploys only happen
when you push a tag named `release-*` (e.g. `release-1.0.0`, `release-2024-06-01`).
This lets you merge and iterate on `main` freely and cut a release whenever
the game is in a state you want live.

---

## 1. One-time Cloudflare setup

You only need to do this once. After it's done, every `release-*` tag push
deploys automatically.

### 1.1 Prerequisites

- The `krashleviathan.com` domain's DNS must already be managed by Cloudflare
  (i.e. the domain's nameservers point at Cloudflare).
- A Cloudflare Worker named **`gelatinous-cube-game`** with a route for
  `gelatinous-cube-game.krashleviathan.com` already exists. If you're setting
  this up fresh (no such Worker yet), create one from the Cloudflare
  dashboard (**Workers & Pages** → **Create** → **Workers**) and attach the
  route or a custom domain for `gelatinous-cube-game.krashleviathan.com` to
  it. The name must match `name` in [`wrangler.toml`](../wrangler.toml).

  Deliberately, [`wrangler.toml`](../wrangler.toml) does **not** declare a
  `routes` block. The route is managed by hand in the dashboard and stays
  bound to the Worker by name; `wrangler deploy` only pushes new code/assets
  under that name; it doesn't touch routing. If you ever want the route
  managed as code instead, add:

  ```toml
  [[routes]]
  pattern = "gelatinous-cube-game.krashleviathan.com/*"
  zone_name = "krashleviathan.com"
  ```

### 1.2 Create an API token for GitHub Actions

1. In the Cloudflare dashboard, go to **My Profile** → **API Tokens** → **Create Token**.
2. Use the **"Edit Cloudflare Workers"** template (this grants the `Workers Scripts: Edit` permission that `wrangler deploy` needs).
3. Scope it to the account that owns `krashleviathan.com`.
4. Create the token and copy it — you won't be able to view it again.

   > If you already created a token scoped only to `Cloudflare Pages: Edit`
   > (e.g. from an earlier version of this setup), it will **not** work for
   > Worker deploys — `wrangler deploy` needs Workers Scripts permission.
   > Create a new token with the Workers template, or edit the existing
   > token's permissions to add it.

### 1.3 Find your Account ID

On the Cloudflare dashboard's **Workers & Pages** overview page, the **Account ID**
is shown in the right-hand sidebar. Copy it.

### 1.4 Add GitHub repository secrets

In the GitHub repo, go to **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, and add:

| Secret name             | Value                         |
| ----------------------- | ----------------------------- |
| `CLOUDFLARE_API_TOKEN`  | The token created in step 1.2 |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID from step 1.3  |

---

## 2. Cutting a release

From `main`, once it's in the state you want deployed:

```bash
git checkout main
git pull
npm version patch   # or: minor / major / 1.2.3
git push --follow-tags
```

`npm version` bumps `version` in `package.json`, commits that bump, and
creates a matching `release-*` tag in one step — `tag-version-prefix` in
[`.npmrc`](../.npmrc) is what makes the tag come out as `release-1.0.0`
instead of npm's default `v1.0.0`. This is also what keeps the small version
badge in the bottom-right corner of the Home and Pause screens accurate: it's
read from `package.json` at build time (see [`vite.config.js`](../vite.config.js)
and [`src/version.js`](../src/version.js)), so it can never drift from the tag
that triggers the deploy below. `git push --follow-tags` pushes both the
commit and the new tag.

Pushing the tag triggers the **Deploy** workflow, which:

1. Installs dependencies (`npm ci`).
2. Runs the maze verifier (`npm run verify:maze`).
3. Builds the game (`npm run verify`, which runs `vite build` into `dist/`).
4. Runs `wrangler deploy` (via [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action)), which uploads `dist/` as the Worker's static assets per [`wrangler.toml`](../wrangler.toml).

Watch progress under the repo's **Actions** tab. Once it's green, the change
is live at `gelatinous-cube-game.krashleviathan.com` — Worker deploys are
close to instant (usually live within seconds).

The Deploy workflow itself only cares that the tag starts with `release-`; it
doesn't require semver. `npm version` is just the recommended way to produce
one of those tags, because it's what keeps `package.json` — and therefore the
in-game version badge — in sync automatically. Pushing a `release-*` tag by
hand still works (e.g. `git tag release-2026-08-18 && git push origin
release-2026-08-18`) but the badge will keep showing whatever `package.json`
last said, since nothing recomputes it from an arbitrary tag name.

---

## 3. Caching

[`public/_headers`](../public/_headers) sets the browser cache policy. Vite
copies `public/` verbatim into `dist/`, so the file ships as one of the Worker's
static assets; Cloudflare reads the rules and never serves the file itself
(`/_headers` is a 404).

| Path            | `Cache-Control`                                 | Why                                                                                        |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/`             | `no-store`                                      | The entry document is the only unhashed file, and it names the current build's bundles.    |
| `/assets/*`     | `public, max-age=31536000, immutable`           | Vite content-hashes these, so a new build is a new URL and the old one is never asked for. |
| everything else | Workers' default (`max-age=0, must-revalidate`) | The optional `public/audio/` mp3s, whose filenames are fixed by `docs/AUDIO.md`.           |

Without this, Workers' default applies to `index.html` too — and Workers serves
the entry document without an `ETag` to revalidate against, so browsers could
keep replaying a stale `index.html` (and with it the previous build's bundle
filenames) across a deploy until someone hard-refreshed.

### The service worker sits in front of all of it

Once [`src/sw.js`](../src/sw.js) is installed it answers navigations from its
own cache, so for returning players **the headers above stop deciding what they
see — the worker's update lifecycle does.** The flow, end to end:

1. A deploy changes the bundle, so `dist/sw.js` (which embeds a digest of every
   emitted file) is byte-different.
2. The browser notices on the next navigation, or when
   [`src/swClient.js`](../src/swClient.js) calls `registration.update()` after
   the tab has been backgrounded for 15 minutes.
3. The new worker installs, precaches the new shell, and **parks in `waiting`**.
   It never calls `skipWaiting()` on its own.
4. The player gets the "A new version is ready" toast — held back until they're
   not mid-run — and taps Refresh, which releases the waiting worker and
   reloads.

So a release reaches players on their next visit, or when they accept the
prompt; it does not swap the bundle out from under a live game.

### If you ever need to switch the worker off

A service worker that is broken _and_ installed is sticky, so this is the escape
hatch. Deploy an `sw.js` that clears up after itself:

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim()),
  );
});
```

Every client that reaches that worker unregisters itself and falls back to the
plain `_headers` behaviour. Note that a **Cloudflare dashboard rollback does not
do this** — it restores the old assets, but an already-installed worker keeps
serving its own cache until it sees a byte-different `sw.js`. Rolling back to a
build whose `sw.js` differs from the live one is fine; rolling back _to the same
worker_ is not a way out.

To check the rules after changing them, run the Worker against Cloudflare's own
local runtime and read the headers back — `wrangler dev` prints
`Parsed N valid header rules` on startup, which is the only place a malformed
rule shows up (`wrangler deploy --dry-run` does **not** validate them):

```bash
nvm use && npm run build && npx wrangler dev --port 8788
```

`nvm use` matters here: wrangler refuses to start below Node 22 (`.nvmrc` pins
it), and nothing else in the toolchain complains, so this is where a stale shell
shows up.

**Check the wrangler major before trusting a local test.** `_headers` support
for Workers assets only exists in wrangler 4. wrangler-action@v3 still defaults
to 3.90.0, which ignores the file _and uploads it as a public asset_ without a
word of warning — release 0.1.2 went out that way after a local test on
wrangler 4 passed. `deploy.yml` now pins `wranglerVersion`. After any deploy,
the one-line check that the rules actually applied is:

```bash
curl -sI https://gelatinous-cube-game.krashleviathan.com/ | grep -i cache-control
```

`no-store` means they applied; `max-age=0, must-revalidate` is the Workers
default and means they did not. `/_headers` returning 200 instead of 404 is the
same failure seen from the other side. The deploy log shows it too: a working
deploy prints `Parsed N valid header rules`.

```bash
curl -sI http://127.0.0.1:8788/ | grep -i cache-control
```

---

## 4. Rolling back

Cloudflare Workers keep a version history. To roll back:

1. Open the `gelatinous-cube-game` Worker in the Cloudflare dashboard.
2. Go to the **Deployments** tab.
3. Find the last-known-good version and use **Rollback** to make it live again.

Alternatively, push a new `release-*` tag pointing at the older commit you
want live — that runs the full pipeline again and redeploys it as the
newest version.

---

## 5. Local build (for manual verification)

```bash
npm ci
npm run build      # outputs to dist/
npm run preview    # serve dist/ locally to sanity-check the production build
```

To deploy manually from your machine instead of via CI (requires
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) and
`wrangler login`):

```bash
npm run build
npx wrangler deploy
```

---

## 6. Troubleshooting

- **Deploy workflow fails with an auth/permission error** — double check
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set correctly under
  **Settings → Secrets and variables → Actions**, and that the token has
  `Workers Scripts: Edit` permission (not just `Cloudflare Pages: Edit`) on
  the correct account — see the note in step 1.2.
- **Deploy succeeds but the site at the custom domain doesn't update** —
  confirm the route/custom domain shown under the Worker's **Triggers** tab
  is still `gelatinous-cube-game.krashleviathan.com`, and that
  [`wrangler.toml`](../wrangler.toml)'s `name` still matches the Worker's
  name exactly (a mismatch would deploy a _new_, differently named Worker
  instead of updating the existing one).
- **Deploy succeeded but a browser still shows the old build** — check the
  entry document's headers: `curl -sI https://gelatinous-cube-game.krashleviathan.com/ | grep -i cache-control`
  should say `no-store`. If it says `max-age=0, must-revalidate` instead, the
  `_headers` rules aren't being applied — confirm `public/_headers` survived the
  build into `dist/_headers` and that its paths still match where the assets
  land. See section 3.
- **Tag push didn't trigger a deploy** — the tag must match the glob
  `release-*` (e.g. `release-1.0.0`), and it must be pushed explicitly with
  `git push origin <tag>` (tags aren't included by a plain `git push`).
