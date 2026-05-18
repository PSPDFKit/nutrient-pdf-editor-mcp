import { randomUUID } from "node:crypto";
import type { LicenseErrorPayload } from "../contract/viewer-errors.js";
// ViewerCommand is the single source of truth in src/contract/ — no longer
// duplicated here. Imported for local use and re-exported so existing
// consumers (bridge.ts, tools/*.ts) that imported from "./session.js"
// continue to work without changes.
import type { ViewerCommand } from "../contract/viewer-commands.js";
export type { ViewerCommand } from "../contract/viewer-commands.js";

export interface SessionState {
  /**
   * The "active" viewUUID — the iframe that the most-recent `open_document`
   * is bound to. Operating-tool commands enqueued via `enqueue()` (no
   * explicit view) target this iframe. Replaced on every `open_document`.
   */
  viewUUID: string;
  pending: Map<string, { resolve: (payload: unknown) => void; reject: (err: Error) => void }>;
  documentPath: string | null;
}

export interface DocumentCheckpoint {
  size: number;
  mtime: number;
}

/**
 * Three focused backend sub-interfaces. `SessionBackend` is their
 * intersection — existing code that types against `SessionBackend` is
 * unchanged; new code can accept the narrowest interface it needs.
 */

/**
 * Bridge operations: viewUUID routing, per-view command queues, and the
 * pending-response registry used by `enqueueAndWait` in bridge.ts.
 */
export interface BridgeBackend {
  getViewUUID(): string;
  setActiveViewUUID(viewUUID: string): void;
  /** Push to the *active* view's queue. */
  enqueue(cmd: ViewerCommand): void;
  /** Drain the *active* view's queue. */
  drain(): ViewerCommand[];
  /** Push to a specific view's queue (used for cross-view broadcasts). */
  enqueueToView(viewUUID: string, cmd: ViewerCommand): void;
  /** Drain a specific view's queue (used by `poll_commands`). */
  drainView(viewUUID: string): ViewerCommand[];
  /** Non-destructive check for queued commands. Used by the long-poll
   *  handler's tick to detect cross-process enqueues without draining. */
  hasPendingCommands(viewUUID: string): boolean;
  /** Record that a view polled at this moment. Used to expire dead views. */
  markViewLive(viewUUID: string): void;
  /**
   * Return all viewUUIDs that polled within the last `staleAfterMs` ms.
   * Pass `undefined` to get every recorded view regardless of recency.
   */
  getLiveViewUUIDs(staleAfterMs?: number): string[];
  registerPending(requestId: string): Promise<unknown>;
  resolvePending(requestId: string, payload: unknown): void;
  rejectPending(requestId: string, err: Error): void;
  /** Remove a pending entry without resolving or rejecting it (timeout cleanup). */
  deletePending(requestId: string): void;
}

/**
 * Document state: open/close lifecycle, dirty flag, fs-checkpoint, and
 * pending-save flag used by the auto-save loop and the staleness watcher.
 */
export interface DocumentStateBackend {
  setOpenDocument(documentPath: string): void;
  clearOpenDocument(): void;
  hasOpenDocument(): boolean;
  getDocumentPath(): string | null;
  setDocumentDirty(dirty: boolean): void;
  isDocumentDirty(): boolean;
  setDocumentCheckpoint(cp: DocumentCheckpoint | null): void;
  getDocumentCheckpoint(): DocumentCheckpoint | null;
  setIsPendingSave(pending: boolean): void;
  isPendingSave(): boolean;
}

/**
 * License error state: persisted at load time and cleared on each new
 * open_document. Consulted by `requireValidLicense()`.
 */
export interface LicenseStateBackend {
  /**
   * Persist the license error payload observed at load time. Once set,
   * every subsequent `requireValidLicense()` call throws McpError with
   * LICENSE_ERROR. Cleared by a new `open_document` so a license fix
   * takes effect on the next open.
   */
  setLicenseError(payload: LicenseErrorPayload): void;
  clearLicenseError(): void;
  getLicenseError(): LicenseErrorPayload | null;
}

/**
 * Composition of all three backends. Existing code types against this;
 * new callers can accept the narrowest interface they actually need.
 */
export type SessionBackend = BridgeBackend & DocumentStateBackend & LicenseStateBackend;

const STATE: SessionState = {
  viewUUID: randomUUID(),
  pending: new Map(),
  documentPath: null
};

