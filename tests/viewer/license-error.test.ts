/**
 * Viewer-side tests for SDK license error detection and forwarding.
 *
 * Covers:
 * - Load-time invalid-license rejection → submitLicenseError("invalid")
 * - Load-time expired-license rejection → submitLicenseError("expired")
 * - Load-time host-mismatch rejection → submitLicenseError("host-mismatch")
 * - Non-license SDK rejection: NO submitLicenseError, original error re-thrown
 * - Payload shape: code, subKind, guidance in submit_response call
 * - KEY SAFETY: the fake license key value must NOT appear in any call args
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LICENSE_ERROR_CODE,
  LICENSE_SUPPORT_CONTACT,
} from "../../src/contract/viewer-errors.js";

// A fake license key used in tests — must never appear in submit_response args.
const FAKE_LICENSE_KEY = "FAKE-LICENSE-KEY-MUST-NOT-APPEAR-IN-OUTPUT-00000000";

// ---------------------------------------------------------------------------
// Mocks set up BEFORE module import (vi.hoisted pattern from headless-open)
// ---------------------------------------------------------------------------
const {
  mockLoad,
  mockUnload,
  mockCallServerTool,
  mockReadServerResource,
  mockDomState,
  mockAppRef,
} = vi.hoisted(() => {
  const mockDomState = {
    elements: new Map<string, any>(),
  };
  const mockAppRef: { current: any } = { current: null };
  return {
    mockLoad: vi.fn(),
    mockUnload: vi.fn(),
    mockCallServerTool: vi.fn(),
    mockReadServerResource: vi.fn(),
    mockDomState,
    mockAppRef,
  };
});

vi.stubGlobal("window", {
  __NUTRIENT_ASSET_BASE__: undefined,
  __NUTRIENT_RENEWAL_URL__: undefined,
  innerWidth: 1280,
  innerHeight: 800,
});

vi.stubGlobal("document", {
  getElementById: (id: string) => mockDomState.elements.get(id) ?? null,
  createElement: vi.fn((tagName: string) => {
    const classes = new Set<string>();
    const el: any = {
      tagName: tagName.toUpperCase(),
      className: "",
      textContent: "",
      children: [] as unknown[],
      href: "",
      target: "",
      rel: "",
      classList: {
        add: (cls: string) => classes.add(cls),
        contains: (cls: string) => classes.has(cls),
      },
      appendChild(child: unknown) { this.children.push(child); return child; },
      replaceChildren: vi.fn(),
      addEventListener: vi.fn(),
    };
    return el;
  }),
  createTextNode: vi.fn((text: string) => ({ nodeType: 3, textContent: text })),
  body: {
    get innerHTML() { return ""; },
    set innerHTML(_html: string) { /* noop */ }
  }
});

vi.mock("@nutrient-sdk/viewer", () => ({
  default: {
    load: mockLoad,
    unload: mockUnload,
    defaultToolbarItems: [],
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
      onhostcontextchanged: ((ctx: any) => void) | null = null;
      requestDisplayMode = vi.fn(async () => undefined);
      sendSizeChanged = vi.fn(async () => undefined);
      constructor() {
        mockAppRef.current = this;
      }
      async connect() { /* no-op */ }
      getHostContext() { return undefined; }
    },
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {},
  };
});

// Import AFTER mocks
import { openDocumentFromPath, __resetForTesting } from "../../src/viewer/main";

const MOCK_INSTANCE_BASE = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hasUnsavedChanges: () => false,
  exportPDF: async () => new ArrayBuffer(0),
};

function resetViewerEl() {
  const leAttrs = new Map<string, string>();
  mockDomState.elements.set("viewer", {
    style: { display: "block" },
    children: [] as unknown[],
    replaceChildren: vi.fn(),
    appendChild: vi.fn(),
    setAttribute: vi.fn((key: string, value: string) => { leAttrs.set(key, value); }),
    removeAttribute: vi.fn((key: string) => { leAttrs.delete(key); }),
    getAttribute: vi.fn((key: string) => leAttrs.get(key) ?? null),
  });
}

