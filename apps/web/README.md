# @onchainpoker/web

Operator and player UI for:

- coordinator monitoring (tables, seat intents, raw appchain state, and events),
- Cosmos wallet actions (`sit`, `act`) for a basic playable flow.

## Run (dev)

From repo root:

```bash
pnpm install
pnpm web:dev
```

Default app URL: `http://127.0.0.1:5173/ocp/`.

Use Vite env vars to point at your services:

```bash
VITE_COORDINATOR_HTTP_URL=http://127.0.0.1:8788 \
VITE_COSMOS_RPC_URL=http://127.0.0.1:26657 \
VITE_COSMOS_LCD_URL=http://127.0.0.1:1317 \
VITE_COSMOS_CHAIN_ID=ocp-local-1 \
VITE_COSMOS_GAS_PRICE=0uocp \
pnpm web:dev
```

## Minimal player path

1. Open the app and select an active table from the left lobby.
2. Connect wallet in **Player Desk**.
3. Submit `Sit` with a seat index and buy-in.
4. When it is your turn and your seat is active, choose `fold`, `check`, `call`, `bet`, or `raise` and submit.

The player flow uses the SDK/Cosmos clients directly through:

- `connectOcpCosmosSigningClient`
- `createOcpCosmosClient`
- `pokerSit`
- `pokerAct`

No operator endpoint is required for those actions.

## Build

```bash
pnpm web:build
```

Output directory: `apps/web/dist`.

## Hosting at discordwell.com/ocp

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