const queues: Map<string, ViewerCommand[]> = new Map();
const liveViews: Map<string, number> = new Map();

// One in-flight long-poll waiter per viewUUID. The callback resolves the
// parked `poll_commands` Promise so it can drain and return immediately.
// Only populated by the in-memory backend; the shared-state path falls back
// to a 50 ms tick on `peekViewLength` (see internal-tools.ts).
const pollWaiters: Map<string, () => void> = new Map();

// Stale-view sweep configuration. Tuning, not configuration — no env-var
// override. A view that hasn't polled in `VIEW_TTL_MS` is treated as
// abandoned: its queue, heartbeat, and any parked waiter are dropped.
const VIEW_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

interface FsSyncState {
  documentDirty: boolean;
  documentCheckpoint: DocumentCheckpoint | null;
  isPendingSave: boolean;
  licenseError: LicenseErrorPayload | null;
}

const FS_SYNC: FsSyncState = {
  documentDirty: false,
  documentCheckpoint: null,
  isPendingSave: false,
  licenseError: null
};

// ---------------------------------------------------------------------------
// Internal sub-objects — grouped for navigability.
// These are NOT part of SessionBackend; they are private implementation
// details of the in-memory backend only. The returned singleProcessBackend
// object is spread from all three so the external SessionBackend shape is
// unchanged and every caller continues to work without modification.
// (TODO Tier-3: apply equivalent sub-grouping to SharedFileBackend in
//  src/mcp/shared-state/file-backend.ts.)
// ---------------------------------------------------------------------------

/** Bridge: viewUUID routing, per-view queues, pending-response registry. */
const _bridge: BridgeBackend = {
  getViewUUID(): string {
    return STATE.viewUUID;
  },
  setActiveViewUUID(viewUUID: string): void {
    STATE.viewUUID = viewUUID;
  },
  enqueue(cmd: ViewerCommand): void {
    _bridge.enqueueToView(STATE.viewUUID, cmd);
  },
  drain(): ViewerCommand[] {
    return _bridge.drainView(STATE.viewUUID);
  },
  enqueueToView(viewUUID: string, cmd: ViewerCommand): void {
    const q = queues.get(viewUUID);
    if (q) q.push(cmd);
    else queues.set(viewUUID, [cmd]);
    wakePollWaiter(viewUUID);
  },
  drainView(viewUUID: string): ViewerCommand[] {
    const q = queues.get(viewUUID);
    if (!q || q.length === 0) return [];
    queues.set(viewUUID, []);
    return q;
  },
  hasPendingCommands(viewUUID: string): boolean {
    const q = queues.get(viewUUID);
    return q !== undefined && q.length > 0;
  },
  markViewLive(viewUUID: string): void {
    liveViews.set(viewUUID, Date.now());
  },
  getLiveViewUUIDs(staleAfterMs?: number): string[] {
    if (staleAfterMs === undefined) return Array.from(liveViews.keys());
    const cutoff = Date.now() - staleAfterMs;
    const out: string[] = [];
    for (const [uuid, ts] of liveViews.entries()) {
      if (ts >= cutoff) out.push(uuid);
    }
    return out;
  },
  registerPending(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      STATE.pending.set(requestId, { resolve, reject });
    });
  },
  resolvePending(requestId: string, payload: unknown): void {
    const entry = STATE.pending.get(requestId);
    if (!entry) return;
    STATE.pending.delete(requestId);
    entry.resolve(payload);
  },
  rejectPending(requestId: string, err: Error): void {
    const entry = STATE.pending.get(requestId);
    if (!entry) return;
    STATE.pending.delete(requestId);
    entry.reject(err);
  },
  deletePending(requestId: string): void {
    STATE.pending.delete(requestId);
  }
};

