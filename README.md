# Health Dashboard

A personal health & lifestyle dashboard — calendar-aware daily planning, macro/nutrition
tracking, AI recipe generation, and grocery cart automation — built as a self-hosted
Node + SQLite app with a vanilla-JS PWA frontend.

It's a single-owner app: the owner has full access, and a small set of family members can
be granted limited "grocery" access to contribute to shared shopping lists.

## Features

- **Day** — a timeline of the day built from connected calendars, with an automatic
  morning "decompression stack" (pre-workout fuel → workout → post-workout shake) anchored
  to a manual wake time and your first meeting. Detects conflicts with calendar events;
  per-day wake-time and workout-time overrides.
- **Macros** — log meals against daily targets (1900 kcal / 150g protein / 160g carbs /
  73g fat), with food search and full nutrition data via FatSecret (serving sizes shown
  with real gram weights). Quick-log staples, saved recipes, pantry items (deducts the
  pantry), prepared-meal portions, and per-component recipe logging.
- **Grocery** — push a shopping list to a Kroger / City Market online cart (search →
  review/confirm → add). Family members add personal items the owner aggregates into one
  cart push. Pantry tracks containers purchased *and* portions per container, with
  fractional deduction as recipes consume them.
- **Recipes** — generate recipes with Claude (per meal type, cuisine, cook time), import
  from a cooking-site URL, or build one from FatSecret ingredients. Save a library, remix
  variations, rate, build a weekly plan, and push ingredients straight to the cart.
  Each recipe shows verified per-serving macros (recomputed from matched products) and a
  portion-size gauge (grams / oz / cups + Snack-size → Very large tier).

## Intended workflow — the meal pipeline

The recipe → grocery → pantry → macros tabs form one loop:

1. **Get a recipe** — generate with Claude, import from a URL, or create a custom one
   from FatSecret ingredients (custom recipes carry real nutrition from the start).
2. **Match ingredients to City Market products** — in the recipe view, each ingredient
   has a *Search City Market* action that attaches the chosen product (UPC, name, package
   size) plus its FatSecret nutrition. The recipe's header macros recompute from this real
   data; the verification badge tracks how much of the recipe is matched vs estimated.
3. **Pick servings** — scale the recipe (1–24 servings); ingredient amounts scale with it.
4. **Push to cart** — one recipe (*Preview & push to City Market*) or several: check
   recipes into the weekly plan, and the drawer builds a **consolidated ingredient list**
   (shared ingredients merged across recipes, grouped by store section, spices opt-in).
   The cart review **pre-selects the products you matched in step 2** and suggests a
   purchase quantity from the package size vs the amount the recipes actually need
   ("needs 3 cups ≈ 1.2 packages — suggested qty 2").
5. **Confirm** — items land in the City Market cart *and* in the Pantry, recorded as
   containers purchased with an estimated (editable) portions-per-container.
6. **Cook & log** — three ways, all of which consume the pantry:
   - *Log recipe as meal* — deducts each ingredient's fraction of a container;
   - *Prepare (meal prep)* — deducts the whole batch up front, then portions are logged
     day-by-day from the Prepared list without touching the pantry again;
   - *Log a pantry item / snack* — one logged serving deducts one portion
     (1/portions-per-container).

## Architecture

- **Backend** — [`server/index.js`](server/index.js): a single-file Express app exposing a
  JSON API and serving the frontend statically. Persistence is a tiny key-value layer over
  SQLite ([`server/db.js`](server/db.js), `better-sqlite3`) that mimics a Cloudflare-KV API
  (`get`/`put`/`delete` with TTL). FatSecret access is isolated in
  [`server/fatsecret.js`](server/fatsecret.js).
- **Frontend** — [`web/`](web): a no-build, vanilla-JS PWA. Plain `<script>` tags load
  modules in order (see [`web/index.html`](web/index.html)); UI is rendered by string
  templates in [`web/js/render.js`](web/js/render.js). Installable / offline-capable via
  [`web/manifest.json`](web/manifest.json).