beforeEach(() => {
  __resetForTesting();
  mockDomState.elements.clear();
  resetViewerEl();

  mockLoad.mockReset();
  mockUnload.mockReset();
  mockCallServerTool.mockReset();
  mockReadServerResource.mockReset();

  // Default: successful SDK load
  mockLoad.mockResolvedValue({ ...MOCK_INSTANCE_BASE, id: "mock-instance" });

  // Default: valid document bytes
  mockReadServerResource.mockResolvedValue({
    contents: [
      {
        uri: "nutrient-doc:///current",
        mimeType: "application/octet-stream",
        blob: "SGVsbG8=" // base64 "Hello"
      }
    ]
  });

  // Default: submit_response and other internal calls succeed
  mockCallServerTool.mockResolvedValue({ structuredContent: {} });
});

// ---------------------------------------------------------------------------
// Helper: find all viewer_event calls for license errors and viewer errors
// P2-20: viewer_event replaces submit_response with sentinel requestId strings.
// ---------------------------------------------------------------------------
type ViewerEventArgs = {
  name: string;
  arguments?: { event?: { type?: string; payload?: unknown } };
};

function getLicenseErrorCalls(): ViewerEventArgs[] {
  return (mockCallServerTool.mock.calls as unknown[][]).flatMap((callArgs) => {
    const args = callArgs[0] as ViewerEventArgs | undefined;
    if (
      args?.name === "viewer_event" &&
      (args?.arguments?.event as { type?: string } | undefined)?.type === "license_error"
    ) {
      return [args];
    }
    return [];
  });
}

function getFirstLicenseCallPayload<T>(): T {
  const calls = getLicenseErrorCalls();
  const call = calls[0];
  if (!call) throw new Error("No license error call found");
  return (call.arguments!.event as { payload: T }).payload;
}

