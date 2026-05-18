import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPClient } from "./mcp-client.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

// Statically advertised tools — runtime guards in each handler enforce
// "document open" semantics; the tools/list surface is stable across the lifecycle.
const EXPECTED_PUBLIC_TOOL_NAMES = [
  "open_document",
  "close_document",
  "get_view_state",
  "set_view_state",
  "search_exact_text",
  "read_document_information",
  "read_page_info",
  "read_text",
  "get_page_image",
  "create_annotation",
  "read_annotations",
  "update_annotation",
  "delete_annotation",
  "apply_annotations",
  "read_form_fields",
  "update_form_field_values"
];

const HIDDEN_INTERNAL_TOOL_NAMES = [
  "poll_commands",
  "submit_response"
];

describe("lifecycle integration test", () => {
  let client: MCPClient;
  // Captured from open_document responses; reused by subsequent operating-tool
  // tests that need a viewUUID for `pollAndRespond`. Replaces the prior
  // `ping`-then-read-`_meta.viewUUID` pattern, since `ping` was removed from
  // the public tool surface.
  let activeViewUUID = "";

  beforeAll(() => {
    const distPath = path.join(projectRoot, "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
    // Shrink the long-poll window so empty `poll_commands` calls return
    // quickly. The integration test's pollAndRespond helper iterates a
    // setTimeout(100) loop expecting cheap empty polls; with the production
    // 25 s default it would block far past the per-test timeout.
    client = new MCPClient(fixturesDir, { LONG_POLL_TIMEOUT_MS: "200" });
  });

  afterAll(() => {
    client.close();
  });

  async function pollAndRespond(
    viewUUID: string,
    expectedCommandType: string,
    response: any
  ): Promise<string> {
    const pollTimeout = 3000;
    const pollInterval = 100;
    let requestId = "";
    const startTime = Date.now();

    while (Date.now() - startTime < pollTimeout && !requestId) {
      const pollRes = await client.send({
        method: "tools/call",
        params: {
          name: "poll_commands",
          arguments: { viewUUID }
        }
      });

      const pollContent = pollRes.result!.content?.[0]?.text;
      const pollData = JSON.parse(pollContent!);

      if (pollData.commands && pollData.commands.length > 0) {
        const cmd = pollData.commands[0];
        if (cmd.type === expectedCommandType) {
          requestId = cmd.requestId;

          await client.send({
            method: "tools/call",
            params: {
              name: "submit_response",
              arguments: {
                requestId,
                data: response
              }
            }
          });
          break;
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    expect(requestId.length > 0).toBe(true);
    return requestId;
  }

  it("(1) Initialize and assert capability declaration", { timeout: 10000 }, async () => {
    const initRes = await client.initialize();
    expect(initRes.result).toBeDefined();
    // The capability flag is auto-declared by the MCP SDK when tools are registered,
    // so we don't assert on its value. The invariant under runtime guards is
    // captured by the per-step `listChangedAfter - listChangedBefore === 0`
    // assertions later in this file.
    expect(initRes.result!.capabilities.tools).toBeDefined();
  });

  it("(2) Pre-open tools/list returns the full public surface (no gating)", { timeout: 10000 }, async () => {
    const listRes = await client.send({
      method: "tools/list",
      params: {}
    });
    expect(listRes.result).toBeDefined();
    const toolNames = (listRes.result!.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual([...EXPECTED_PUBLIC_TOOL_NAMES].sort());
    for (const internal of HIDDEN_INTERNAL_TOOL_NAMES) {
      expect(toolNames).not.toContain(internal);
    }
  });

  it("(3) open_document succeeds and does NOT emit tools/list_changed", { timeout: 10000 }, async () => {
    const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");
    expect(fs.existsSync(fixturePath)).toBe(true);

    const listChangedBefore = client.getNotifications()
      .filter((n) => n.method === "notifications/tools/list_changed").length;

    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });
    expect(openRes.result).toBeDefined();
    expect(openRes.result!.structuredContent.documentPath).toBe(fixturePath);
    activeViewUUID = openRes.result!._meta!.viewUUID as string;
    expect(activeViewUUID.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 100));

    const listChangedAfter = client.getNotifications()
      .filter((n) => n.method === "notifications/tools/list_changed").length;
    expect(listChangedAfter - listChangedBefore).toBe(0);

    // tools/list is unchanged.
    const listAfterRes = await client.send({
      method: "tools/list",
      params: {}
    });
    const toolNamesAfter = (listAfterRes.result!.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(toolNamesAfter).toEqual([...EXPECTED_PUBLIC_TOOL_NAMES].sort());
  });

  it("(4) Operate: read_document_information", { timeout: 10000 }, async () => {
    const readDocPromise = client.send({
      method: "tools/call",
      params: {
        name: "read_document_information",
        arguments: {}
      }
    });

    const stubDocInfo = {
      pageCount: 5,
      title: "Test Document",
      permissions: {
        annotationsAndForms: true,
        assemble: true,
        extract: true,
        extractAccessibility: true,
        fillForms: true,
        modification: true,
        printHighQuality: true,
        printing: true
      }
    };

    const viewUUID = activeViewUUID;

    await pollAndRespond(viewUUID, "read_document_information", stubDocInfo);

    const readDocRes = await readDocPromise;
    expect(readDocRes.result!.structuredContent).toBeDefined();
    const result = readDocRes.result!.structuredContent as any;
    expect(result.pageCount).toBe(5);
    expect(result.title).toBe("Test Document");
  });

  it("(5) Operate: search_exact_text", { timeout: 10000 }, async () => {
    const searchPromise = client.send({
      method: "tools/call",
      params: {
        name: "search_exact_text",
        arguments: { query: "test query" }
      }
    });

    const viewUUID = activeViewUUID;

    const stubSearchResults = {
      hits: [
        {
          hitId: "h1",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 50, height: 15 },
          snippet: "test query"
        }
      ]
    };

    await pollAndRespond(viewUUID, "search_exact_text", stubSearchResults);

    const searchRes = await searchPromise;
    expect(searchRes.result!.structuredContent).toBeDefined();
    const result = searchRes.result!.structuredContent as any;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].pageIndex).toBe(0);
  });

  it("(6) close_document succeeds and does NOT emit tools/list_changed", { timeout: 10000 }, async () => {
    const listChangedBefore = client.getNotifications()
      .filter((n) => n.method === "notifications/tools/list_changed").length;

    const closePromise = client.send({
      method: "tools/call",
      params: {
        name: "close_document",
        arguments: {}
      }
    });

    const viewUUID = activeViewUUID;

    await pollAndRespond(viewUUID, "close_document", { closed: true });

    const closeRes = await closePromise;
    expect(closeRes.result!.structuredContent).toBeDefined();
    expect((closeRes.result!.structuredContent as any).closed).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const listChangedAfter = client.getNotifications()
      .filter((n) => n.method === "notifications/tools/list_changed").length;
    expect(listChangedAfter - listChangedBefore).toBe(0);

    // tools/list still returns the same full surface.
    const listRes = await client.send({
      method: "tools/list",
      params: {}
    });
    const toolNames = (listRes.result!.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual([...EXPECTED_PUBLIC_TOOL_NAMES].sort());
  });

  it("(7) close_document pre-open is an idempotent no-op", { timeout: 10000 }, async () => {
    // No document is open at this point (just closed in step 8). A second close
    // must not enqueue anything; it returns success immediately.
    const closeRes = await client.send({
      method: "tools/call",
      params: {
        name: "close_document",
        arguments: {}
      }
    });
    expect(closeRes.error).toBeUndefined();
    expect(closeRes.result!.structuredContent).toEqual({ closed: true });
  });

  it("(8) Reopen with a different path mints a fresh viewUUID and broadcasts close to the prior view", { timeout: 15000 }, async () => {
    const fixture1 = path.join(projectRoot, "tests/fixtures/sample.pdf");
    const fixture2 = path.join(projectRoot, "tests/fixtures/sample-2.pdf");
    expect(fs.existsSync(fixture1)).toBe(true);
    expect(fs.existsSync(fixture2)).toBe(true);

    const open1Res = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixture1 }
      }
    });
    expect(open1Res.result).toBeDefined();
    expect(open1Res.result!.structuredContent.documentPath).toBe(fixture1);
    const viewUUID1: string = open1Res.result!.structuredContent.viewUUID;

    // Mark viewUUID1 as live by polling. The broadcast-close in the next
    // open targets recently-polled views; without this poll the broadcast
    // would skip viewUUID1 as "dead."
    await client.send({
      method: "tools/call",
      params: { name: "poll_commands", arguments: { viewUUID: viewUUID1 } }
    });

    // Second open — kick off async; it will broadcast close_document to
    // viewUUID1 and wait for the ack (or its 2 s timeout).
    const open2Promise = client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixture2 }
      }
    });

    // Drain viewUUID1's queue: the broadcast close should have landed there.
    // Poll for it (broadcast happens in the open2 handler, async).
    const closeRequestId = await pollAndRespond(
      viewUUID1,
      "close_document",
      { closed: true }
    );
    expect(closeRequestId.length).toBeGreaterThan(0);

    // Now open2 unblocks and returns with a fresh viewUUID.
    const open2Res = await open2Promise;
    expect(open2Res.result!.structuredContent.documentPath).toBe(fixture2);
    const viewUUID2: string = open2Res.result!.structuredContent.viewUUID;
    expect(viewUUID2).not.toBe(viewUUID1);
    expect(open2Res.result!._meta!.viewUUID).toBe(viewUUID2);
    // The active session has rolled to viewUUID2 — update the shared marker
    // so subsequent tests (e.g. test (9) Final close) target the live UUID
    // instead of the stale one captured back in test (3).
    activeViewUUID = viewUUID2;
  });

  it("(9) Final close after reopen", { timeout: 10000 }, async () => {
    const closePromise = client.send({
      method: "tools/call",
      params: {
        name: "close_document",
        arguments: {}
      }
    });

    const viewUUID = activeViewUUID;

    await pollAndRespond(viewUUID, "close_document", { closed: true });

    const closeRes = await closePromise;
    expect(closeRes.result!.structuredContent).toBeDefined();

    // tools/list is unchanged — full public surface.
    const listRes = await client.send({
      method: "tools/list",
      params: {}
    });
    const toolNames = (listRes.result!.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual([...EXPECTED_PUBLIC_TOOL_NAMES].sort());
  });
});