/** Document state: open/close lifecycle, dirty flag, fs-checkpoint, pending-save. */
const _doc: DocumentStateBackend = {
  setOpenDocument(documentPath: string): void {
    // Reset FS-sync flags too: opening (or in-place-switching to) a document
    // starts a fresh staleness/save bookkeeping for that path. Without this,
    // a `documentDirty=true` set against a prior path would persist into the
    // new path's session and reject every subsequent operating tool, and a
    // mid-bracket `isPendingSave=true` would briefly suppress the new
    // watcher's first event. The checkpoint is re-set by `startWatching()`
    // immediately after, so dropping it here is safe.
    STATE.documentPath = documentPath;
    FS_SYNC.documentDirty = false;
    FS_SYNC.documentCheckpoint = null;
    FS_SYNC.isPendingSave = false;
    // Clear any prior license error — a new open_document attempt means the
    // operator may have fixed the license key; let the viewer re-evaluate.
    FS_SYNC.licenseError = null;
  },
  clearOpenDocument(): void {
    STATE.documentPath = null;
    FS_SYNC.documentDirty = false;
    FS_SYNC.documentCheckpoint = null;
    FS_SYNC.isPendingSave = false;
    // Clear license error on close too: session is being torn down.
    FS_SYNC.licenseError = null;
  },
  hasOpenDocument(): boolean {
    return STATE.documentPath !== null;
  },
  getDocumentPath(): string | null {
    return STATE.documentPath;
  },
  setDocumentDirty(dirty: boolean): void {
    FS_SYNC.documentDirty = dirty;
  },
  isDocumentDirty(): boolean {
    return FS_SYNC.documentDirty;
  },
  setDocumentCheckpoint(cp: DocumentCheckpoint | null): void {
    FS_SYNC.documentCheckpoint = cp;
  },
  getDocumentCheckpoint(): DocumentCheckpoint | null {
    return FS_SYNC.documentCheckpoint;
  },
  setIsPendingSave(pending: boolean): void {
    FS_SYNC.isPendingSave = pending;
  },
  isPendingSave(): boolean {
    return FS_SYNC.isPendingSave;
  }
};

/** License state: persisted at load time, cleared on each new open_document. */
const _license: LicenseStateBackend = {
  setLicenseError(payload: LicenseErrorPayload): void {
    FS_SYNC.licenseError = payload;
  },
  clearLicenseError(): void {
    FS_SYNC.licenseError = null;
  },
  getLicenseError(): LicenseErrorPayload | null {
    return FS_SYNC.licenseError;
  }
};

const singleProcessBackend: SessionBackend = { ..._bridge, ..._doc, ..._license };

function selectBackend(): SessionBackend {
  // BEGIN cross-process workaround — see src/mcp/shared-state/README.md
  if (process.env.NUTRIENT_SHARED_STATE === "1") {
    // Lazy require so test runs without the env var don't load the workaround
    // and so removing src/mcp/shared-state/ leaves session.ts compilable.
    const { createSharedFileBackend } = require("./shared-state/file-backend.js");
    const backend = createSharedFileBackend() as SessionBackend;
    // Keep STATE.viewUUID in sync so getSession() readers (legacy) see the
    // shared UUID. The singleProcessBackend queue/pending become inert; no
    // production call site reads them directly when this backend is active.
    STATE.viewUUID = backend.getViewUUID();
    return backend;
  }
  // END cross-process workaround
  return singleProcessBackend;
}

const backend: SessionBackend = selectBackend();

export function getSession(): SessionState {
  if (backend === singleProcessBackend) return STATE;
  return {
    viewUUID: backend.getViewUUID(),
    pending: STATE.pending,
    documentPath: backend.getDocumentPath()
  };
}

export function setActiveViewUUID(viewUUID: string): void {
  backend.setActiveViewUUID(viewUUID);
  // Keep STATE in sync for in-memory callers reading STATE directly. (The
  // shared-state backend bypasses STATE.viewUUID; the singleProcessBackend
  // version writes STATE.viewUUID itself, so this is a no-op there. The
  // explicit write here makes intent clear and survives backend swaps.)
  STATE.viewUUID = viewUUID;
}

export function enqueue(cmd: ViewerCommand): void {
  backend.enqueue(cmd);
}

export function drain(): ViewerCommand[] {
  return backend.drain();
}

export function enqueueToView(viewUUID: string, cmd: ViewerCommand): void {
  backend.enqueueToView(viewUUID, cmd);
}

export function drainView(viewUUID: string): ViewerCommand[] {
  return backend.drainView(viewUUID);
}

export function markViewLive(viewUUID: string): void {
  backend.markViewLive(viewUUID);
}

export function getLiveViewUUIDs(staleAfterMs?: number): string[] {
  return backend.getLiveViewUUIDs(staleAfterMs);
}

export function hasPendingCommands(viewUUID: string): boolean {
  return backend.hasPendingCommands(viewUUID);
}