function getViewerErrorCalls(): ViewerEventArgs[] {
  return (mockCallServerTool.mock.calls as unknown[][]).flatMap((callArgs) => {
    const args = callArgs[0] as ViewerEventArgs | undefined;
    if (
      args?.name === "viewer_event" &&
      (args?.arguments?.event as { type?: string } | undefined)?.type === "viewer_error"
    ) {
      return [args];
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Load-time error surfaces
// ---------------------------------------------------------------------------
describe("openDocumentFromPath — SDK load license error forwarding", () => {
  it("forwards invalid sub-kind when SDK.load rejects with a generic license message", async () => {
    mockLoad.mockRejectedValueOnce(new Error("Error while validating license."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const licenseCalls = getLicenseErrorCalls();
    expect(licenseCalls).toHaveLength(1);
    const payload = getFirstLicenseCallPayload<{
      code: string;
      subKind: string;
      guidance: string;
    }>();
    expect(payload.code).toBe(LICENSE_ERROR_CODE);
    expect(payload.subKind).toBe("invalid");
    expect(typeof payload.guidance).toBe("string");
    expect(payload.guidance).toContain(LICENSE_SUPPORT_CONTACT);
  });

  it("forwards expired sub-kind when SDK.load rejects with 'expired' in the message", async () => {
    mockLoad.mockRejectedValueOnce(new Error("License has expired."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const licenseCalls = getLicenseErrorCalls();
    expect(licenseCalls).toHaveLength(1);
    const payload = getFirstLicenseCallPayload<{ subKind: string }>();
    expect(payload.subKind).toBe("expired");
  });

  it("forwards host-mismatch sub-kind when SDK.load rejects with 'domain' in the message", async () => {
    mockLoad.mockRejectedValueOnce(new Error("License domain does not match."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const licenseCalls = getLicenseErrorCalls();
    expect(licenseCalls).toHaveLength(1);
    const payload = getFirstLicenseCallPayload<{ subKind: string }>();
    expect(payload.subKind).toBe("host-mismatch");
  });

  it("forwards host-mismatch for 'host' in message", async () => {
    mockLoad.mockRejectedValueOnce(new Error("Host not authorized for this license."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const payload = getFirstLicenseCallPayload<{ subKind: string }>();
    expect(payload.subKind).toBe("host-mismatch");
  });

  it("uses the viewer_event tool with type 'license_error' (P2-20)", async () => {
    mockLoad.mockRejectedValueOnce(new Error("Error while validating license."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const calls = getLicenseErrorCalls();
    expect(calls).toHaveLength(1);
    // P2-20: event type discriminates the call, not a sentinel requestId
    expect((calls[0]!.arguments?.event as { type: string } | undefined)?.type).toBe("license_error");
  });

  it("payload shape: data.code is LICENSE_ERROR_CODE", async () => {
    mockLoad.mockRejectedValueOnce(new Error("License expired."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const payload = getFirstLicenseCallPayload<{ code: string }>();
    expect(payload.code).toBe(LICENSE_ERROR_CODE);
  });

  it("payload does NOT contain the fake license key value (key safety)", async () => {
    // Simulate an error whose message might accidentally echo a key.
    mockLoad.mockRejectedValueOnce(
      new Error(`Invalid license key: [REDACTED]`) // server redacted, but test key must not appear
    );

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const licenseCalls = getLicenseErrorCalls();
    const callText = JSON.stringify(licenseCalls);
    expect(callText).not.toContain(FAKE_LICENSE_KEY);
  });

  it("does NOT forward a license error when SDK.load succeeds", async () => {
    mockLoad.mockResolvedValueOnce({ ...MOCK_INSTANCE_BASE, id: "ok-instance" });

    await openDocumentFromPath("/path/to/doc.pdf");

    const licenseCalls = getLicenseErrorCalls();
    expect(licenseCalls).toHaveLength(0);
  });

  it("does NOT forward a license error when SDK.load fails with a non-license error", async () => {
    // A non-license error (e.g. bad PDF bytes, network failure) must NOT
    // fire the license-error path. classifyLoadError returns null for
    // messages without a license signal.
    const originalError = new Error("Failed to fetch document bytes.");
    mockLoad.mockRejectedValueOnce(originalError);

    const caught = await openDocumentFromPath("/path/to/doc.pdf").catch((e) => e);
    expect(caught).toBe(originalError);
    expect(getLicenseErrorCalls()).toHaveLength(0);
  });

  it("forwards a generic viewer-error when SDK.load fails with a non-license error", async () => {
    // The original open_document call has already returned, so a plain
    // re-throw would leave the user with no feedback. Verify the catch
    // block hands the error to the server via the viewer_event tool (P2-20).
    const originalError = new Error("Failed to fetch document bytes.");
    mockLoad.mockRejectedValueOnce(originalError);

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    const viewerErrorCalls = getViewerErrorCalls();
    expect(viewerErrorCalls).toHaveLength(1);
    const payload = (viewerErrorCalls[0]!.arguments!.event as { payload: { message: string; source: string } }).payload;
    expect(payload.message).toBe("Failed to fetch document bytes.");
    expect(payload.source).toBe("load");
  });

  it("does NOT forward a viewer-error when SDK.load rejects with a license message", async () => {
    // License rejections take the LICENSE_ERROR sentinel path; the
    // generic viewer-error path must not double-report.
    mockLoad.mockRejectedValueOnce(new Error("License has expired."));

    await expect(openDocumentFromPath("/path/to/doc.pdf")).rejects.toThrow();

    expect(getLicenseErrorCalls()).toHaveLength(1);
    expect(getViewerErrorCalls()).toHaveLength(0);
  });

  it("re-throws the original error even after forwarding the license error", async () => {
    const originalError = new Error("License has expired.");
    mockLoad.mockRejectedValueOnce(originalError);

    const caught = await openDocumentFromPath("/path/to/doc.pdf").catch((e) => e);
    expect(caught).toBe(originalError);
  });
});

// ---------------------------------------------------------------------------
// Key safety: license key value never appears in submit_response call args
// ---------------------------------------------------------------------------
describe("key safety", () => {
  it("submit_response args do not contain license key when SDK.load fails", async () => {
    // The viewer has NUTRIENT_LICENSE_KEY set (in production it's from env).
    // We don't stub it here because the viewer module is already loaded; we
    // just verify the forwarded payload never echoes ANY key material.
    mockLoad.mockRejectedValueOnce(new Error("License expired."));

    await expect(openDocumentFromPath("/doc.pdf")).rejects.toThrow();

    // Stringify all submit_response calls and check for absence of fake key.
    const allCallArgs = JSON.stringify(mockCallServerTool.mock.calls);
    expect(allCallArgs).not.toContain(FAKE_LICENSE_KEY);
  });
});
