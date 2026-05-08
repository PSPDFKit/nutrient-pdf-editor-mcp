import { setupAutoSaveOnInstance, type AutoSaveController } from "./auto-save.js";
import type { ChunkedWriteSink } from "./document-save.js";
// Static imports for command-handler modules. The Vite single-file build inlines
// all modules into mcp-app.html anyway, so dynamic `await import()` in each handler
// was cargo-culted from a code-splitting context and adds only microtask overhead.
import { buildAnnotation } from "./build-annotation.js";
import type { AnnotationInput } from "../contract/annotation-types.js";
import {
  updateAnnotation as updateAnnotationImpl,
  deleteAnnotation as deleteAnnotationImpl,
  // sdkClassToType and extractRect live in annotation-operations.ts
  sdkClassToType,
  extractRect
} from "./annotation-operations.js";
import {
  readFormFields as readFormFieldsImpl,
  updateFormFieldValues as updateFormFieldValuesImpl
} from "./form-operations.js";
// Pure document-command functions live in document-commands.ts
import {
  getViewStateData,
  applySetViewState,
  searchExact,
  readDocumentInfo,
  readPageInfo as readPageInfoPure,
  readTextPages
} from "./document-commands.js";
// applyRedactions lives in redaction-operations.ts
import { applyRedactions as applyRedactionsImpl } from "./redaction-operations.js";
// host-context: App singleton, frame-size negotiation, display-mode preference
import {
  app,
  applyHostContext,
  hasNonZeroContainerDimensions,
  awaitNonZeroContainerDimensions,
  preferFullscreenIfAvailable,
  negotiateFrameSize,
  __resetHostContextForTesting
} from "./host-context.js";
// Re-export for tests that import these from main.ts (backward compat).
export { preferFullscreenIfAvailable, negotiateFrameSize } from "./host-context.js";
// window-globals: typed accessors for server-injected window values
import {
  ASSET_BASE_URL,
  getAppName,
  NUTRIENT_LICENSE_KEY,
  getRenewalUrlFromWindow
} from "./window-globals.js";
// Re-export for tests that import getRenewalUrlFromWindow from main.ts.
export { getRenewalUrlFromWindow } from "./window-globals.js";
// error-fallbacks: DOM overlays + bridge error forwarding
import {
  renderUnloadedDocumentMessage,
  renderExpiredLicenseOverlay as renderExpiredLicenseOverlayImpl,
  submitLicenseError as submitLicenseErrorImpl,
  submitViewerError as submitViewerErrorImpl
} from "./error-fallbacks.js";
// All shared types and constants live in src/contract/ so neither
// src/mcp/ nor src/viewer/ imports the other's target-specific modules.
// The ESLint no-restricted-imports rule enforces this boundary.
import {
  classifyLoadError,
  type LicenseErrorSubKind,
  type ViewerErrorPayload
} from "../contract/viewer-errors.js";
import { DEFAULT_PAGE_IMAGE_WIDTH_PX } from "../contract/constants.js";
// ViewerCommand is the single source of truth in src/contract/ so both
// the Node server and the browser bundle share the same type definition.
import type { ViewerCommand } from "../contract/viewer-commands.js";

// ASSET_BASE_URL, getAppName, NUTRIENT_LICENSE_KEY, getRenewalUrlFromWindow
// are imported from ./window-globals.js above.

let viewUUID = "";
let pollingStarted = false;
// Lazily imported in openDocument; null until the first open succeeds.
type NutrientSDKType = typeof import("@nutrient-sdk/viewer").default;
type SdkInstance = import("@nutrient-sdk/viewer").Instance;
let NutrientSDK: NutrientSDKType | null = null;
let instance: SdkInstance | null = null;
// Track the document path passed to openDocument
let currentDocumentPath: string | null = null;
// Set while NutrientSDK.load is in flight. When this is true and `instance` is
// null, an operating tool firing in parallel with the open is the cause — the
// error message tells the caller to retry briefly.
let documentLoadInProgress = false;

// Controls the document.saveStateChange-driven auto-save loop. Re-installed
// per SDK instance (open / in-place swap), torn down on close.
let autoSaveController: AutoSaveController | null = null;

