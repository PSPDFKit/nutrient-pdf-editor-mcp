import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BridgeBackend,
  DocumentStateBackend,
  DocumentCheckpoint,
  LicenseStateBackend,
  SessionBackend,
  ViewerCommand
} from "../session.js";
import type { LicenseErrorPayload } from "../../contract/viewer-errors.js";
import { withFileLockSync } from "./lockfile.js";

interface PersistedState {
  viewUUID: string;
  /**
   * Per-viewUUID command queues. Replaces the prior single global queue so
   * `open_document`'s broadcast-close can target prior viewUUIDs and so
   * commands enqueued for one conversation cannot bleed into another's
   * iframe. Operating-tool commands without an explicit viewUUID land in
   * the *active* viewUUID's queue (see `enqueue` below).
   */
  queues: Record<string, ViewerCommand[]>;
  /**
   * @deprecated Kept for forward-compatibility when reading state files written
   * by older server versions. This JSON field was replaced with per-view
   * marker files under `<stateDir>/live/<viewUUID>` so `markViewLive` no longer
   * requires the file lock. New writes never populate this field.
   */
  liveViews?: Record<string, number>;
  documentPath: string | null;
  results: Record<string, { data?: unknown; error?: string; ts: number }>;
  activePids: number[];
  documentDirty: boolean;
  documentCheckpoint: DocumentCheckpoint | null;
  isPendingSave: boolean;
  licenseError: LicenseErrorPayload | null;
}

/**
 * Shared tick interval. Both the cross-process pending-result watcher in
 * this file and the long-poll handler's queue-peek tick in
 * `internal-tools.ts` use this so a single knob bounds observation latency
 * across both signal channels.
 */
export const POLL_INTERVAL_MS = 50;
const PENDING_TIMEOUT_MS = 60000;
const RESULT_TTL_MS = 120000;

export interface SharedFileBackendOptions {
  stateDir?: string;
}

