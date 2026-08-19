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

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Every push to `main` and every PR into `main` | Installs deps, runs the maze verifier, and confirms the production build succeeds |
| Deploy | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Push of a tag matching `release-*` | Builds the game and publishes `dist/` to the `gelatinous-cube-game` Worker via [`wrangler deploy`](https://developers.cloudflare.com/workers/wrangler/commands/#deploy) |

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

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token created in step 1.2 |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID from step 1.3 |

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

## 3. Rolling back

Cloudflare Workers keep a version history. To roll back:

1. Open the `gelatinous-cube-game` Worker in the Cloudflare dashboard.
2. Go to the **Deployments** tab.
3. Find the last-known-good version and use **Rollback** to make it live again.

Alternatively, push a new `release-*` tag pointing at the older commit you
want live — that runs the full pipeline again and redeploys it as the
newest version.

---

## 4. Local build (for manual verification)

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

## 5. Troubleshooting

- **Deploy workflow fails with an auth/permission error** — double check
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set correctly under
  **Settings → Secrets and variables → Actions**, and that the token has
  `Workers Scripts: Edit` permission (not just `Cloudflare Pages: Edit`) on
  the correct account — see the note in step 1.2.
- **Deploy succeeds but the site at the custom domain doesn't update** —
  confirm the route/custom domain shown under the Worker's **Triggers** tab
  is still `gelatinous-cube-game.krashleviathan.com`, and that
  [`wrangler.toml`](../wrangler.toml)'s `name` still matches the Worker's
  name exactly (a mismatch would deploy a *new*, differently named Worker
  instead of updating the existing one).
- **Tag push didn't trigger a deploy** — the tag must match the glob
  `release-*` (e.g. `release-1.0.0`), and it must be pushed explicitly with
  `git push origin <tag>` (tags aren't included by a plain `git push`).