// Chunked String.fromCharCode approach to avoid call-stack overflow on
// large buffers. The naive Uint8Array.from(atob(...)) path in the browser has
// no stack limit, but the inverse — encoding a large Uint8Array to base64 —
// can overflow the call stack if done in one apply() call.
export function uint8ArrayToBase64(u8: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

// Off-main-thread PNG encoder. Spawned once at module load; all
// get_page_image encode work goes through this worker so the ~40–200ms
// blocking PNG encode does not block MCP command processing.
// We track pending encodes by requestId so we can resolve/reject individual
// Promises independently.
//
// The `?worker&inline` Vite query compiles the worker module into an inline
// Blob-URL Worker so viteSingleFile can embed it in the single-file HTML
// without a separate *.worker.js file. The CSP `script-src` directive covers
// blob: via the host's allowlist; Cowork permits blob: workers.
import PngEncoderWorkerFactory from "./png-encoder.worker.ts?worker&inline";

type PngWorkerResult =
  | { pngBuffer: ArrayBuffer; error?: undefined }
  | { pngBuffer?: undefined; error: string };

const pngWorkerPending = new Map<string, (result: PngWorkerResult) => void>();

// Spawn the worker lazily on first use to avoid issues in environments that
// don't support Workers (e.g. some test runners). The reference is cached so
// we only ever spawn one.
let _pngWorker: Worker | null = null;
function getPngWorker(): Worker {
  if (_pngWorker) return _pngWorker;
  _pngWorker = new PngEncoderWorkerFactory();
  _pngWorker.onmessage = (e: MessageEvent<{ requestId: string } & PngWorkerResult>) => {
    const { requestId, ...result } = e.data;
    const resolve = pngWorkerPending.get(requestId);
    if (resolve) {
      pngWorkerPending.delete(requestId);
      resolve(result as PngWorkerResult);
    }
  };
  _pngWorker.onerror = (e: ErrorEvent) => {
    // Worker-level error (syntax error, etc.) — reject all pending encodes.
    const msg = e.message ?? "png-encoder.worker: unknown error";
    for (const [id, resolve] of pngWorkerPending) {
      pngWorkerPending.delete(id);
      resolve({ error: msg });
    }
    _pngWorker = null; // allow respawn on next call
  };
  return _pngWorker;
}

function encodePngInWorker(
  requestId: string,
  pixelBuffer: ArrayBuffer,
  width: number,
  height: number
): Promise<PngWorkerResult> {
  return new Promise((resolve) => {
    pngWorkerPending.set(requestId, resolve);
    const worker = getPngWorker();
    // Transfer the pixel buffer zero-copy to the worker.
    worker.postMessage({ requestId, buffer: pixelBuffer, width, height }, [pixelBuffer]);
  });
}

// ChunkedWriteSink view of the ext-apps App for streaming exported PDF bytes
// back to the server's write_document_bytes internal tool. Module-level
// so we don't reallocate per save.
const autoSaveSink: ChunkedWriteSink = {
  async callServerTool(args) {
    return app.callServerTool(args);
  }
};

// Returns the right error string when an operating tool finds `instance == null`.
// Distinguishes "still loading" (parallel-call race; caller should retry) from
// "no document open" (pre-open or after close; caller should call open_document).
function noOpenInstanceError(): string {
  return documentLoadInProgress
    ? "Document is still loading. The open is asynchronous; wait briefly and retry."
    : "Document not open";
}

// app, applyHostContext, awaitNonZeroContainerDimensions, preferFullscreenIfAvailable,
// negotiateFrameSize are imported from ./host-context.js.

app.onerror = (err) => {
  console.error("[nutrient-viewer] App error:", err);
};

app.onteardown = async () => {
  // Flush any unsaved mutations before unloading — the host is about to tear
  // down this iframe so there will be no further save events.
  if (autoSaveController) {
    try {
      await autoSaveController.flushIfDirty();
    } catch {
      /* errors are routed through the controller's onError; swallow here */
    }
    autoSaveController.dispose();
    autoSaveController = null;
  }
  try {
    if (instance && NutrientSDK) {
      NutrientSDK.unload(instance);
      instance = null;
      currentDocumentPath = null;
    }
  } catch {
    /* ignore */
  }
  return {};
};

app.onhostcontextchanged = applyHostContext;

app.ontoolresult = async (result) => {
  // result._meta is set by ext-apps when the server returns CallToolResult with _meta
  const resultWithMeta = result as {
    _meta?: Record<string, unknown>;
    structuredContent?: { documentPath?: string; viewUUID?: string };
  };
  const meta = resultWithMeta._meta ?? {};
  const uuidValue = meta.viewUUID;
  if (uuidValue) {
    viewUUID = String(uuidValue);
    if (!pollingStarted) {
      pollingStarted = true;
      startPolling();
    }
  }
  // Idiomatic MCP Apps pattern: tool returns fast with documentPath, iframe
  // loads the document itself. Triggers on the open_document result.
  const nextPath = resultWithMeta.structuredContent?.documentPath;
  if (nextPath && nextPath !== currentDocumentPath) {
    await openDocumentFromPath(nextPath).catch((err) => {
      console.error("[nutrient-viewer] openDocumentFromPath failed:", err);
    });
  }
};

// renderUnloadedDocumentMessage is imported from ./error-fallbacks.js.

/**
 * Thin wrapper so call sites in main.ts don't need to pass `app`.
 * Tests import this from main.ts; error-fallbacks.ts exposes the testable
 * version that takes `app` as a parameter.
 */
export function renderExpiredLicenseOverlay(renewalUrl: string): void {
  renderExpiredLicenseOverlayImpl(renewalUrl, app);
}

// Only initialize the app in browser environment
if (typeof window !== "undefined") {
  (async () => {
    // E2E hook: expose app and skip the real PostMessage host handshake.
    // The harness stubs app.callServerTool and replays ontoolresult manually.
    if ((window as unknown as { __E2E_TEST?: boolean }).__E2E_TEST) {
      (window as unknown as { __app?: unknown }).__app = app;
      (window as unknown as { __e2eGetInstance?: () => unknown }).__e2eGetInstance = () => instance;
      return;
    }
    await app.connect();
    // preferFullscreenIfAvailable and negotiateFrameSize live in host-context.ts.
    // logDisplayModeAdvertisement is internal to host-context.ts and is called there.
    await preferFullscreenIfAvailable();
    await negotiateFrameSize();
  })();
}

// preferFullscreenIfAvailable and negotiateFrameSize are imported from host-context.ts
// and re-exported above for backward compat with tests.

// Tight loop. The server holds `poll_commands` open up to ~25 s (see
// `getLongPollTimeoutMs` in src/mcp/bridge.ts) and wakes immediately on
// enqueue, so client-side throttling would just re-introduce
// enqueue→drain latency. Each `handleCommand` awaits its `submit_response`
// before the next iteration so submits never queue behind the next poll.
const POLL_ERROR_BACKOFF_MS = 2000;
async function startPolling() {
  while (viewUUID) {
    try {
      const res = await app.callServerTool({
        name: "poll_commands",
        arguments: { viewUUID }
      });
      const resWithStructured = res as unknown as {
        structuredContent?: { commands: ViewerCommand[] };
      };
      const { commands } = resWithStructured.structuredContent ?? { commands: [] };
      for (const cmd of commands) {
        await handleCommand(cmd);
      }
    } catch {
      await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
    }
  }
}

// Typed dispatch table keyed by ViewerCommand["type"].
// The `Record<ViewerCommand["type"], ...>` shape provides exhaustiveness: if a
// new command variant is added to the ViewerCommand union in src/contract/ and
// the handler is not listed here, TypeScript will error with "Type ... is not
// assignable to type 'never'". No runtime exhaustiveness check is needed
// because the table is keyed exactly by the discriminant union.
type CommandHandler = (cmd: ViewerCommand) => Promise<void>;

const commandHandlers: Record<ViewerCommand["type"], CommandHandler> = {
  // open_document is handled directly in `ontoolresult` (idiomatic MCP Apps
  // pattern). The server tool returns fast; the iframe loads the document from
  // the `documentPath` in the tool result's structuredContent. There is no
  // queued command for open — the entry below is absent on purpose and the
  // polling loop never receives an open command.
  get_view_state: (cmd) => getViewState(cmd as Extract<ViewerCommand, { type: "get_view_state" }>),
  set_view_state: (cmd) => setViewState(cmd as Extract<ViewerCommand, { type: "set_view_state" }>),
  search_exact_text: (cmd) =>
    searchExactText(cmd as Extract<ViewerCommand, { type: "search_exact_text" }>),
  read_document_information: (cmd) =>
    readDocumentInformation(cmd as Extract<ViewerCommand, { type: "read_document_information" }>),
  read_page_info: (cmd) => readPageInfo(cmd as Extract<ViewerCommand, { type: "read_page_info" }>),
  get_page_image: (cmd) => getPageImage(cmd as Extract<ViewerCommand, { type: "get_page_image" }>),
  create_annotation: (cmd) =>
    createAnnotation(cmd as Extract<ViewerCommand, { type: "create_annotation" }>),
  read_annotations: (cmd) =>
    readAnnotations(cmd as Extract<ViewerCommand, { type: "read_annotations" }>),
  update_annotation: (cmd) =>
    updateAnnotation(cmd as Extract<ViewerCommand, { type: "update_annotation" }>),
  delete_annotation: (cmd) =>
    deleteAnnotation(cmd as Extract<ViewerCommand, { type: "delete_annotation" }>),
  apply_redactions_now: (cmd) =>
    applyRedactionsNow(cmd as Extract<ViewerCommand, { type: "apply_redactions_now" }>),
  read_form_fields: (cmd) =>
    readFormFields(cmd as Extract<ViewerCommand, { type: "read_form_fields" }>),
  update_form_field_values: (cmd) =>
    updateFormFieldValues(cmd as Extract<ViewerCommand, { type: "update_form_field_values" }>),
  read_text: (cmd) => readText(cmd as Extract<ViewerCommand, { type: "read_text" }>),
  close_document: (cmd) => closeDocument(cmd as Extract<ViewerCommand, { type: "close_document" }>)
};

async function handleCommand(cmd: ViewerCommand) {
  const handler = commandHandlers[cmd.type];
  if (handler) {
    await handler(cmd);
  } else {
    // Exhaustiveness guard: if this branch fires, a new ViewerCommand variant
    // was added to the contract without a handler entry above.
    const _exhaustive: never = cmd.type as never;
    void _exhaustive;
    console.warn(`[nutrient-viewer] handleCommand: unknown command type "${cmd.type}"`);
  }
}

export async function openDocumentFromPath(documentPath: string): Promise<void> {
  documentLoadInProgress = true;
  try {
    const viewerEl = document.getElementById("viewer");
    if (!viewerEl) {
      throw new Error("Viewer DOM missing required elements: #viewer");
    }

    if (!NutrientSDK) {
      const module = await import("@nutrient-sdk/viewer");
      NutrientSDK = module.default;
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await fetchDocumentBytes(documentPath);
    } catch (err) {
      // Conversation-rehydration fallback. Three cases land here, all
      // resolved the same way (render the "Reopen the document to
      // continue" placeholder, then re-throw so upstream sees the failure):
      //
      //   1. The new MCP server's session is empty (no `open_document` has
      //      run yet, or filesystem roots aren't advertised). Server
      //      returns "No document is open" / "has not advertised any
      //      filesystem roots".
      //   2. NEW (cross-conversation guard): the iframe was rehydrated in
      //      an old conversation while the active session belongs to a
      //      different conversation. The server returns the
      //      `stale-document-path:` sentinel — see
      //      `src/mcp/document-resource.ts` § STALE_PATH_ERROR_PREFIX.
      //      Without this guard the iframe would silently load the OTHER
      //      conversation's document.
      //   3. Some other I/O / read failure.
      //
      // Cases 1+2 produce the placeholder; case 3 propagates without UI.
      const message = err instanceof Error ? err.message : String(err);
      if (
        /no document is open/i.test(message) ||
        /has not advertised any filesystem roots/i.test(message) ||
        message.includes("stale-document-path:")
      ) {
        try {
          renderUnloadedDocumentMessage(documentPath);
        } catch {
          /* never let a DOM-rendering failure mask the original error */
        }
      }
      throw err;
    }

    // When the host window is off-screen at activation time, Cowork advertises
    // containerDimensions {0,0}. Mounting Nutrient into a zero-size container
    // strands the SDK at that size — there is no public re-layout API. Per the
    // MCP Apps spec, host-context-changed is the only documented signal for
    // layout updates, so wait for it to report non-zero dimensions before
    // mounting.
    if (!hasNonZeroContainerDimensions(app.getHostContext())) {
      await awaitNonZeroContainerDimensions();
    }

    // The Nutrient SDK refuses to mount into a non-empty container (throws
    // `Configuration#container is expected to be an empty element`). In the
    // single-iframe / single-conversation case this trips the
    // open_document → broadcast-close → openDocumentFromPath sequence: the
    // broadcast-close runs renderUnloadedDocumentMessage and leaves a
    // "Reopen the document to continue" placeholder div in #viewer; the
    // subsequent SDK.load then fails with the container-not-empty error.
    // Clear defensively so the mount succeeds even when broadcast-close (or
    // any prior overlay) has left children behind. This loses the "no
    // transitional blank" property of the original atomic-swap design, but
    // that property never held in the single-iframe case anyway because the
    // broadcast was already wiping it. Multi-iframe (Cowork with multiple
    // concurrent conversations) is unaffected: each iframe's container only
    // ever sees its own SDK + its own placeholder.
    viewerEl.replaceChildren();
    // Re-enter the loading state so the "nutrient / Loading…" overlay shows
    // during in-place SDK swaps (open → re-open with a different document).
    viewerEl.setAttribute("data-state", "loading");

    // Atomic swap: load the new instance with UI mounted into a local first
    // so any operating tool racing against this load still sees the prior
    // `instance` (if any) and reports a coherent error rather than a transient
    // null window.
    const appName = getAppName();
    let next: SdkInstance;
    try {
      next = await NutrientSDK.load({
        container: viewerEl,
        document: bytes,
        baseUrl: ASSET_BASE_URL,
        // Drop the download (`export-pdf`) and `print` toolbar buttons. The MCP
        // server is the source of truth for document bytes; viewer-side
        // download/print would bypass the auto-save / write_document_bytes path
        // and let the user walk away with a snapshot the host doesn't know
        // about.
        toolbarItems: NutrientSDK.defaultToolbarItems.filter(
          (item) => item.type !== "export-pdf" && item.type !== "print"
        ),
        // Both keys: omit when undefined to satisfy `exactOptionalPropertyTypes`
        // and to avoid the SDK's runtime "must be string when present" check.
        ...(NUTRIENT_LICENSE_KEY ? { licenseKey: NUTRIENT_LICENSE_KEY } : {}),
        ...(appName ? { appName } : {})
      });
    } catch (err) {
      // openDocumentFromPath runs in `ontoolresult`, so the original
      // open_document call has already returned to the model — nothing on
      // the wire is waiting on this throw. Forward the error to the server
      // as either a structured LICENSE_ERROR (when the message names a
      // license problem) or a generic viewer error (everything else) so
      // the host can surface feedback to the user.
      const message = err instanceof Error ? err.message : String(err);
      const subKind = classifyLoadError(message);
      // Clear the loading state on error so the [data-state="loading"] overlay
      // doesn't render on top of whatever error overlay is about to be shown.
      viewerEl.removeAttribute("data-state");
      if (subKind !== null) {
        if (subKind === "expired") {
          renderExpiredLicenseOverlay(getRenewalUrlFromWindow());
        }
        await submitLicenseError(subKind);
      } else {
        await submitViewerError(message, "load");
      }
      throw err;
    }

    const priorInstance = instance;
    const priorController = autoSaveController;
    instance = next;
    currentDocumentPath = documentPath;
    // SDK loaded — clear the loading indicator so CSS `[data-state="loading"]`
    // pseudo-elements no longer render the "nutrient / Loading…" overlay.
    viewerEl.removeAttribute("data-state");
    autoSaveController = setupAutoSaveOnInstance(next, {
      sink: autoSaveSink,
      documentPath
    });

    if (priorInstance) {
      try {
        NutrientSDK.unload(priorInstance); // replaces deprecated instance.destroy()
      } catch {
        /* ignore */
      }
    }
    if (priorController) {
      // The prior controller's listener is detached; any in-flight save
      // continues to completion. Each chunk it streams carries the prior
      // controller's `documentPath`, so the server's stream-binding guard
      // (in `write_document_bytes`) rejects them once the session's open
      // document has rolled over to the new path. The prior document's
      // pending edits are dropped — this is preferable to letting them
      // overwrite the freshly-opened new document. See
      // `docs/document-lifecycle.md` § "In-flight save during in-place SDK
      // swap" for the full trade-off.
      priorController.dispose();
    }
  } finally {
    documentLoadInProgress = false;
  }
}

// URI base mirrors src/mcp/document-resource.ts#DOCUMENT_RESOURCE_URI_BASE.
// Hardcoded here because the viewer can't import from src/mcp/* at runtime
// (separate browser bundle target with no node:* types). The server only
// registers the `{?path}` template — every read MUST include `?path=…` or
// the SDK returns "Resource not found".
const DOCUMENT_RESOURCE_URI_BASE = "nutrient-doc:///current";

async function fetchDocumentBytes(documentPath: string): Promise<ArrayBuffer> {
  // Single-shot read via the MCP resource the server registered. We
  // explicitly pass the path the iframe intends to load (captured from
  // the originating `open_document` tool result) so the server can
  // detect a cross-conversation rehydration: a fresh iframe in an old
  // conversation, the active session belongs to a different
  // conversation. Without `?path=…`, the server would happily return
  // bytes for whatever it currently has — silently the wrong document.
  // Server throws `McpError` with `stale-document-path:` prefix on
  // mismatch; the caller (`openDocumentFromPath`) catches it and
  // renders the "Reopen the document" placeholder.
  const uri = `${DOCUMENT_RESOURCE_URI_BASE}?path=${encodeURIComponent(documentPath)}`;
  const res = await app.readServerResource({ uri });
  const content = (res as { contents?: Array<{ blob?: string; text?: string }> }).contents?.[0];
  if (!content || typeof content.blob !== "string") {
    throw new Error("readServerResource returned no blob content");
  }
  const bytes = base64ToUint8Array(content.blob);
  // Allocate a fresh ArrayBuffer to avoid the SharedArrayBuffer-typed
  // .buffer that a globally-allocated Uint8Array exposes under strict TS.
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

export function base64ToUint8Array(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function getViewState(cmd: { requestId: string }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }
  try {
    await submit(cmd.requestId, getViewStateData(instance, currentDocumentPath));
  } catch (err) {
    await submit(cmd.requestId, {
      error: `getViewState failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function setViewState(cmd: Extract<ViewerCommand, { type: "set_view_state" }>) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }
  try {
    const result = applySetViewState(instance, cmd, currentDocumentPath);
    if (!result.ok) {
      await submit(cmd.requestId, { error: result.error });
    } else {
      await submit(cmd.requestId, result.state);
    }
  } catch (err) {
    await submit(cmd.requestId, {
      error: `setViewState failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function searchExactText(cmd: { requestId: string; query: string; pageIndex?: number }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const result = await searchExact(instance, cmd.query, cmd.requestId, cmd.pageIndex);
    if ("error" in result) {
      await submit(cmd.requestId, { error: result.error });
    } else {
      // Zero SDK hits → empty array per AC2.8. Genuine failures propagate as structured errors.
      await submit(cmd.requestId, { hits: result.hits });
    }
  } catch (err) {
    await submit(cmd.requestId, {
      error: `search failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function readDocumentInformation(cmd: { requestId: string }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const info = await readDocumentInfo(instance);
    await submit(cmd.requestId, info);
  } catch (err) {
    await submit(cmd.requestId, {
      error: `readDocumentInformation failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function readPageInfo(cmd: { requestId: string; pageIndex: number }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const result = readPageInfoPure(instance, cmd.pageIndex);
    if (!result.ok) {
      await submit(cmd.requestId, { error: result.error });
    } else {
      await submit(cmd.requestId, result.info);
    }
  } catch (err) {
    await submit(cmd.requestId, {
      error: `readPageInfo failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function getPageImage(cmd: { requestId: string; pageIndex: number; width?: number }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const pageCount = instance.totalPageCount ?? 0;

    // Bounds check
    if (cmd.pageIndex < 0 || cmd.pageIndex >= pageCount) {
      await submit(cmd.requestId, { error: `Page index ${cmd.pageIndex} out of range` });
      return;
    }

    // Use the shared constant so viewer and server agree on the default.
    // Cross-reference: src/mcp/tools/get-page-image.ts + src/contract/constants.ts
    const width = cmd.width ?? DEFAULT_PAGE_IMAGE_WIDTH_PX;
    // Page-coordinate metadata, fetched first because we need the page's
    // aspect ratio to compute pixel height before rendering.
    const pageInfo = instance.pageInfoForIndex(cmd.pageIndex);
    const pageWidth = pageInfo ? Number(pageInfo.width) : 0;
    const pageHeight = pageInfo ? Number(pageInfo.height) : 0;

    // Use renderPageAsArrayBuffer (not renderPageAsImageURL) because the latter
    // returns a blob: URL that we'd have to fetch back, and the Cowork iframe's
    // CSP `connect-src` only allows the asset origin — blob: fetches fail with
    // "Failed to fetch".
    //
    // The buffer it returns is RAW RGBA pixel data (4 bytes per pixel, NOT
    // PNG bytes — see the SDK docs / `dist/index.d.ts`).
    //
    // PNG encoding runs off the main thread. We transfer the raw RGBA
    // ArrayBuffer zero-copy to the png-encoder.worker via postMessage, which
    // uses OffscreenCanvas + putImageData + convertToBlob to produce PNG bytes
    // and posts the result back. The ~40–200ms blocking encode no longer stalls
    // the main thread's MCP command loop.
    const renderedHeight =
      pageWidth > 0 ? Math.max(1, Math.round((width * pageHeight) / pageWidth)) : width;
    const arrayBuf = await instance.renderPageAsArrayBuffer({ width }, cmd.pageIndex);

    // Transfer the RGBA buffer to the worker. After transfer, arrayBuf is
    // detached on the main thread (zero-copy hand-off).
    const workerResult = await encodePngInWorker(cmd.requestId, arrayBuf, width, renderedHeight);
    if (workerResult.error !== undefined) {
      await submit(cmd.requestId, {
        error: `getPageImage: PNG encode failed: ${workerResult.error}`
      });
      return;
    }

    // Worker returned PNG bytes as an ArrayBuffer; convert to base64 using
    // the chunked helper to stay call-stack safe on large images.
    const pngDataUrl =
      "data:image/png;base64," + uint8ArrayToBase64(new Uint8Array(workerResult.pngBuffer!));

    await submit(cmd.requestId, {
      pngDataUrl,
      pageWidth,
      pageHeight,
      renderedWidth: width
    });
  } catch (err) {
    await submit(cmd.requestId, {
      error: `getPageImage failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function createAnnotation(cmd: { requestId: string; input: unknown }) {
  if (!instance || !NutrientSDK) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  const input = cmd.input as AnnotationInput;

  let annotation: ReturnType<typeof buildAnnotation>;
  try {
    annotation = buildAnnotation(input, NutrientSDK);
  } catch (err) {
    await submit(cmd.requestId, {
      error: `SDK validation: ${err instanceof Error ? err.message : String(err)}`
    });
    return;
  }

  try {
    // Create the annotation: instance.create returns an array of created annotations
    const created = await instance.create(annotation);

    // Get the ID from the first created annotation
    if (!created || created.length === 0) {
      await submit(cmd.requestId, { error: "SDK create returned no annotations" });
      return;
    }

    // `instance.create` returns `Change[]` — a broad union that doesn't carry
    // `id`. We always pass an Annotation in, so the result is always an
    // Annotation; narrow with a cast rather than a runtime type-check.
    const createdAnnotation = created[0] as { id: string; toJSON?: () => unknown };
    const createdId = createdAnnotation.id;
    const annotationJson =
      typeof createdAnnotation.toJSON === "function" ? createdAnnotation.toJSON() : null;
    await submit(cmd.requestId, { id: createdId, annotation: annotationJson });
  } catch (err) {
    await submit(cmd.requestId, {
      error: `Failed to create annotation: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

// sdkClassToType and extractRect live in annotation-operations.ts.
// Re-export sdkClassToType for backward compat with tests that import from main.ts.
export { sdkClassToType } from "./annotation-operations.js";
// extractRect is used only internally here; alias it from the import at the top.
// (imported as `extractRect` above in the annotation-operations import)

async function readAnnotations(cmd: {
  requestId: string;
  pageIndex?: number;
  annotationType?: string;
}) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const pageCount = instance.totalPageCount ?? 0;

    // Bounds check pageIndex if provided
    if (cmd.pageIndex != null) {
      if (cmd.pageIndex < 0 || cmd.pageIndex >= pageCount) {
        await submit(cmd.requestId, {
          error: `pageIndex out of range: ${cmd.pageIndex} (pageCount=${pageCount})`
        });
        return;
      }
    }

    // Fetch annotations: either single page or all pages
    type SdkAnnotation =
      Awaited<ReturnType<SdkInstance["getAnnotations"]>> extends { toArray(): infer A }
        ? A extends Array<infer E>
          ? E
          : never
        : never;
    let allAnnotations: SdkAnnotation[] = [];
    if (cmd.pageIndex != null) {
      const list = await instance.getAnnotations(cmd.pageIndex);
      allAnnotations = list.toArray() as SdkAnnotation[];
    } else {
      for (let p = 0; p < pageCount; p++) {
        const list = await instance.getAnnotations(p);
        allAnnotations = allAnnotations.concat(list.toArray() as SdkAnnotation[]);
      }
    }

    const annotations = allAnnotations.map((a) => {
      const ann = a as SdkAnnotation & {
        id: string;
        pageIndex: number;
        text?: { value?: string };
        contents?: string;
        customData?: unknown;
      };
      return {
        id: ann.id,
        type: sdkClassToType(ann, NutrientSDK),
        pageIndex: ann.pageIndex,
        rect: extractRect(ann),
        contents: ann.text?.value ?? ann.contents ?? undefined,
        customData: ann.customData ?? undefined
      };
    });

    const filtered = cmd.annotationType
      ? annotations.filter((ann) => ann.type === cmd.annotationType)
      : annotations;

    await submit(cmd.requestId, { annotations: filtered });
  } catch (err) {
    await submit(cmd.requestId, {
      error: `readAnnotations failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function updateAnnotation(cmd: {
  requestId: string;
  id: string;
  patch: Record<string, unknown>;
}) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const result = await updateAnnotationImpl(instance, cmd.id, cmd.patch, NutrientSDK);

    if (result.ok) {
      // Return the post-update InstantJSON snapshot so the caller can verify
      // exactly what changed (including any SDK-side defaulting) without a
      // follow-up read_annotations call.
      await submit(cmd.requestId, { id: result.id, annotation: result.annotation });
    } else {
      await submit(cmd.requestId, { error: result.error });
    }
  } catch (err) {
    await submit(cmd.requestId, {
      error: `updateAnnotation failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function deleteAnnotation(cmd: { requestId: string; id: string }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const result = await deleteAnnotationImpl(instance, cmd.id);

    if (result.ok) {
      // Return the pre-delete InstantJSON snapshot so the caller has a record
      // of the annotation it just removed (useful for undo prompts and
      // post-hoc auditing in the model's transcript).
      await submit(cmd.requestId, { id: result.id, annotation: result.annotation });
    } else {
      await submit(cmd.requestId, { error: result.error });
    }
  } catch (err) {
    await submit(cmd.requestId, {
      error: `deleteAnnotation failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

export async function applyRedactionsNow(cmd: { requestId: string }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    // Pure applyRedactions logic lives in redaction-operations.ts.
    // Snapshots pre-apply redactions, flushes pending mutations, calls SDK
    // applyRedactions(), then flushNow() to drive redacted bytes to disk.
    const result = await applyRedactionsImpl(instance, autoSaveController, NutrientSDK);
    await submit(cmd.requestId, result);
  } catch (err) {
    await submit(cmd.requestId, {
      error: `applyRedactions failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function readFormFields(cmd: { requestId: string; pageIndex?: number }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const pageCount = instance.totalPageCount ?? 0;

    // Bounds check pageIndex if provided
    if (cmd.pageIndex != null) {
      if (cmd.pageIndex < 0 || cmd.pageIndex >= pageCount) {
        await submit(cmd.requestId, {
          error: `pageIndex out of range: ${cmd.pageIndex} (pageCount=${pageCount})`
        });
        return;
      }
    }

    const fields = await readFormFieldsImpl(instance, cmd.pageIndex, NutrientSDK);

    await submit(cmd.requestId, { fields });
  } catch (err) {
    await submit(cmd.requestId, {
      error: `readFormFields failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function updateFormFieldValues(cmd: {
  requestId: string;
  formFieldValues: Array<{ name: string; value: string | string[] | null }>;
}) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    const result = await updateFormFieldValuesImpl(instance, cmd.formFieldValues, NutrientSDK);

    await submit(cmd.requestId, result);
  } catch (err) {
    await submit(cmd.requestId, {
      error: `updateFormFieldValues failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function readText(cmd: { requestId: string; pageStart: number; pageEnd: number }) {
  if (!instance) {
    await submit(cmd.requestId, { error: noOpenInstanceError() });
    return;
  }

  try {
    // Pure read-text logic lives in document-commands.ts (readTextPages).
    // Handles sentinel -1 for pageEnd, bounds checks, 100 K char cap, and truncation.
    const result = await readTextPages(instance, cmd.pageStart, cmd.pageEnd);
    if ("error" in result) {
      await submit(cmd.requestId, { error: result.error });
    } else {
      await submit(cmd.requestId, result);
    }
  } catch (err) {
    await submit(cmd.requestId, {
      error: `readText failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

export async function closeDocument({ requestId }: { requestId: string }): Promise<void> {
  // Capture the path BEFORE we null `currentDocumentPath` — the post-close
  // "Reopen the document to continue" message names the file, so we need
  // to remember it across the teardown.
  const closedPath = currentDocumentPath;

  if (autoSaveController) {
    // Synchronous flush: any pending debounce is cancelled, in-flight save
    // is awaited, and one final save runs if the SDK still reports unsaved
    // changes. This is the close-time guarantee that no work is silently
    // dropped at teardown — see docs/spec.md D8.
    try {
      await autoSaveController.flushIfDirty();
    } catch {
      /* errors are routed through the controller's onError; swallow here
         so a transient save failure doesn't block close. */
    }
    autoSaveController.dispose();
    autoSaveController = null;
  }
  if (instance && NutrientSDK) {
    try {
      NutrientSDK.unload(instance);
    } catch {
      /* ignore */
    }
    instance = null;
  }
  currentDocumentPath = null;

  // Render the post-close placeholder. Two modes:
  //   - If we knew the path (the common case — we just closed a real
  //     document), show the "Reopen the document to continue" message
  //     naming the file so the user knows what to ask for. This is the
  //     UX behaviour the multi-conversation close-broadcast relies on:
  //     when a new conversation's `open_document` runs, every prior
  //     conversation's iframe gets a `close_document` and renders this
  //     message — the user sees it on switching back to the prior
  //     conversation.
  //   - If `closedPath` is null (close called pre-open as an
  //     idempotent no-op, or called twice), fall back to showing no
  //     content (empty `#viewer`, no data-state attribute set).
  const viewerEl = document.getElementById("viewer");
  if (viewerEl) {
    if (closedPath) {
      renderUnloadedDocumentMessage(closedPath);
    } else {
      viewerEl.replaceChildren();
      viewerEl.removeAttribute("data-state");
    }
  }

  await submit(requestId, { closed: true });
}

async function submit(requestId: string, data: unknown, error?: string) {
  await app.callServerTool({
    name: "submit_response",
    arguments: { requestId, data: data ?? null, ...(error ? { error } : {}) }
  });
}

// submitLicenseError and submitViewerError are thin wrappers that call
// the pure functions in error-fallbacks.ts with the module-level `app` singleton.
async function submitLicenseError(subKind: LicenseErrorSubKind): Promise<void> {
  await submitLicenseErrorImpl(subKind, app);
}

async function submitViewerError(
  message: string,
  source: ViewerErrorPayload["source"]
): Promise<void> {
  await submitViewerErrorImpl(message, source, app);
}

// Test-only: clears module state between tests. Not exported for production use.
export function __resetForTesting(): void {
  if (autoSaveController) {
    autoSaveController.dispose();
    autoSaveController = null;
  }
  instance = null;
  currentDocumentPath = null;
  documentLoadInProgress = false;
  // Delegate host-context state reset to the peer module.
  __resetHostContextForTesting();
}
