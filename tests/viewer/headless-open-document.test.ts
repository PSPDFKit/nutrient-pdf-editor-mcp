import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for openDocumentFromPath: happy path, error propagation,
 * fallback rendering, byte decoding, and in-place-switch (consecutive opens).
 */

const {
  mockLoad,
  mockUnload,
  mockCallServerTool,
  mockReadServerResource,
  mockDomState,
  mockAppRef,
  mockHostContextRef,
  mockRequestDisplayMode,
  mockSendSizeChanged
} = vi.hoisted(() => {
  const mockDomState = {
    elements: new Map<string, any>()
  };
  const mockAppRef: { current: any } = { current: null };
  const mockHostContextRef: { current: any } = { current: undefined };
  return {
    mockLoad: vi.fn(),
    mockUnload: vi.fn(),
    mockCallServerTool: vi.fn(),
    mockReadServerResource: vi.fn(),
    mockDomState,
    mockAppRef,
    mockHostContextRef,
    mockRequestDisplayMode: vi.fn(async () => undefined),
    mockSendSizeChanged: vi.fn(async () => undefined)
  };
});

vi.stubGlobal("window", {
  __NUTRIENT_ASSET_BASE__: undefined,
  innerWidth: 1280,
  innerHeight: 800
});

function createMockElement(tagName: string) {
  const el: {
    tagName: string;
    className: string;
    textContent: string;
    children: unknown[];
    appendChild: (c: unknown) => unknown;
  } = {
    tagName: tagName.toUpperCase(),
    className: "",
    textContent: "",
    children: [],
    appendChild(child: unknown) {
      el.children.push(child);
      return child;
    }
  };
  return el;
}

vi.stubGlobal("document", {
  getElementById: (id: string) => mockDomState.elements.get(id) || null,
  createElement: vi.fn((tagName: string) => createMockElement(tagName)),
  createTextNode: vi.fn((text: string) => ({ nodeType: 3, textContent: text })),
  body: {
    get innerHTML() {
      return "";
    },
    set innerHTML(_html: string) {
      mockDomState.elements.clear();
      if (_html.includes("viewer") && !mockDomState.elements.has("viewer")) {
        const htmlViewerAttrs = new Map<string, string>();
        mockDomState.elements.set("viewer", {
          style: { display: "block" },
          replaceChildren: vi.fn(),
          appendChild: vi.fn(),
          setAttribute: vi.fn((key: string, value: string) => {
            htmlViewerAttrs.set(key, value);
          }),
          removeAttribute: vi.fn((key: string) => {
            htmlViewerAttrs.delete(key);
          }),
          getAttribute: vi.fn((key: string) => htmlViewerAttrs.get(key) ?? null)
        });
      }
    }
  }
});

vi.mock("@nutrient-sdk/viewer", () => ({
  default: {
    load: mockLoad,
    unload: mockUnload,
    defaultToolbarItems: []
  }
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
      onhostcontextchanged: ((ctx: any) => void) | null = null;
      requestDisplayMode = mockRequestDisplayMode;
      sendSizeChanged = mockSendSizeChanged;
      constructor() {
        mockAppRef.current = this;
      }
      async connect() {}
      getHostContext() {
        return mockHostContextRef.current;
      }
      getHostVersion() {
        return { name: "test-host", version: "0.0.0" };
      }
    },
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {}
  };
});

import { openDocumentFromPath, __resetForTesting } from "../../src/viewer/main";

const MOCK_INSTANCE_BASE = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hasUnsavedChanges: () => false,
  exportPDF: async () => new ArrayBuffer(0)
};

beforeEach(() => {
  __resetForTesting();

  mockDomState.elements.clear();
  const viewerAttrs = new Map<string, string>();
  mockDomState.elements.set("viewer", {
    style: { display: "block" },
    replaceChildren: vi.fn(),
    appendChild: vi.fn(),
    setAttribute: vi.fn((key: string, value: string) => {
      viewerAttrs.set(key, value);
    }),
    removeAttribute: vi.fn((key: string) => {
      viewerAttrs.delete(key);
    }),
    getAttribute: vi.fn((key: string) => viewerAttrs.get(key) ?? null)
  });

  mockHostContextRef.current = undefined;

  mockLoad.mockReset();
  mockUnload.mockReset();
  mockCallServerTool.mockReset();
  mockReadServerResource.mockReset();
  mockRequestDisplayMode.mockReset();
  mockRequestDisplayMode.mockResolvedValue(undefined);
  mockSendSizeChanged.mockReset();
  mockSendSizeChanged.mockResolvedValue(undefined);

  mockLoad.mockResolvedValue({ ...MOCK_INSTANCE_BASE, id: "mock-instance" });

  mockReadServerResource.mockResolvedValue({
    contents: [
      {
        uri: "nutrient-doc:///current",
        mimeType: "application/octet-stream",
        blob: "SGVsbG8="
      }
    ]
  });

  mockCallServerTool.mockResolvedValue({ structuredContent: {} });
});

