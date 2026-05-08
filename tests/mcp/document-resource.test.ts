import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadResourceRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  registerCurrentDocumentResource,
  DOCUMENT_RESOURCE_URI_BASE,
  STALE_PATH_ERROR_PREFIX,
} from "../../src/mcp/document-resource.js";
import * as sessionModule from "../../src/mcp/session.js";

/**
 * Round-trip a `resources/read` request through the real SDK request
 * handler — NOT through the registered template's read callback
 * directly. This is critical: the bug class we're guarding against
 * here is "the SDK doesn't match my URI to my registered handler", and
 * calling the callback directly bypasses the very lookup we want to
 * exercise.
 */
async function readResource(server: McpServer, uri: string): Promise<{
  contents: Array<{ uri: string; mimeType?: string; blob?: string }>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server.server as any)._requestHandlers as Map<
    string,
    (req: unknown, extra: unknown) => Promise<unknown>
  >;
  const method = ReadResourceRequestSchema.shape.method.value;
  const handler = handlers.get(method);
  if (!handler) throw new Error("resources/read handler not registered");
  const req = { method, params: { uri } };
  return (await handler(req, {
    requestId: "test",
    sendNotification: async () => undefined,
    sendRequest: async () => ({}),
    signal: new AbortController().signal,
  })) as { contents: Array<{ uri: string; mimeType?: string; blob?: string }> };
}

describe("nutrient-doc:///current resource", () => {
  let tempDir: string;
  let docPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-doc-resource-"));
    docPath = path.join(tempDir, "doc.pdf");
    fs.writeFileSync(docPath, Buffer.from("PDF-BYTES"));
    sessionModule.__resetForTesting();
  });

  afterEach(() => {
    sessionModule.clearOpenDocument();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("returns bytes when the iframe's `?path` matches session documentPath", async () => {
    sessionModule.setOpenDocument(docPath);
    const server = new McpServer({ name: "test", version: "0.1.0" });
    registerCurrentDocumentResource(server);

    const uri = `${DOCUMENT_RESOURCE_URI_BASE}?path=${encodeURIComponent(docPath)}`;
    const res = await readResource(server, uri);
    expect(res.contents).toHaveLength(1);
    expect(res.contents[0]!.blob).toBe(Buffer.from("PDF-BYTES").toString("base64"));
  });

  it("rejects with InvalidRequest when no document is open", async () => {
    const server = new McpServer({ name: "test", version: "0.1.0" });
    registerCurrentDocumentResource(server);

    const uri = `${DOCUMENT_RESOURCE_URI_BASE}?path=${encodeURIComponent(docPath)}`;
    await expect(readResource(server, uri)).rejects.toBeInstanceOf(McpError);
  });

  it("throws stale-document-path McpError when iframe's `?path` differs from session documentPath", async () => {
    sessionModule.setOpenDocument(docPath);
    const server = new McpServer({ name: "test", version: "0.1.0" });
    registerCurrentDocumentResource(server);

    const otherPath = path.join(tempDir, "other.pdf");
    const uri = `${DOCUMENT_RESOURCE_URI_BASE}?path=${encodeURIComponent(otherPath)}`;
    try {
      await readResource(server, uri);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain(STALE_PATH_ERROR_PREFIX);
      expect((err as McpError).message).toContain(otherPath);
      expect((err as McpError).message).toContain(docPath);
    }
  });

  it("doesn't read the file from disk when the path mismatches (no incidental I/O)", async () => {
    sessionModule.setOpenDocument(docPath);
    const server = new McpServer({ name: "test", version: "0.1.0" });
    registerCurrentDocumentResource(server);

    // Mismatching path — server should reject *before* hitting fs.readFile.
    // We can verify this indirectly by pointing at a non-existent path:
    // a non-stale-aware handler would attempt the read and get ENOENT.
    const otherPath = path.join(tempDir, "does-not-exist.pdf");
    const uri = `${DOCUMENT_RESOURCE_URI_BASE}?path=${encodeURIComponent(otherPath)}`;
    try {
      await readResource(server, uri);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain(STALE_PATH_ERROR_PREFIX);
      expect((err as McpError).message).not.toMatch(/ENOENT|no such file/i);
    }
  });

  it("returns 'Resource not found' for the bare URI form (legacy path is no longer registered)", async () => {
    sessionModule.setOpenDocument(docPath);
    const server = new McpServer({ name: "test", version: "0.1.0" });
    registerCurrentDocumentResource(server);

    // Bare URI — the cross-conversation guard requires `?path`. The SDK's
    // resource lookup returns "Resource not found" since neither a static
    // registration nor the template (which expects `?path`) matches the
    // bare form.
    await expect(
      readResource(server, DOCUMENT_RESOURCE_URI_BASE),
    ).rejects.toThrow(/not found|Resource/i);
  });
});