/**
 * Register a one-shot resolver keyed by viewUUID. If a prior waiter exists,
 * fire it first to preserve the single-in-flight-per-view invariant. The
 * returned cancel removes the waiter without firing it.
 */
export function installPollWaiter(viewUUID: string, resolve: () => void): () => void {
  const prev = pollWaiters.get(viewUUID);
  if (prev) {
    pollWaiters.delete(viewUUID);
    prev();
  }
  pollWaiters.set(viewUUID, resolve);
  return () => {
    if (pollWaiters.get(viewUUID) === resolve) {
      pollWaiters.delete(viewUUID);
    }
  };
}

function wakePollWaiter(viewUUID: string): void {
  const waiter = pollWaiters.get(viewUUID);
  if (!waiter) return;
  pollWaiters.delete(viewUUID);
  waiter();
}

/**
 * Drop views whose heartbeat is older than `VIEW_TTL_MS`. Iterates
 * `liveViews` (not `queues` — drained queues are empty by definition).
 * Wakes any parked waiter before deletion so its `poll_commands` returns
 * an empty result instead of holding the closure for the long-poll timeout.
 */
export function pruneStaleViews(): void {
  const now = Date.now();
  for (const [uuid, ts] of liveViews.entries()) {
    if (now - ts <= VIEW_TTL_MS) continue;
    liveViews.delete(uuid);
    queues.delete(uuid);
    const waiter = pollWaiters.get(uuid);
    if (waiter) {
      pollWaiters.delete(uuid);
      waiter();
    }
  }
}

/**
 * Start the periodic stale-view sweep. Returns the `NodeJS.Timeout` so the
 * caller can cancel it in tests; production never does. `.unref()` so the
 * sweep doesn't keep the process alive on its own.
 */
export function startStaleViewSweep(): NodeJS.Timeout {
  return setInterval(pruneStaleViews, SWEEP_INTERVAL_MS).unref();
}

export function registerPending(requestId: string): Promise<unknown> {
  return backend.registerPending(requestId);
}

export function resolvePending(requestId: string, payload: unknown): void {
  backend.resolvePending(requestId, payload);
}

export function rejectPending(requestId: string, err: Error): void {
  backend.rejectPending(requestId, err);
}

export function deletePending(requestId: string): void {
  backend.deletePending(requestId);
}

export function setOpenDocument(documentPath: string): void {
  backend.setOpenDocument(documentPath);
}

export function clearOpenDocument(): void {
  backend.clearOpenDocument();
}

export function hasOpenDocument(): boolean {
  return backend.hasOpenDocument();
}

export function getDocumentPath(): string | null {
  return backend.getDocumentPath();
}

export function setDocumentDirty(dirty: boolean): void {
  backend.setDocumentDirty(dirty);
}

export function isDocumentDirty(): boolean {
  return backend.isDocumentDirty();
}

export function setDocumentCheckpoint(cp: DocumentCheckpoint | null): void {
  backend.setDocumentCheckpoint(cp);
}

export function getDocumentCheckpoint(): DocumentCheckpoint | null {
  return backend.getDocumentCheckpoint();
}

export function setIsPendingSave(pending: boolean): void {
  backend.setIsPendingSave(pending);
}

export function isPendingSave(): boolean {
  return backend.isPendingSave();
}

export function setLicenseError(payload: LicenseErrorPayload): void {
  backend.setLicenseError(payload);
}

export function clearLicenseError(): void {
  backend.clearLicenseError();
}

export function getLicenseError(): LicenseErrorPayload | null {
  return backend.getLicenseError();
}

/**
 * Test-only: clear every per-process map so test isolation isn't tripped by
 * leftover queues / live-view marks from a prior test. Production code does
 * not call this — view state evolves naturally from `open_document` and
 * `poll_commands`.
 */
export function __resetForTesting(): void {
  queues.clear();
  liveViews.clear();
  // Resolve any parked waiters before clearing so awaiting callers don't
  // hang forever in tests that swap fixtures mid-flight.
  for (const [, waiter] of pollWaiters) waiter();
  pollWaiters.clear();
  STATE.pending.clear();
  STATE.documentPath = null;
  FS_SYNC.documentDirty = false;
  FS_SYNC.documentCheckpoint = null;
  FS_SYNC.isPendingSave = false;
  FS_SYNC.licenseError = null;
}
