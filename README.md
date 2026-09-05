# LIFEstream

Worldbuilding tools for **LIFEstream** — an animated feature set in an alternate reality
where leaps and bounds in technology are made underground while the surface is ravaged by
a gruesome virus called Black Fever. After the Black Fever era, humanity emerges to a
changed world and new technologies: fusion energy, synthetic computation brains.

This repository is the _visualizer_: a single app for authoring and exploring that world's
canon — its timeline, its map, its family trees and its tech tree — over an SQLite
database of saves.

## Layout

An npm workspace monorepo. The full contract lives in `docs/architecture.html`; the build
order lives in `docs/implementation.html`.

| Path       | What it is                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `client/`  | The React + Vite front end — the four views and the app shell.                                           |
| `server/`  | The Hono API over SQLite (drizzle), bound to loopback.                                                   |
| `shared/`  | Types and pure helpers imported by both, via `@shared/*`.                                                |
| `scripts/` | Root maintenance scripts — `db-reset.mjs`, `seed.ts`.                                                    |
| `tests/`   | Vitest specs. They live at the root, not per workspace.                                                  |
| `data/`    | Authored inputs and the local database (the `.db` is never committed).                                   |
| `docs/`    | Architecture and implementation plan (HTML — see `CLAUDE.md`).                                           |
| `map/`     | The retired standalone map utility this project replaces. Kept for reference; not part of the workspace. |

## Prerequisites

**Node 24 LTS or newer.** With `nvm`:

```bash
nvm install --lts
nvm use --lts
```

## Getting started

```bash
npm install          # installs every workspace
npm run db:migrate   # creates data/lifestream.db from the drizzle migrations
npm run dev          # server on :3001 and client on :5173, together
```

Then open <http://localhost:5173/>. `npm run dev` runs both halves under
`concurrently`; the Vite dev server proxies `/api/*` to the API, so the browser only ever
talks to one origin. Both ports are pinned — Vite is configured with `strictPort`, so a
port already in use fails loudly instead of silently moving.

## Scripts

Run from the repository root.

| Script                            | What it does                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                     | Both dev servers (`dev:server` / `dev:client` run one each).                                                                               |
| `npm run build`                   | Builds `shared/`, then the client bundle.                                                                                                  |
| `npm test`                        | Vitest, once (`test:watch` for the loop).                                                                                                  |
| `npm run typecheck`               | `tsc -b` across the workspaces, plus the specs.                                                                                            |
| `npm run lint` / `npm run format` | ESLint / Prettier over the repo.                                                                                                           |
| `npm run db:generate`             | Generates a migration from the drizzle schema.                                                                                             |
| `npm run db:migrate`              | Applies migrations to `data/lifestream.db`.                                                                                                |
| `npm run db:studio`               | Drizzle Studio against the local database.                                                                                                 |
| `npm run db:seed`                 | Seeds a fresh world. _(Lands in P1.)_                                                                                                      |
| `npm run db:reset`                | Deletes the local database and its SQLite sidecars, so it can be rebuilt from `db:migrate` + `db:seed`. Restart the dev server afterwards. |

## Main packages

- **[React](https://react.dev/) & [Vite](https://vitejs.dev/)** — front end and dev server.
- **[Hono](https://hono.dev/)** — the API, on `@hono/node-server`.
- **[Drizzle ORM](https://orm.drizzle.team/) & [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — schema, migrations and the synchronous SQLite driver.
- **[Zustand](https://zustand.docs.pmnd.rs/)** — client state; **[React Router](https://reactrouter.com/)** — the four view routes.
- **[d3-geo](https://github.com/d3/d3-geo) & [topojson-client](https://github.com/topojson/topojson-client)** — map projection, centroids and TopoJSON handling (including splitting French Guiana out of France).
- **[React Flow](https://reactflow.dev/)** — the tech tree and family-tree graphs.
- **[three](https://threejs.org/) & [React Three Fiber](https://r3f.docs.pmnd.rs/)** — the 3D timeline corridor.
- **[Vitest](https://vitest.dev/)** — the test runner.

## Updating dependencies

```bash
npm update                    # latest compatible minor/patch
npx npm-check-updates -u      # latest absolute versions — expect breaking changes
npm install
```
