# Deployment Instructions

This project is a static [Vite](https://vitejs.dev/) + [Three.js](https://threejs.org/)
game — there's no server-side code. It builds to a `dist/` folder of static
assets and is hosted on **Cloudflare Pages** at:

> **https://gelatinous-cube-game.krashleviathan.com**

CI/CD is handled by two GitHub Actions workflows:

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Every push to `main` and every PR into `main` | Installs deps, runs the maze verifier, and confirms the production build succeeds |
| Deploy | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | Push of a tag matching `release-*` | Builds the game and publishes `dist/` to the Cloudflare Pages project |

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
  (i.e. the domain's nameservers point at Cloudflare). If it isn't yet, add
  the domain as a Cloudflare zone first — the custom domain step below
  depends on this.

### 1.2 Create the Pages project

GitHub Actions deploys *into* an existing Cloudflare Pages project — it
doesn't create one for you. Create it once, as a **Direct Upload** project
(no Git connection needed, since GitHub Actions is doing the building):

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Name the project **`gelatinous-cube-game`** (this must match `projectName` in [`deploy.yml`](../.github/workflows/deploy.yml)).
3. For the first upload you can skip uploading a file, or drag in a local `dist/` build — either way, the project just needs to exist. The GitHub Action will handle every real deploy from here on.

   Alternatively, from the CLI (requires [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) and `wrangler login`):

   ```bash
   npx wrangler pages project create gelatinous-cube-game
   ```

### 1.3 Create an API token for GitHub Actions

1. In the Cloudflare dashboard, go to **My Profile** → **API Tokens** → **Create Token**.
2. Use the **"Edit Cloudflare Workers"** template, or create a custom token with:
   - **Account** → `Cloudflare Pages` → `Edit`
3. Scope it to the account that owns `krashleviathan.com`.
4. Create the token and copy it — you won't be able to view it again.

### 1.4 Find your Account ID

On the Cloudflare dashboard's **Workers & Pages** overview page, the **Account ID**
is shown in the right-hand sidebar. Copy it.

### 1.5 Add GitHub repository secrets

In the GitHub repo, go to **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, and add:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token created in step 1.3 |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID from step 1.4 |

(`GITHUB_TOKEN` used in the deploy workflow is provided automatically by GitHub Actions — no setup needed.)

### 1.6 Attach the custom domain

1. In the Cloudflare dashboard, open the **`gelatinous-cube-game`** Pages project.
2. Go to **Custom domains** → **Set up a custom domain**.
3. Enter `gelatinous-cube-game.krashleviathan.com` and confirm.
4. Because `krashleviathan.com` is already a Cloudflare-managed zone, Cloudflare
   will automatically create the required `CNAME` DNS record and provision an
   SSL certificate. This normally takes a few minutes.

Once this is done, every successful deploy publishes to both the
`*.pages.dev` URL Cloudflare assigns the project and to
`gelatinous-cube-game.krashleviathan.com`.

---

## 2. Cutting a release

From `main`, once it's in the state you want deployed:

```bash
git checkout main
git pull
git tag release-1.0.0
git push origin release-1.0.0
```

Pushing the tag triggers the **Deploy** workflow, which:

1. Installs dependencies (`npm ci`).
2. Runs the maze verifier (`npm run verify:maze`).
3. Builds the game (`npm run verify`, which runs `vite build` into `dist/`).
4. Publishes `dist/` to the `gelatinous-cube-game` Cloudflare Pages project via [`cloudflare/pages-action`](https://github.com/cloudflare/pages-action).

Watch progress under the repo's **Actions** tab. Once it's green, the change
is live at `gelatinous-cube-game.krashleviathan.com` (Cloudflare Pages
typically propagates within a minute or two).

Tag names just need to start with `release-` — use whatever versioning scheme
you like (`release-1.0.0`, `release-2026-08-18`, etc.).

---

## 3. Rolling back

Cloudflare Pages keeps every past deployment. To roll back:

1. Open the `gelatinous-cube-game` Pages project in the Cloudflare dashboard.
2. Go to the **Deployments** tab.
3. Find the last-known-good deployment and click **Rollback to this deployment** (via the "..." menu).

Alternatively, push a new `release-*` tag pointing at the older commit you
want live — that runs the full pipeline again and republishes it as the
newest deployment.

---

## 4. Local build (for manual verification)

```bash
npm ci
npm run build      # outputs to dist/
npm run preview    # serve dist/ locally to sanity-check the production build
```

---

## 5. Troubleshooting

- **Deploy workflow fails at the `cloudflare/pages-action` step with an auth
  error** — double check `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  are set correctly under **Settings → Secrets and variables → Actions**,
  and that the token has `Cloudflare Pages: Edit` permission on the correct
  account.
- **Deploy succeeds but the project isn't found** — confirm the Pages
  project is actually named `gelatinous-cube-game` (must match `projectName`
  in [`deploy.yml`](../.github/workflows/deploy.yml) exactly).
- **Custom domain shows a certificate or DNS error** — confirm
  `krashleviathan.com` is an active Cloudflare zone and that the custom
  domain was added under the Pages project's **Custom domains** tab, not
  added as a manual DNS record pointing elsewhere.
- **Tag push didn't trigger a deploy** — the tag must match the glob
  `release-*` (e.g. `release-1.0.0`), and it must be pushed explicitly with
  `git push origin <tag>` (tags aren't included by a plain `git push`).
