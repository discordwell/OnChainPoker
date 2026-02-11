# @onchainpoker/web

Operator GUI for coordinator-driven table discovery, seat intents, and live chain event monitoring.

## Run

From repo root:

```bash
pnpm install
pnpm web:dev
```

Default app URL: `http://127.0.0.1:5173/ocp/`

Set coordinator endpoint at runtime from the UI, or preconfigure with:

```bash
VITE_COORDINATOR_HTTP_URL=http://127.0.0.1:8788 pnpm web:dev
```

## Build

```bash
pnpm web:build
```

Output directory: `apps/web/dist`

## Hosting At discordwell.com/ocp

The app build is configured with `base=/ocp/` by default.

Suggested static deploy shape:

- Serve `apps/web/dist` at `/ocp/`
- Reverse proxy coordinator API to a stable URL and set `VITE_COORDINATOR_HTTP_URL` accordingly at build time

Example build command for same-origin proxy under `/ocp/api`:

```bash
VITE_COORDINATOR_HTTP_URL=https://discordwell.com/ocp/api pnpm web:build
```

If you want to host at another subpath, override build base:

```bash
VITE_BASE_PATH=/another/subpath/ pnpm web:build
```
