import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for closeDocument production handler.
 * These tests verify the handler correctly:
 * - Unloads the current instance
 * - Clears viewer state (instance, path)
 * - Resets DOM to waiting state
 * - Submits success response
 */

// Use vi.hoisted to define mock functions available to vi.mock callbacks
const { mockLoad, mockUnload, mockCallServerTool, mockReadServerResource, mockDomState, mockSubmit } = vi.hoisted(() => {
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

// Lightweight DOM-element factory for the post-close
// `renderUnloadedDocumentMessage` path. Real DOM isn't worth bringing in;
// these stubs just need to swallow the appendChild / textContent / className
// writes without crashing so closeDocument's render branch is exercisable.
function makeStubElement(): {
  appendChild: (...args: unknown[]) => unknown;
  appendChildCalls: unknown[];
  className: string;
  textContent: string;
  style: { display: string };
} {
  const calls: unknown[] = [];
  return {
    appendChildCalls: calls,
    appendChild: (child: unknown) => {
      calls.push(child);
      return child;
    },
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
    set innerHTML(_html: string) {
      // Stub for potential DOM updates
    }
  }
});

// Mock the dynamic import of @nutrient-sdk/viewer
vi.mock("@nutrient-sdk/viewer", () => ({
  default: {
    load: mockLoad,
    unload: mockUnload,
    defaultToolbarItems: [],
  },
}));

// Mock the ext-apps App and its callServerTool method.
vi.mock("@modelcontextprotocol/ext-apps", async () => {
  const actual = await vi.importActual<typeof import("@modelcontextprotocol/ext-apps")>(
    "@modelcontextprotocol/ext-apps"
  );
  return {
    ...actual,
    App: class MockApp {
      callServerTool = mockCallServerTool;
      readServerResource = mockReadServerResource;
      async connect() {
        // no-op for testing
      }
      getHostContext() {
        // Tests don't simulate off-screen hosts; returning undefined hits the
        // "not advertised → proceed" branch of hasNonZeroContainerDimensions.
        return undefined;
      }
    },
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {},
  };
});

// Import AFTER mocks are set up
import { openDocumentFromPath, closeDocument } from "../../src/viewer/main";

// SDK-instance shape additions consumed by setupAutoSaveOnInstance. The
// production SDK exposes these on every instance; mocks in this suite are
// bare objects, so we splat this base into each mockResolvedValue payload.
const MOCK_INSTANCE_BASE = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hasUnsavedChanges: () => false,
  exportPDF: async () => new ArrayBuffer(0),
};

beforeEach(() => {
  mockDomState.elements.clear();
  const replaceChildren = vi.fn();
  // Viewer element needs appendChild now too: closeDocument calls
  // renderUnloadedDocumentMessage which appendChild's the
  // "Reopen the document to continue" container.
  const appendedChildren: unknown[] = [];
  const cdAttrs = new Map<string, string>();
  const viewerEl = {
    style: { display: "block" },
    textContent: "",
    replaceChildren,
    appendChild: (child: unknown) => {
      appendedChildren.push(child);
      return child;
    },
    appendedChildren,
    setAttribute: vi.fn((key: string, value: string) => { cdAttrs.set(key, value); }),
    removeAttribute: vi.fn((key: string) => { cdAttrs.delete(key); }),
    getAttribute: vi.fn((key: string) => cdAttrs.get(key) ?? null),
  };
  mockDomState.elements.set("viewer", viewerEl);

  // Reset mocks
  mockLoad.mockReset();
  mockUnload.mockReset();
  mockCallServerTool.mockReset();
  mockReadServerResource.mockReset();
  mockSubmit.mockReset();

  // Default SDK load behavior
  mockLoad.mockResolvedValue({ ...MOCK_INSTANCE_BASE, id: "mock-instance" });

  // Default document fetch: single-shot via app.readServerResource.
  mockReadServerResource.mockResolvedValue({
    contents: [
      {
        uri: "nutrient-doc:///current",
        mimeType: "application/octet-stream",
        blob: "SGVsbG8="
      }
    ]
  });

  // submit_response (and any other tool calls) still go through callServerTool.
  mockCallServerTool.mockImplementation(async (req: any) => {
    if (req.name === "submit_response") {
      mockSubmit(req.arguments);
      return { structuredContent: {} };
    }
    return { structuredContent: {} };
  });
});

describe("closeDocument", () => {
  it("unloads instance, clears state, renders the reopen message, submits success", async () => {
    // Set up: open document
    const testInstance = { ...MOCK_INSTANCE_BASE, id: "test-instance" };
    mockLoad.mockResolvedValueOnce(testInstance);
    await openDocumentFromPath("/path/to/doc.pdf");

    // Verify instance was set up with UI mounted (no headless flag)
    expect(mockLoad).toHaveBeenCalledWith(expect.objectContaining({ container: expect.any(Object) }));

    mockUnload.mockClear();
    mockCallServerTool.mockClear();
    mockSubmit.mockClear();
    const viewerEl = mockDomState.elements.get("viewer")! as ReturnType<
      typeof Object.assign
    > & {
      replaceChildren: ReturnType<typeof vi.fn>;
      appendedChildren: unknown[];
    };
    viewerEl.replaceChildren.mockClear();
    viewerEl.appendedChildren.length = 0;

    // Call closeDocument
    await closeDocument({ requestId: "close-req-1" });

    // unload called on prior instance
    expect(mockUnload).toHaveBeenCalledWith(testInstance);
    expect(mockUnload).toHaveBeenCalledTimes(1);

    // renderUnloadedDocumentMessage clears #viewer first…
    expect(viewerEl.replaceChildren).toHaveBeenCalledTimes(1);
    // …then appends a single fallback container (the "Reopen the document
    // to continue" message). The container itself holds heading + body
    // text inside, but from #viewer's perspective only one child is
    // appended.
    expect(viewerEl.appendedChildren).toHaveLength(1);

    // submit called with { closed: true }
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "close-req-1",
        data: { closed: true }
      })
    );
  });

  it("falls back to bare CSS placeholder when close is called pre-open (no path captured)", async () => {
    // Don't call openDocumentFromPath, so currentDocumentPath stays null.
    const viewerEl = mockDomState.elements.get("viewer")! as ReturnType<
      typeof Object.assign
    > & {
      replaceChildren: ReturnType<typeof vi.fn>;
      appendedChildren: unknown[];
    };
    viewerEl.replaceChildren.mockClear();
    viewerEl.appendedChildren.length = 0;
    mockSubmit.mockClear();

    await closeDocument({ requestId: "noop-close-req" });

    // Empties #viewer (the CSS `:empty::before` placeholder reappears).
    expect(viewerEl.replaceChildren).toHaveBeenCalledTimes(1);
    // No fallback container appended — the bare placeholder is the right
    // UX when the iframe never had a document loaded.
    expect(viewerEl.appendedChildren).toHaveLength(0);

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "noop-close-req",
        data: { closed: true },
      })
    );
  });
});
