import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the viewer-side `applyRedactionsNow` handler.
 *
 * Specifically guards the post-apply flush: after `applyRedactions()` mutates
 * the document, the handler must drive the auto-save controller's
 * `flushNow()` so the burned-in bytes reach disk synchronously before the
 * server tool returns. Without that forced flush the on-disk file is left
 * with redaction annotations but unredacted underlying text — the SDK
 * reloads the document internally during applyRedactions and clears the
 * dirty flag, so a `flushIfDirty()` would no-op here.
 */

const {
  mockLoad,
  mockUnload,
  mockCallServerTool,
  mockReadServerResource,
  mockDomState,
  mockSubmit,
} = vi.hoisted(() => {
  const mockDomState = {
    elements: new Map<
      string,
      { style: { display: string }; textContent?: string; replaceChildren: () => void }
    >(),
  };
  return {
    mockLoad: vi.fn(),
    mockUnload: vi.fn(),
    mockCallServerTool: vi.fn(),
    mockReadServerResource: vi.fn(),
    mockDomState,
    mockSubmit: vi.fn(),
  };
});

vi.stubGlobal("window", {
  __NUTRIENT_ASSET_BASE__: "https://cdn.cloud.nutrient.io/pspdfkit-web@9.9.9/",
  __E2E_TEST: true,
});

function makeStubElement(): {
  appendChild: (...args: unknown[]) => unknown;
  className: string;
  textContent: string;
  style: { display: string };
} {
  return {
    appendChild: (child: unknown) => child,
    className: "",
    textContent: "",
    style: { display: "block" },
  };
}

vi.stubGlobal("document", {
  getElementById: (id: string) => mockDomState.elements.get(id) || null,
  createElement: (_tag: string) => makeStubElement(),
  createTextNode: (text: string) => ({ textContent: text }),
  body: {
    get innerHTML() { return ""; },
    set innerHTML(_html: string) { /* stub */ },
  },
});

// RedactionAnnotation needs to be a real class (the production code uses
// `instanceof RedactionAnnotation`). We mount a minimal class that the
// snapshot loop's `instanceof` check matches; toJSON returns a stable shape.
class FakeRedactionAnnotation {
  toJSON() {
    return { id: "ann-1", pageIndex: 0, rect: { left: 0, top: 0, width: 10, height: 10 } };
  }
}

vi.mock("@nutrient-sdk/viewer", () => ({
  default: {
    load: mockLoad,
    unload: mockUnload,
    defaultToolbarItems: [],
    Annotations: {
      RedactionAnnotation: FakeRedactionAnnotation,
    },
  },
}));

vi.mock("@modelcontextprotocol/ext-apps", async () => {
  const actual = await vi.importActual<typeof import("@modelcontextprotocol/ext-apps")>(
    "@modelcontextprotocol/ext-apps"
  );
  return {
    ...actual,
    App: class MockApp {
      callServerTool = mockCallServerTool;
      readServerResource = mockReadServerResource;
      async connect() { /* no-op */ }
      getHostContext() { return undefined; }
    },
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {},
  };
});

import { openDocumentFromPath, applyRedactionsNow } from "../../src/viewer/main";

interface FakeInstance {
  addEventListener: (evt: string, h: (e: { hasUnsavedChanges: boolean }) => void) => void;
  removeEventListener: (evt: string, h: (e: { hasUnsavedChanges: boolean }) => void) => void;
  hasUnsavedChanges: () => boolean;
  exportPDF: () => Promise<ArrayBuffer>;
  applyRedactions: () => Promise<void>;
  getAnnotations: (pageIndex: number) => Promise<{ toArray: () => unknown[] }>;
  totalPageCount: number;
  exportPDFCalls: () => number;
  applyRedactionsCalls: () => number;
}

function makeInstance({
  unsavedAfterApply,
  unsavedBeforeApply = false,
}: {
  unsavedAfterApply: boolean;
  unsavedBeforeApply?: boolean;
}): FakeInstance {
  let unsaved = unsavedBeforeApply;
  let exportCount = 0;
  let applyCount = 0;
  const ann = new FakeRedactionAnnotation();
  const exportedBytes = new TextEncoder().encode("REDACTED-PDF-BYTES").buffer;

  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    hasUnsavedChanges: () => unsaved,
    async exportPDF() {
      exportCount++;
      return exportedBytes.slice(0);
    },
    async applyRedactions() {
      applyCount++;
      // In production the SDK reloads the document internally and clears
      // the dirty flag. `unsavedAfterApply` here lets each test choose which
      // post-apply state to simulate; the post-apply flush must run in
      // either case.
      unsaved = unsavedAfterApply;
    },
    async getAnnotations(_p: number) {
      return { toArray: () => [ann] };
    },
    totalPageCount: 1,
    exportPDFCalls: () => exportCount,
    applyRedactionsCalls: () => applyCount,
  };
}