- **Auth** — Google Identity Services sign-in. The browser sends a Google ID token to
  `POST /auth/login`; the server verifies it, checks the email against the owner or the
  family-access list, and issues a random session bearer token (7-day TTL in KV). The token
  is stored in `localStorage` and sent as `Authorization: Bearer …` on every API call.
- **Integrations** — Google Calendar (read + writing the "Health Dashboard" stack events),
  Microsoft Graph (two work accounts: BBA, CRAFT), Kroger/City Market cart, FatSecret
  nutrition, and the Anthropic API (Claude Haiku) for recipes. Tokens are refreshed
  automatically and cached in KV.

### Nutrition data pipeline

Per-serving macros are computed from real product data wherever possible, falling back to
the Claude estimate per ingredient:

- Each recipe ingredient can carry a compact **`fsFood`** snapshot: one FatSecret serving
  (description, nutrients, and `servingGrams` — derived from FatSecret's exact
  `metric_serving_amount`, which the proxy passes through as `metricAmount`/`metricUnit`).
- A **scaling classifier** ([`web/js/nutrition.js`](web/js/nutrition.js)) reconciles the
  recipe amount with the matched serving: fractions ("1/2 cup"), fl-oz, same-noun counts
  ("2 slices" vs "1 slice"), count↔measure bridging via per-item weights (`_ITEM_WEIGHT_G`),
  volume↔weight via a curated density table, and cooked-yield parentheticals. Statuses:
  `scaled` / `spice` (incl. zero-cal ice/water) / `unit_mismatch` / `none` / `error`.
- Header macros are **recomputed fresh at render** from this classifier (matched
  ingredients + an explicit, displayed estimate share for unmatched ones), and a self-heal
  re-persists `perServing` whenever stored data drifts from current math.
- Automatic FatSecret matching is **relevance-gated**: candidates are ranked by name-token
  overlap (no more "Raw Vegetable" attached to honey), contradictory variants (whole vs
  fat-free) are penalized, and the owner's **Verify nutrition** button re-repairs the whole
  library — re-picking servings by stored food id and re-searching suspect matches. New
  recipes auto-verify on save.
- `node scripts/audit-recipe-scaling.cjs <recipes.json>` runs the real classifier over a
  recipes dump and explains every non-scaled ingredient (used against the prod DB).

### Authorization model
The session middleware authenticates every non-public route, then **denies by default for
non-owners**: a family member's session can only reach an explicit grocery allowlist
(`/grocery/user-data`, `/grocery/family`, `/search-cart`, `/fatsecret/*`). The owner
(`OWNER_EMAIL`) has full access.

## Project structure

```
server/
  index.js        Express app: API routes, OAuth flows, auth/session middleware
  db.js           SQLite-backed KV store (get/put/delete/list, TTL support)
  fatsecret.js    FatSecret OAuth2 client + search/food helpers
  .env.example    Required environment variables
web/
  index.html      App shell (login, tabs, settings drawer)
  manifest.json   PWA manifest + icons
  css/styles.css
  js/             config, state, stack, calendar, render, grocery, recipes, nutrition, app
migrate.js        One-time Cloudflare KV → SQLite import (historical)
*.service         systemd unit files for prod and dev
scripts/          deploy-dev.sh / deploy-prod.sh, audit-recipe-scaling.cjs
```

## Prerequisites

- **Node.js ≥ 22** (the app uses ESM and modern built-ins)
- A **Google Cloud OAuth client** (for sign-in + Calendar)
- API credentials for the integrations you want to use: Kroger, Microsoft/Azure (per work
  account), FatSecret, and Anthropic

## Setup

```bash
cd server
npm install
cp .env.example .env      # then fill in the secrets
node index.js             # starts on PORT (default 3001)
```

