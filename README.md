# willdagoat

Scramjet-based in-page web proxy for local development and Render deployment.

## Best Compatibility Path

If you want the best shot at heavier sites, use the Scramjet + Wisp + libcurl stack:

- `artifacts/proxy` is the browser UI.
- `artifacts/api-server` serves the UI, Scramjet assets, BareMux, libcurl transport, and the Wisp WebSocket endpoint.
- The app boots into an in-page browser shell and routes traffic through Scramjet instead of simple HTML rewriting.

## Local Setup

Install dependencies:

```bash
pnpm install
```

Build the Scramjet client and server:

```bash
pnpm run build:scramjet
```

Start the local proxy server:

```bash
pnpm run start:scramjet
```

The server now defaults to port `3000`, so `PORT` is optional. Open:

```text
http://127.0.0.1:3000
```

Health check:

```text
http://127.0.0.1:3000/api/healthz
```

## Scramjet Notes

- Scramjet assets are served from `/scram`
- BareMux assets are served from `/baremux`
- libcurl transport assets are served from `/libcurl`
- Wisp WebSocket upgrades terminate at `/wisp/`
- The browser registers `sw.js` and creates the in-page browsing frame dynamically

This is the architecture to use when you want the strongest compatibility path in this repo.

## Render Deploy

Use Render for the hosted deployment path.

This repo now includes a Render blueprint at `render.yaml` with:

- build command: `corepack enable && pnpm install --frozen-lockfile && pnpm run build:scramjet`
- start command: `pnpm run start:scramjet`
- health check: `/api/healthz`

### Deploy Steps

1. Push this repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo root.
3. Let Render detect `render.yaml`.
4. Deploy the `willdagoat-scramjet` service.

If you create the service manually instead of using the blueprint, use:

```text
Build Command: corepack enable && pnpm install --frozen-lockfile && pnpm run build:scramjet
Start Command: pnpm run start:scramjet
```

The service listens on Render's `PORT` automatically through the Node server.