beforeEach(() => {
  mockDomState.elements.clear();
  const arAttrs = new Map<string, string>();
  const viewerEl = {
    style: { display: "block" },
    textContent: "",
    replaceChildren: vi.fn(),
    appendChild: (child: unknown) => child,
    setAttribute: vi.fn((key: string, value: string) => { arAttrs.set(key, value); }),
    removeAttribute: vi.fn((key: string) => { arAttrs.delete(key); }),
    getAttribute: vi.fn((key: string) => arAttrs.get(key) ?? null),
  };
  mockDomState.elements.set("viewer", viewerEl as unknown as never);

  mockLoad.mockReset();
  mockUnload.mockReset();
  mockCallServerTool.mockReset();
  mockReadServerResource.mockReset();
  mockSubmit.mockReset();

  mockReadServerResource.mockResolvedValue({
    contents: [
      {
        uri: "nutrient-doc:///current",
        mimeType: "application/octet-stream",
        blob: "SGVsbG8=",
      },
    ],
  });

  mockCallServerTool.mockImplementation(async (req: { name: string; arguments: Record<string, unknown> }) => {
    if (req.name === "submit_response") {
      mockSubmit(req.arguments);
      return { structuredContent: {} };
    }
    return { structuredContent: { finalized: true } };
  });
});

describe("applyRedactionsNow", () => {
  it("flushes auto-save after applying so the redacted bytes reach disk", async () => {
    const inst = makeInstance({ unsavedAfterApply: true });
    mockLoad.mockResolvedValueOnce(inst);
    await openDocumentFromPath("/path/to/doc.pdf");

    expect(inst.exportPDFCalls()).toBe(0);

    await applyRedactionsNow({ requestId: "apply-req-1" });

    expect(inst.applyRedactionsCalls()).toBe(1);
    // The post-apply flushIfDirty must have driven exportPDF synchronously,
    // BEFORE applyRedactionsNow resolved — otherwise the saveStateChange the
    // SDK emits during applyRedactions would be at the mercy of the
    // auto-save loop's drop-while-in-flight semantic.
    expect(inst.exportPDFCalls()).toBe(1);

    // And the resulting bytes were chunked back to write_document_bytes.
    const writeCalls = mockCallServerTool.mock.calls.filter(
      (c) => (c[0] as { name: string }).name === "write_document_bytes"
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("flushes after apply even when the SDK reports clean (internal reload clears dirty)", async () => {
    // applyRedactions reloads the document internally and clears the dirty
    // bit as part of that reload, even though the new (redacted) bytes still
    // need to reach disk. The handler must force a flush regardless of
    // hasUnsavedChanges() — this is the regression that left earlier
    // builds with redaction annotations on disk but unredacted text under
    // them. Empty-redaction-set short-circuits in the server tool, so by
    // the time we reach the viewer handler there is always real work to
    // persist.
    const inst = makeInstance({ unsavedAfterApply: false });
    mockLoad.mockResolvedValueOnce(inst);
    await openDocumentFromPath("/path/to/doc.pdf");

    await applyRedactionsNow({ requestId: "apply-req-2" });

    expect(inst.applyRedactionsCalls()).toBe(1);
    expect(inst.exportPDFCalls()).toBe(1);

    const writeCalls = mockCallServerTool.mock.calls.filter(
      (c) => (c[0] as { name: string }).name === "write_document_bytes"
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("drains pending mutations before applying so apply doesn't race the create queue", async () => {
    // Drive `flushIfDirty()` once before apply so the underlying core has
    // every queued annotation before we commit redactions. When the SDK
    // reports unsaved changes pre-apply, that
    // flush exports; the post-apply forced flush exports again. Two
    // exportPDF calls in total — one for the pre-apply drain, one for
    // the post-apply persistence of redacted bytes.
    const inst = makeInstance({ unsavedBeforeApply: true, unsavedAfterApply: true });
    mockLoad.mockResolvedValueOnce(inst);
    await openDocumentFromPath("/path/to/doc.pdf");

    await applyRedactionsNow({ requestId: "apply-req-3" });

    expect(inst.applyRedactionsCalls()).toBe(1);
    expect(inst.exportPDFCalls()).toBe(2);
  });
});