export function createSharedFileBackend(opts: SharedFileBackendOptions = {}): SessionBackend {
  const stateDir = opts.stateDir ?? path.join(os.tmpdir(), "nutrient-pdf-editor");
  // SR-003: create the staging dir with explicit 0o700 (umask-independent)
  // and verify ownership/mode after the fact so a same-UID attacker can't
  // pre-seed a world-traversable dir or plant a symlink at this path.
  // We use lstatSync (not statSync) so a symlink does not transparently
  // resolve to a directory we'd then accept.
  // Windows: process.getuid is undefined there. We fail closed — the project
  // ships on macOS/Linux only and is never tested on Windows, so refusing to
  // start is safer than skipping the ownership check.
  // Migration: if the dir pre-existed from before SR-003 landed (typical
  // mode 0o755 from the default umask), and we own it, chmod it down to
  // 0o700 in place rather than refusing to start. The threat the check
  // guards against is "an attacker pre-created the dir before we ran"; if
  // the uid already matches us and it's not a symlink, the dir is ours and
  // tightening the mode is safe. We refuse only on uid mismatch, symlink,
  // or non-directory.
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let stat = fs.lstatSync(stateDir);
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error(
      `shared-state: cannot verify ownership of ${stateDir} on this platform ` +
        `(process.getuid is unavailable; nutrient-pdf-editor supports macOS/Linux only)`
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) {
    throw new Error(
      `shared-state dir ${stateDir} has unexpected ownership ` +
        `(uid=${stat.uid}, mode=${(stat.mode & 0o777).toString(8)}, ` +
        `symlink=${stat.isSymbolicLink()}, directory=${stat.isDirectory()})`
    );
  }
  if ((stat.mode & 0o777) !== 0o700) {
    // Owned by us, real directory, just wrong mode — tighten in place.
    // Common path: migrating a pre-SR-003 dir created with the default umask.
    fs.chmodSync(stateDir, 0o700);
    stat = fs.lstatSync(stateDir);
    if ((stat.mode & 0o777) !== 0o700) {
      throw new Error(
        `shared-state dir ${stateDir} could not be tightened to 0o700 ` +
          `(observed mode=${(stat.mode & 0o777).toString(8)} after chmod)`
      );
    }
  }
  const stateFile = path.join(stateDir, "state.json");
  const lockFile = path.join(stateDir, "state.lock");
  // Per-view marker files live under <stateDir>/live/<viewUUID>.
  // markViewLive touches the file with utimesSync (no lock needed); the mtime
  // is used by getLiveViewUUIDs to filter stale views. This eliminates the
  // lock acquisition on every poll_commands tick.
  const liveDir = path.join(stateDir, "live");
  fs.mkdirSync(liveDir, { recursive: true, mode: 0o700 });

  // ---------------------------------------------------------------------------
  // LiveMarkers — lockless per-view marker files under <stateDir>/live/
  // markViewLive uses utimesSync (single syscall, no lock); getLiveViewUUIDs
  // reads mtimes. This eliminates lock contention on every poll_commands tick.
  // ---------------------------------------------------------------------------
  const _liveMarkers = {
    markerPath(viewUUID: string): string {
      // Sanitize: viewUUID is a crypto.randomUUID() value so it only contains
      // hex digits and hyphens — no traversal risk. Belt-and-suspenders: strip
      // any non-hex-hyphen chars before joining.
      const safe = viewUUID.replace(/[^0-9a-f-]/gi, "_");
      return path.join(liveDir, safe);
    },

    touch(viewUUID: string): void {
      const mp = _liveMarkers.markerPath(viewUUID);
      const now = new Date();
      try {
        // utimesSync is atomic (single syscall) and requires no lock.
        // If the file doesn't exist yet, create it first via writeFileSync.
        if (!fs.existsSync(mp)) {
          fs.writeFileSync(mp, "", { mode: 0o600 });
        }
        fs.utimesSync(mp, now, now);
      } catch {
        // best-effort — a missed touch just causes the view to appear stale
      }
    },

    remove(viewUUID: string): void {
      try {
        fs.unlinkSync(_liveMarkers.markerPath(viewUUID));
      } catch {
        // best-effort — marker may already be gone
      }
    },

    readAll(staleAfterMs?: number): string[] {
      try {
        const entries = fs.readdirSync(liveDir);
        if (staleAfterMs === undefined) return entries;
        const cutoff = Date.now() - staleAfterMs;
        return entries.filter((name) => {
          try {
            const mp = path.join(liveDir, name);
            const mtime = fs.statSync(mp).mtimeMs;
            return mtime >= cutoff;
          } catch {
            return false;
          }
        });
      } catch {
        return [];
      }
    }
  };

  // ---------------------------------------------------------------------------
  // StateFile — read/write/mutate the shared state.json under the file lock.
  // mutate() is the only entry-point for writes; read() is used for lock-free
  // fast-path reads in takeResult and the hasOpenDocument / getDocumentPath /
  // isDocumentDirty / getDocumentCheckpoint / isPendingSave / getLicenseError
  // getters.
  // ---------------------------------------------------------------------------
  function read(): PersistedState {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      // Reviver drops __proto__ keys to prevent prototype-poisoning attacks.
      // The state file is written by our own process, but it lives in a
      // user-writable tmpdir; the reviver is a cheap defence-in-depth measure
      // against a malicious state file being planted there (e.g. symlink swap).
      const parsed = JSON.parse(raw, (k, v) =>
        k === "__proto__" ? undefined : v
      ) as Partial<PersistedState>;
      return {
        viewUUID: parsed.viewUUID ?? randomUUID(),
        queues: parsed.queues ?? {},
        // liveViews intentionally omitted — view-liveness tracking moved to
        // per-file markers in <stateDir>/live/. Old state files may still
        // carry this field; we ignore it on read.
        documentPath: parsed.documentPath ?? null,
        results: parsed.results ?? {},
        activePids: parsed.activePids ?? [],
        documentDirty: parsed.documentDirty ?? false,
        documentCheckpoint: parsed.documentCheckpoint ?? null,
        isPendingSave: parsed.isPendingSave ?? false,
        licenseError: parsed.licenseError ?? null
      };
    } catch {
      return {
        viewUUID: randomUUID(),
        queues: {},
        documentPath: null,
        results: {},
        activePids: [],
        documentDirty: false,
        documentCheckpoint: null,
        isPendingSave: false,
        licenseError: null
      };
    }
  }

  function write(state: PersistedState): void {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }

  function gcResults(state: PersistedState): void {
    const now = Date.now();
    for (const [id, entry] of Object.entries(state.results)) {
      if (now - entry.ts > RESULT_TTL_MS) delete state.results[id];
    }
  }

  function mutate<T>(fn: (state: PersistedState) => T): T {
    return withFileLockSync(lockFile, () => {
      const state = read();
      gcResults(state);
      const out = fn(state);
      write(state);
      return out;
    });
  }

  // Split read from mutate in takeResult. The common case (no result yet)
  // does a lock-free read to avoid acquiring the file lock on every 50ms poll
  // tick. Only when a result is present do we lock to delete it.
  function takeResult(requestId: string): { data?: unknown; error?: string } | null {
    // Fast path: lock-free read. If nothing is there, skip the lock.
    const quick = read();
    if (!quick.results[requestId]) return null;
    // Slow path: result exists — acquire the lock to atomically delete it.
    return mutate((state) => {
      const entry = state.results[requestId];
      if (!entry) return null; // raced — another process consumed it
      delete state.results[requestId];
      return entry;
    });
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  let cachedViewUUID = "";
  mutate((state) => {
    state.activePids = state.activePids.filter(isAlive);
    if (state.activePids.length === 0) {
      state.viewUUID = randomUUID();
      state.queues = {};
      // liveViews moved to marker files — clear the live dir instead.
      try {
        for (const f of fs.readdirSync(liveDir)) {
          try {
            fs.unlinkSync(path.join(liveDir, f));
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* best-effort */
      }
      state.documentPath = null;
      state.results = {};
      state.documentDirty = false;
      state.documentCheckpoint = null;
      state.isPendingSave = false;
      state.licenseError = null;
    }
    if (!state.activePids.includes(process.pid)) {
      state.activePids.push(process.pid);
    }
    cachedViewUUID = state.viewUUID;
  });

  function deregister(): void {
    // Remove this process's view marker on shutdown.
    _liveMarkers.remove(cachedViewUUID);
    try {
      mutate((state) => {
        state.activePids = state.activePids.filter((p) => p !== process.pid);
      });
    } catch {
      // best-effort on shutdown
    }
  }
  process.on("exit", deregister);
  process.on("SIGINT", () => {
    deregister();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    deregister();
    process.exit(143);
  });

  // ---------------------------------------------------------------------------
  // Internal sub-objects — grouped for navigability, matching the pattern used
  // by singleProcessBackend in session.ts (_bridge / _doc / _license).
  // These are NOT exported; the returned SessionBackend is spread from all
  // three so the external shape is unchanged.
  // ---------------------------------------------------------------------------

  /** Bridge: viewUUID routing, per-view command queues, pending-response registry. */
  const _bridge: BridgeBackend = {
    getViewUUID(): string {
      return cachedViewUUID;
    },

    setActiveViewUUID(viewUUID: string): void {
      cachedViewUUID = viewUUID;
      mutate((state) => {
        state.viewUUID = viewUUID;
      });
    },

    enqueue(cmd: ViewerCommand): void {
      // Push to the *active* view's queue. Convenience wrapper for the common
      // case where the operating tool just enqueues for "the current iframe."
      _bridge.enqueueToView(cachedViewUUID, cmd);
    },

    drain(): ViewerCommand[] {
      // Drain the *active* view's queue. Used by the legacy `drain()`
      // export; production polling now goes through `drainView(viewUUID)`
      // so each iframe drains its own queue.
      return _bridge.drainView(cachedViewUUID);
    },

    enqueueToView(viewUUID: string, cmd: ViewerCommand): void {
      mutate((state) => {
        const q = state.queues[viewUUID] ?? [];
        q.push(cmd);
        state.queues[viewUUID] = q;
      });
    },

    drainView(viewUUID: string): ViewerCommand[] {
      return mutate((state) => {
        const next = state.queues[viewUUID] ?? [];
        if (next.length > 0) state.queues[viewUUID] = [];
        return next;
      });
    },

    hasPendingCommands(viewUUID: string): boolean {
      // Lock-free read: at one tick per 50 ms per parked poll, taking the
      // file lock here would dominate. Eventual consistency is fine —
      // a missed tick just delays the wake by ~50 ms.
      const q = read().queues[viewUUID];
      return q !== undefined && q.length > 0;
    },

    markViewLive(viewUUID: string): void {
      // Replaced JSON-state-file write (required lock) with a lockless
      // utimesSync on a per-view marker file. This eliminates lock contention
      // on every poll_commands tick — the single most frequent state mutation
      // in the cross-process path.
      _liveMarkers.touch(viewUUID);
    },

    getLiveViewUUIDs(staleAfterMs?: number): string[] {
      // Read from marker files instead of JSON state.
      return _liveMarkers.readAll(staleAfterMs);
    },

    registerPending(requestId: string): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = (): void => {
          try {
            const entry = takeResult(requestId);
            if (entry) {
              if (entry.error !== undefined) {
                reject(new Error(entry.error));
              } else {
                resolve(entry.data);
              }
              return;
            }
            if (Date.now() - start > PENDING_TIMEOUT_MS) {
              reject(new Error(`shared-state: pending result timeout for ${requestId}`));
              return;
            }
            setTimeout(tick, POLL_INTERVAL_MS);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        tick();
      });
    },

    resolvePending(requestId: string, payload: unknown): void {
      mutate((state) => {
        state.results[requestId] = { data: payload, ts: Date.now() };
      });
    },

    rejectPending(requestId: string, err: Error): void {
      mutate((state) => {
        state.results[requestId] = { error: err.message, ts: Date.now() };
      });
    },

    deletePending(requestId: string): void {
      // In the file-backend, pending entries are poll-based. Deleting the
      // result entry (if one was already written) prevents a stale resolve
      // from being consumed after a timeout. The polling promise will
      // self-expire via its own PENDING_TIMEOUT_MS guard.
      mutate((state) => {
        delete state.results[requestId];
      });
    }
  };

  /** Document state: open/close lifecycle, dirty flag, fs-checkpoint, pending-save. */
  const _doc: DocumentStateBackend = {
    setOpenDocument(documentPath: string): void {
      // Mirror singleProcessBackend (src/mcp/session.ts): opening (or in-place-
      // switching to) a document resets staleness/save bookkeeping so flags
      // set against a prior path don't leak into the new one. The checkpoint
      // is re-set by `startWatching()` immediately after, so dropping it here
      // is safe.
      mutate((state) => {
        state.documentPath = documentPath;
        state.documentDirty = false;
        state.documentCheckpoint = null;
        state.isPendingSave = false;
        state.licenseError = null;
      });
    },

    clearOpenDocument(): void {
      // Remove the view's liveness marker on close so getLiveViewUUIDs
      // stops reporting it immediately (no need to wait for the stale cutoff).
      _liveMarkers.remove(cachedViewUUID);
      mutate((state) => {
        state.documentPath = null;
        state.documentDirty = false;
        state.documentCheckpoint = null;
        state.isPendingSave = false;
        state.licenseError = null;
      });
    },

    hasOpenDocument(): boolean {
      return read().documentPath !== null;
    },

    getDocumentPath(): string | null {
      return read().documentPath;
    },

    setDocumentDirty(dirty: boolean): void {
      mutate((state) => {
        state.documentDirty = dirty;
      });
    },

    isDocumentDirty(): boolean {
      return read().documentDirty;
    },

    setDocumentCheckpoint(cp: DocumentCheckpoint | null): void {
      mutate((state) => {
        state.documentCheckpoint = cp;
      });
    },

    getDocumentCheckpoint(): DocumentCheckpoint | null {
      return read().documentCheckpoint;
    },

    setIsPendingSave(pending: boolean): void {
      mutate((state) => {
        state.isPendingSave = pending;
      });
    },

    isPendingSave(): boolean {
      return read().isPendingSave;
    }
  };

  /** License state: persisted at load time, cleared on each new open_document. */
  const _license: LicenseStateBackend = {
    setLicenseError(payload: LicenseErrorPayload): void {
      mutate((state) => {
        state.licenseError = payload;
      });
    },

    clearLicenseError(): void {
      mutate((state) => {
        state.licenseError = null;
      });
    },

    getLicenseError(): LicenseErrorPayload | null {
      return read().licenseError;
    }
  };

  return { ..._bridge, ..._doc, ..._license };
}