// P2-21: Integration tests for the 7 tools that previously lacked happy-path
// coverage at the process-boundary level.
describe("P2-21: operating-tool integration happy-paths", () => {
  let client: MCPClient;
  // Captured from the `beforeAll` open_document response. The session minted
  // here is shared by every test in this describe; capturing once at open
  // time replaces the prior per-test `ping`-then-read-`_meta.viewUUID` call.
  let activeViewUUID = "";
  const fixturePath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../"), "tests/fixtures/sample.pdf");

  function getViewUUID(): string {
    return activeViewUUID;
  }

  async function pollAndRespond(
    viewUUID: string,
    expectedCommandType: string,
    response: unknown
  ): Promise<string> {
    const pollTimeout = 3000;
    const pollInterval = 100;
    let requestId = "";
    const startTime = Date.now();

    while (Date.now() - startTime < pollTimeout && !requestId) {
      const pollRes = await client.send({
        method: "tools/call",
        params: { name: "poll_commands", arguments: { viewUUID } }
      });
      const pollData = JSON.parse(pollRes.result!.content?.[0]?.text ?? "{}");
      if (pollData.commands?.length > 0) {
        const cmd = pollData.commands[0];
        if (cmd.type === expectedCommandType) {
          requestId = cmd.requestId;
          await client.send({
            method: "tools/call",
            params: {
              name: "submit_response",
              arguments: { requestId, data: response }
            }
          });
          break;
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    return requestId;
  }

  beforeAll(async () => {
    const distPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../"), "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
    const fixturesDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../"), "tests/fixtures");
    client = new MCPClient(fixturesDir, { LONG_POLL_TIMEOUT_MS: "200" });
    await client.initialize();
    // Open a document so operating tools pass the requireOpenDocument guard.
    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });
    activeViewUUID = openRes.result!._meta!.viewUUID as string;
  });

  afterAll(() => {
    client.close();
  });

  it("get_page_image: returns image content and page dimensions", { timeout: 10000 }, async () => {
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "get_page_image",
        arguments: { pageIndex: 0 }
      }
    });
    const viewUUID = getViewUUID();
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await pollAndRespond(viewUUID, "get_page_image", {
      pngDataUrl: `data:image/png;base64,${base64}`,
      pageWidth: 612,
      pageHeight: 792,
      renderedWidth: 1200
    });
    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(sc.pageWidth).toBe(612);
    expect(sc.pageHeight).toBe(792);
    // Image content block is in content[0]
    const imageContent = result.result!.content?.[0] as any;
    expect(imageContent?.type).toBe("image");
    expect(imageContent?.mimeType).toBe("image/png");
  });

  it("read_annotations: returns annotations array from viewer", { timeout: 10000 }, async () => {
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "read_annotations",
        arguments: { pageIndex: 0 }
      }
    });
    const viewUUID = getViewUUID();
    const stubAnnotation = {
      v: 1,
      type: "pspdfkit/ink",
      id: "ann-ink-1",
      pageIndex: 0,
      bbox: [10, 20, 110, 70],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lines: { intensities: [[1]], points: [[{ x: 10, y: 20 }]] },
      isSignature: false,
      lineWidth: 2
    };
    await pollAndRespond(viewUUID, "read_annotations", { annotations: [stubAnnotation] });
    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(Array.isArray(sc.annotations)).toBe(true);
    expect(sc.annotations).toHaveLength(1);
    expect(sc.annotations[0].type).toBe("pspdfkit/ink");
  });

  it("update_annotation: returns updated annotation id", { timeout: 10000 }, async () => {
    const annotationUpdate = {
      v: 1,
      type: "pspdfkit/ink",
      id: "ann-ink-1",
      pageIndex: 0,
      bbox: [10, 20, 110, 70],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lines: { intensities: [[1]], points: [[{ x: 10, y: 20 }]] },
      isSignature: false,
      lineWidth: 3
    };
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "update_annotation",
        arguments: { id: "ann-ink-1", patch: { lineWidth: 3 } }
      }
    });
    const viewUUID = getViewUUID();
    await pollAndRespond(viewUUID, "update_annotation", { id: "ann-ink-1", annotation: annotationUpdate });
    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(sc.id).toBe("ann-ink-1");
  });

  it("delete_annotation: returns the deleted annotation id", { timeout: 10000 }, async () => {
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "delete_annotation",
        arguments: { id: "ann-ink-1" }
      }
    });
    const viewUUID = getViewUUID();
    await pollAndRespond(viewUUID, "delete_annotation", { id: "ann-ink-1" });
    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(sc.id).toBe("ann-ink-1");
  });

  it("read_form_fields: returns form fields array from viewer", { timeout: 10000 }, async () => {
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "read_form_fields",
        arguments: {}
      }
    });
    const viewUUID = getViewUUID();
    await pollAndRespond(viewUUID, "read_form_fields", {
      fields: [
        {
          v: 1,
          type: "pspdfkit/form-field/text",
          id: "field-1",
          pdfObjectId: 1,
          name: "applicant.name",
          annotationIds: ["w1"],
          label: "Full Name",
          flags: [],
          password: false,
          doNotScroll: false,
          multiLine: false,
          defaultValue: "",
          comb: false,
          doNotSpellCheck: false,
          value: "John Doe",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 20 }
        }
      ]
    });
    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(Array.isArray(sc.fields)).toBe(true);
    expect(sc.fields).toHaveLength(1);
    expect(sc.fields[0].name).toBe("applicant.name");
  });

  it("update_form_field_values: returns {updated, unresolved}", { timeout: 10000 }, async () => {
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "update_form_field_values",
        arguments: {
          formFieldValues: [{ name: "applicant.name", value: "Jane Doe" }]
        }
      }
    });
    const viewUUID = getViewUUID();
    await pollAndRespond(viewUUID, "update_form_field_values", {
      updated: [{ name: "applicant.name", value: "Jane Doe" }],
      unresolved: []
    });
    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(sc.updated).toHaveLength(1);
    expect(sc.updated[0].name).toBe("applicant.name");
    expect(sc.unresolved).toEqual([]);
  });

  it("apply_annotations (no-elicitation Cowork path): returns applied audit", { timeout: 10000 }, async () => {
    // The integration server process does not advertise elicitation capability,
    // so apply_annotations takes the direct-apply (Cowork) path.
    const toolPromise = client.send({
      method: "tools/call",
      params: {
        name: "apply_annotations",
        arguments: {}
      }
    });
    const viewUUID = getViewUUID();

    // First the tool reads pending redactions
    await pollAndRespond(viewUUID, "read_annotations", {
      annotations: [
        {
          id: "ann-red-1",
          type: "redaction",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 30 }
        }
      ]
    });

    // Then it issues apply_redactions_now
    await pollAndRespond(viewUUID, "apply_redactions_now", { ok: true });

    const result = await toolPromise;
    expect(result.result!.structuredContent).toBeDefined();
    const sc = result.result!.structuredContent as any;
    expect(Array.isArray(sc.applied)).toBe(true);
    expect(sc.applied).toHaveLength(1);
  });
});