describe("openDocumentFromPath", () => {
  it("calls SDK.load with the viewer container (UI mounted, no headless mode)", async () => {
    await openDocumentFromPath("/path/to/doc.pdf");

    expect(mockLoad).toHaveBeenCalledTimes(1);
    const callArgs = mockLoad.mock.calls[0]?.[0];
    expect(callArgs).toHaveProperty("container");
    expect(callArgs).not.toHaveProperty("headless");
    expect(callArgs).toHaveProperty("document");
    expect(callArgs.document).toBeInstanceOf(ArrayBuffer);
    expect(callArgs).toHaveProperty("baseUrl");
  });

  it("throws error when viewer element is missing", async () => {
    document.body.innerHTML = "";

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow(/#viewer/);
  });

  it("Important 1: calls NutrientSDK.unload on prior instance before loading new document", async () => {
    const firstInstance = { ...MOCK_INSTANCE_BASE, id: "first" };
    const secondInstance = { ...MOCK_INSTANCE_BASE, id: "second" };

    mockLoad.mockResolvedValueOnce(firstInstance);
    mockLoad.mockResolvedValueOnce(secondInstance);

    await openDocumentFromPath("/first.pdf");
    expect(mockUnload).not.toHaveBeenCalled();

    await openDocumentFromPath("/second.pdf");

    expect(mockUnload).toHaveBeenCalledWith(firstInstance);
    expect(mockUnload).toHaveBeenCalledTimes(1);
  });

  it("fetches document bytes via app.readServerResource with the path-tagged URI", async () => {
    await openDocumentFromPath("/test/document.pdf");

    expect(mockReadServerResource).toHaveBeenCalledTimes(1);
    expect(mockReadServerResource).toHaveBeenCalledWith({
      uri: `nutrient-doc:///current?path=${encodeURIComponent("/test/document.pdf")}`
    });
  });

  it("propagates readServerResource errors instead of feeding 0 bytes to the SDK", async () => {
    mockReadServerResource.mockRejectedValueOnce(
      new Error("MCP error -32602: No document is open.")
    );

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow(/No document is open/);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("renders an explanatory fallback in #viewer when readServerResource rejects with 'No document is open'", async () => {
    mockReadServerResource.mockRejectedValueOnce(
      new Error(
        "MCP error -32602: No document is open. Call open_document first."
      )
    );

    await expect(openDocumentFromPath("/Users/nick/credit-card-application.pdf")).rejects.toThrow(
      /No document is open/
    );

    const viewerEl = mockDomState.elements.get("viewer") as unknown as {
      replaceChildren: ReturnType<typeof vi.fn>;
      appendChild: ReturnType<typeof vi.fn>;
    };
    expect(viewerEl.replaceChildren).toHaveBeenCalledTimes(1);
    expect(viewerEl.appendChild).toHaveBeenCalledTimes(1);

    const container = viewerEl.appendChild.mock.calls[0]![0] as {
      className: string;
      children: Array<{ tagName: string; textContent: string }>;
    };
    expect(container.className).toBe("nutrient-viewer-fallback");
    expect(container.children).toHaveLength(2);
    expect(container.children[0]!.tagName).toBe("H2");
    expect(container.children[0]!.textContent).toMatch(/reopen.*document/i);
    expect(container.children[1]!.tagName).toBe("P");
    const paragraphChildren = (
      container.children[1] as unknown as {
        children: Array<{ tagName?: string; textContent?: string }>;
      }
    ).children;
    const filenameNode = paragraphChildren.find((c) => c.tagName === "CODE");
    expect(filenameNode?.textContent).toBe("credit-card-application.pdf");
  });

  it("renders the fallback when the server returns the stale-document-path sentinel (cross-conversation rehydration)", async () => {
    mockReadServerResource.mockRejectedValueOnce(
      new Error(
        "MCP error -32600: stale-document-path: requested /old.pdf but session has /new.pdf"
      )
    );

    await expect(openDocumentFromPath("/old.pdf")).rejects.toThrow(/stale-document-path/);
    expect(mockLoad).not.toHaveBeenCalled();

    const viewerEl = mockDomState.elements.get("viewer") as unknown as {
      replaceChildren: ReturnType<typeof vi.fn>;
      appendChild: ReturnType<typeof vi.fn>;
    };
    expect(viewerEl.replaceChildren).toHaveBeenCalledTimes(1);
    expect(viewerEl.appendChild).toHaveBeenCalledTimes(1);

    const container = viewerEl.appendChild.mock.calls[0]![0] as {
      className: string;
      children: Array<{ tagName: string; textContent: string }>;
    };
    expect(container.className).toBe("nutrient-viewer-fallback");
    const paragraphChildren = (
      container.children[1] as unknown as {
        children: Array<{ tagName?: string; textContent?: string }>;
      }
    ).children;
    const filenameNode = paragraphChildren.find((c) => c.tagName === "CODE");
    expect(filenameNode?.textContent).toBe("old.pdf");
  });

  it("also renders the fallback when the server reports no MCP roots advertised", async () => {
    mockReadServerResource.mockRejectedValueOnce(
      new Error("MCP error -32602: MCP client has not advertised any filesystem roots.")
    );

    await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
      /has not advertised any filesystem roots/
    );

    const viewerEl = mockDomState.elements.get("viewer") as unknown as {
      appendChild: ReturnType<typeof vi.fn>;
    };
    expect(viewerEl.appendChild).toHaveBeenCalledTimes(1);
  });

  it("does NOT render the fallback for unrelated SDK / load errors", async () => {
    mockLoad.mockRejectedValueOnce(new Error("SDK is having a bad day"));

    await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(/SDK is having a bad day/);

    const viewerEl = mockDomState.elements.get("viewer") as unknown as {
      appendChild: ReturnType<typeof vi.fn>;
    };
    expect(viewerEl.appendChild).not.toHaveBeenCalled();
  });

  it("decodes base64 blob from readServerResource into the ArrayBuffer SDK.load receives", async () => {
    mockReadServerResource.mockResolvedValueOnce({
      contents: [
        {
          uri: "nutrient-doc:///current",
          mimeType: "application/octet-stream",
          blob: btoa("firstchunksecondchunk")
        }
      ]
    });

    await openDocumentFromPath("/test/document.pdf");

    expect(mockReadServerResource).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    const loadArgs = mockLoad.mock.calls[0]?.[0];
    expect(loadArgs.document).toBeInstanceOf(ArrayBuffer);
    expect(loadArgs.document.byteLength).toBe(21);
  });

  it("refetches document bytes on each open (no cross-call caching)", async () => {
    await openDocumentFromPath("/doc.pdf");
    expect(mockReadServerResource).toHaveBeenCalledTimes(1);

    await openDocumentFromPath("/doc.pdf");
    expect(mockReadServerResource).toHaveBeenCalledTimes(2);
  });

  it("recovers from unload errors when prior instance cleanup fails", async () => {
    const firstInstance = { ...MOCK_INSTANCE_BASE, id: "first" };
    mockLoad.mockResolvedValueOnce(firstInstance);
    mockLoad.mockResolvedValueOnce({ ...MOCK_INSTANCE_BASE, id: "second" });

    await openDocumentFromPath("/first.pdf");

    mockUnload.mockRejectedValueOnce(new Error("Unload failed"));

    await expect(openDocumentFromPath("/second.pdf")).resolves.not.toThrow();

    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("defers SDK.load when host advertises zero containerDimensions, then mounts after host-context-changed delivers non-zero dims", async () => {
    mockHostContextRef.current = {
      containerDimensions: { width: 0, height: 0 }
    };

    const pending = openDocumentFromPath("/path/to/doc.pdf");

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLoad).not.toHaveBeenCalled();

    mockHostContextRef.current = {
      containerDimensions: { width: 1280, height: 800 }
    };
    mockAppRef.current!.onhostcontextchanged?.({
      containerDimensions: { width: 1280, height: 800 }
    });

    await pending;

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("mounts immediately when host advertises non-zero containerDimensions", async () => {
    mockHostContextRef.current = {
      containerDimensions: { width: 1280, height: 800 }
    };

    await openDocumentFromPath("/path/to/doc.pdf");

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("mounts immediately when host does not advertise containerDimensions at all", async () => {
    mockHostContextRef.current = { theme: "light" };

    await openDocumentFromPath("/path/to/doc.pdf");

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("stores the returned instance from SDK.load", async () => {
    const mockInstance = {
      ...MOCK_INSTANCE_BASE,
      id: "test-instance",
      totalPageCount: 42
    };
    mockLoad.mockResolvedValueOnce(mockInstance);

    await openDocumentFromPath("/path/to/doc.pdf");

    mockLoad.mockResolvedValueOnce({ ...MOCK_INSTANCE_BASE, id: "second" });
    await openDocumentFromPath("/another.pdf");

    expect(mockUnload).toHaveBeenCalledWith(mockInstance);
  });
});
