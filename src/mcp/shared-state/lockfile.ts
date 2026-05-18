import fs from "node:fs";

// Raised to 2000ms to give the read/mutate split time to succeed even under
// moderate contention — the common read path now avoids the lock entirely, so
// the spin budget only burns when a true write collision occurs, making a
// longer budget worthwhile without starving callers.
const SPIN_BUDGET_MS = 2000;
const STALE_LOCK_MS = 4000;
// Inter-retry jitter range: sleep 1–5ms between contended retries to reduce
// thundering-herd behaviour when multiple processes spin simultaneously.
const JITTER_MIN_MS = 1;
const JITTER_MAX_MS = 5;

function sleepSync(ms: number): void {
  // Node.js has no built-in synchronous sleep. Spinning on Date.now() for
  // 1–5ms is acceptable given how rarely real lock contention occurs.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

export function withFileLockSync<T>(lockPath: string, fn: () => T): T {
  const start = Date.now();
  let fd: number | undefined;
  while (true) {
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // raced — retry
          }
          continue;
        }
      } catch {
        // lock vanished between EEXIST and stat — retry
      }
      if (Date.now() - start > SPIN_BUDGET_MS) {
        throw new Error(
          `withFileLockSync: could not acquire ${lockPath} within ${SPIN_BUDGET_MS}ms`
        );
      }
      // Add 1–5ms jitter before retrying to reduce thundering herd.
      const jitter =
        JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
      sleepSync(jitter);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // closing a freed fd is harmless
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // unlinking a vanished lock is harmless
    }
  }
}