Open `http://localhost:3001`. The frontend talks to the same origin (the API base in
[`web/js/config.js`](web/js/config.js) is `''`), so no separate frontend server is needed.

### Environment variables
See [`server/.env.example`](server/.env.example). Summary:

| Variable | Purpose |
| --- | --- |
| `SERVER_URL` | Public base URL — used to build OAuth redirect URIs |
| `PORT` | Listen port (default `3001`) |
| `DB_PATH` | SQLite file path (default `./data/kv.db`) |
| `OWNER_EMAIL` | The Google account granted owner (full) access |
| `GOOGLE_CLIENT_SECRET` | Google OAuth (sign-in + Calendar). Client ID is set in source |
| `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` | City Market / Kroger cart API |
| `AZURE_CLIENT_SECRET_BBA` / `AZURE_CLIENT_SECRET` | Microsoft Graph secrets (BBA / CRAFT) |
| `ANTHROPIC_API_KEY` | Claude recipe generation & remix |
| `FS_CLIENT_ID` / `FS_CLIENT_SECRET` | FatSecret nutrition API |

OAuth redirect URIs registered with each provider must match `${SERVER_URL}` + the callback
path (e.g. `/auth/google/callback`, `/auth/microsoft/callback`, `/callback` for Kroger).

## API overview

All routes require a session bearer token except the public ones (`/auth/login`,
`/auth/verify`, `/auth/logout`, the OAuth start/callback pages, and `/poll-token`).
OAuth flows are CSRF-protected with a single-use `state` nonce; `/auth/login` and the AI
endpoints are rate-limited per client IP.

- **Auth / session** — `POST /auth/login`, `GET /auth/verify`, `DELETE /auth/logout`
- **Calendar OAuth** — `…/auth/google/*`, `…/auth/microsoft/*`, plus `/cal-urls`,
  `POST /fetch-calendars`
- **Kroger** — `GET /auth` → `/callback`, `/poll-token`, `/search-cart`,
  `/push-cart-confirmed`, `/push-cart`
- **Recipes** — `GET/POST/PUT/DELETE /recipes…`, `POST /recipes/generate`,
  `POST /recipes/:id/remix`, `POST /recipes/import-url`
- **Admin (owner-only)** — `POST /admin/normalize-recipes`, `POST /admin/backfill-components`
- **Nutrition** — `GET /fatsecret/search`, `GET /fatsecret/food`
- **Data** — `/prefs`, `/meal-log`, `/pantry`, `/prepared-meals`, `/wake-times`,
  `/workout-start`, `POST /push-workout-event`
- **Family (owner-only)** — `/family-access…`, `/grocery/family`, `/grocery/user-data`

## Deployment

Production and dev run as **systemd services** on the host (see
[`health-dashboard.service`](health-dashboard.service) and
[`health-dashboard-dev.service`](health-dashboard-dev.service)), each with its own
`server/.env` but **sharing one SQLite database** (`DB_PATH=./data/kv.db`) —
data changes made on dev are live on prod and vice versa; only the code differs:

- **Dev** → `https://dev.your-domain.example.com` (`/opt/health-dashboard-dev`, branch `development`)
- **Prod** → `https://your-domain.example.com` (`/opt/health-dashboard`, branch `main`)

Deploy with the npm scripts (which commit if needed, push, then SSH in to pull, install, and
restart the service):

```bash
npm run deploy:dev    # ships the development branch to dev
npm run deploy:prod   # fast-forwards development → main, then ships to prod
```

## Notes

- The KV store is a single global namespace; most app data lives under fixed keys
  (`recipes`, `pantry`, `cal_urls`, …) while sessions, per-user grocery data, and caches are
  prefixed (`session_*`, `grocery:user:*`, `fs:*`).
- `migrate.js` is a one-time importer from the project's previous Cloudflare Worker + KV
  setup; it isn't part of normal operation.
