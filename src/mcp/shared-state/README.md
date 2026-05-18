# shared-state — Cross-Process State Workaround

**This entire directory is a workaround.** It exists solely to bridge the
multi-process state-isolation bug in Claude Desktop's local-agent-mode (Cowork)
where the host spawns the same MCP server twice — once for the iframe-host
transport, once for the agent transport — and module-level state ends up
split-brained across the two processes.

Upstream tracking: <https://github.com/anthropics/claude-code/issues/54513>

## How it slots in

`src/mcp/session.ts` exposes the public API (`enqueue`, `drain`,
`registerPending`, `resolvePending`, `rejectPending`, `setOpenDocument`,
`getSession`, etc.) and routes every call through a `SessionBackend` instance.

- **Default backend:** `InMemoryBackend` in `session.ts`. Identical to the
  pre-workaround behavior; module-level Maps and arrays.
- **Opt-in backend:** `createSharedFileBackend()` in this directory. Reads and
  writes a single JSON file under `${TMPDIR}/nutrient-pdf-editor/state.json`
  guarded by a hand-rolled `O_EXCL` lockfile.

The selector in `session.ts` reads `NUTRIENT_SHARED_STATE`. When set to `"1"`,
the file backend replaces the in-memory backend at module load.

## Staging directory hardening (SR-003)

The staging directory is created with `fs.mkdirSync(stateDir, { recursive: true,
mode: 0o700 })` and verified with `fs.lstatSync` immediately after. The backend
refuses to start if any of the following hold:

- the path is a symlink (`lstat` is deliberate — `stat` would follow it),
- the entry is not a directory,
- the owner uid does not match `process.getuid()`,
- the mode bits are not exactly `0o700`.

This blocks a same-UID attacker from pre-seeding `state.json` / `state.lock`
under a world-traversable mode, and from planting a symlink that redirects
the staging dir to an attacker-controlled location. Windows has no `getuid`,
so the backend fails-closed there with an explicit error — the project ships
on macOS/Linux only.

## How to strip it out (when Cowork ships a fix)

1. Delete this entire directory: `src/mcp/shared-state/`.
2. In `src/mcp/session.ts`, remove the `NUTRIENT_SHARED_STATE` branch in the
   backend selector — keep only the `InMemoryBackend` path. Delete the
   import of this directory.
3. Drop the `NUTRIENT_SHARED_STATE` env var from any local launch configs
   and from `manifest.json` `mcp_config.env` if it was added there.

The `SessionBackend` interface itself is a clean refactor and may be kept or
inlined back into `session.ts` per taste.

## Tradeoffs

- **Latency:** every awaited tool round-trip polls the shared file every 50ms
  for its result, so worst-case 50ms of added latency on each call.
- **File contention:** under the lockfile, both processes serialize their
  state mutations. At the rate this server operates (a handful of ops per
  user action) this is fine. It would not be fine for a high-throughput tool.
- **Stale recovery:** on startup each process registers its pid in the file's
  `activePids` list and removes it on `SIGINT`/`SIGTERM`/exit. If the file
  exists but every recorded pid is dead, the next server in resets the file.
  Hard kills (SIGKILL, OS reboot mid-session) leave dead pids behind until
  the next reset.
- **Promise resolvers don't cross processes.** `registerPending` returns a
  Promise that polls the shared `results` map; `resolvePending`/`rejectPending`
  write into that map. The polling is the workaround's price tag.
