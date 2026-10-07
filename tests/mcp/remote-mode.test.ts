/**
 * Hosted (remote) connector mode: open_document_url, in-memory remote
 * documents, per-session isolation and the Streamable HTTP entry point.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, REMOTE_SERVER_NAME } from "../../src/mcp/server.js";
import * as session from "../../src/mcp/session.js";
import {
  __putRemoteDocumentForTesting,
  __resetRemoteDocumentsForTesting,
  fetchRemoteDocument,
  getRemoteDocument,
  isRemoteDocumentPath,
  validateDownloadUrl
} from "../../src/mcp/remote-documents.js";
import { startHttpServer } from "../../src/mcp/http-server.js";

const UI_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } }
};
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

function pdfResponse(headers: Record<string, string> = {}): Response {
  return new Response(PDF_BYTES, {
    status: 200,
    headers: { "content-type": "application/pdf", ...headers }
  });
}

async function connectRemote(): Promise<Client> {
  const server = createServer({ mode: "remote" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "claude-ai-test", version: "1.0.0" },
    { capabilities: UI_CAPABILITIES as unknown as Record<string, never> }
  );
  await client.connect(clientTransport);
  return client;
}

beforeAll(() => {
  (globalThis as { __NUTRIENT_SDK_VERSION__?: string }).__NUTRIENT_SDK_VERSION__ = "1.15.0";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-remote-"));
  fs.writeFileSync(path.join(dir, "mcp-app.html"), "<html><body><div id=viewer></div></body></html>");
  process.env.NUTRIENT_VIEWER_LIB_DIR = dir;
});

beforeEach(() => {
  session.__resetForTesting();
  __resetRemoteDocumentsForTesting();
  delete process.env.NUTRIENT_ALLOWED_DOWNLOAD_HOSTS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateDownloadUrl", () => {
  it("accepts Salesforce download hosts", () => {
    expect(validateDownloadUrl("https://acme.file.force.com/sfc/dist/version/download/?oid=1").hostname).toBe(
      "acme.file.force.com"
    );
    expect(validateDownloadUrl("https://acme.my.salesforce.com/sfc/dist/version/download/").hostname).toBe(
      "acme.my.salesforce.com"
    );
  });

  it("rejects http, credentials and other hosts", () => {
    expect(() => validateDownloadUrl("http://acme.file.force.com/x")).toThrow(/https/);
    expect(() => validateDownloadUrl("https://user:pw@acme.file.force.com/x")).toThrow(/credentials/);
    expect(() => validateDownloadUrl("https://evil.example.com/x")).toThrow(/not allowed/);
    expect(() => validateDownloadUrl("https://force.com.evil.example/x")).toThrow(/not allowed/);
    expect(() => validateDownloadUrl("not a url")).toThrow(/valid/);
  });

  it("honors NUTRIENT_ALLOWED_DOWNLOAD_HOSTS", () => {
    process.env.NUTRIENT_ALLOWED_DOWNLOAD_HOSTS = "*.example.org";
    expect(validateDownloadUrl("https://files.example.org/a.pdf").hostname).toBe("files.example.org");
    expect(() => validateDownloadUrl("https://acme.file.force.com/x")).toThrow(/not allowed/);
  });
});

describe("fetchRemoteDocument", () => {
  it("downloads, caches and names the document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pdfResponse({ "content-disposition": 'attachment; filename="Quote - Acme.pdf"' }))
    );
    const doc = await fetchRemoteDocument("https://acme.file.force.com/sfc/dist/version/download/?oid=1");
    expect(isRemoteDocumentPath(doc.documentPath)).toBe(true);
    expect(doc.fileName).toBe("Quote - Acme.pdf");
    expect(getRemoteDocument(doc.documentPath)?.bytes.equals(PDF_BYTES)).toBe(true);
  });

  it("rejects HTML pages such as expired-link pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!DOCTYPE html><html>Link expired</html>", { headers: { "content-type": "text/html" } }))
    );
    await expect(fetchRemoteDocument("https://acme.file.force.com/x")).rejects.toThrow(/web page/);
  });

  it("re-validates every redirect hop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }))
    );
    await expect(fetchRemoteDocument("https://acme.file.force.com/x")).rejects.toThrow(/not allowed/);
  });

  it("enforces the size limit", async () => {
    process.env.NUTRIENT_REMOTE_DOC_MAX_BYTES = "10";
    try {
      vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
      await expect(fetchRemoteDocument("https://acme.file.force.com/x")).rejects.toThrow(/too large/);
    } finally {
      delete process.env.NUTRIENT_REMOTE_DOC_MAX_BYTES;
    }
  });

  it("explains failed downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await expect(fetchRemoteDocument("https://acme.file.force.com/x")).rejects.toThrow(/HTTP 404/);
  });
});

describe("remote server", () => {
  it("advertises open_document_url instead of the local open_document", async () => {
    const client = await connectRemote();
    expect(client.getServerVersion()?.name).toBe(REMOTE_SERVER_NAME);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("open_document_url");
    expect(names).not.toContain("open_document");
    expect(names).not.toContain("poll_commands");
    const open = tools.find((t) => t.name === "open_document_url");
    expect((open?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe("ui://nutrient-viewer/mcp-app.html");
  });

  it("opens a URL and serves its bytes through the document resource", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
    const client = await connectRemote();
    const result = (await client.callTool({
      name: "open_document_url",
      arguments: { url: "https://acme.file.force.com/sfc/dist/version/download/?oid=1", fileName: "Quote.pdf" }
    })) as { structuredContent?: { documentPath?: string; viewUUID?: string; fileName?: string } };
    const documentPath = result.structuredContent?.documentPath ?? "";
    expect(isRemoteDocumentPath(documentPath)).toBe(true);
    expect(result.structuredContent?.fileName).toBe("Quote.pdf");

    const read = await client.readResource({ uri: `nutrient-doc:///current?path=${encodeURIComponent(documentPath)}` });
    const blob = (read.contents[0] as { blob?: string }).blob ?? "";
    expect(Buffer.from(blob, "base64").equals(PDF_BYTES)).toBe(true);
  });

  it("injects trial mode and remote flags into the viewer HTML", async () => {
    const client = await connectRemote();
    const read = await client.readResource({ uri: "ui://nutrient-viewer/mcp-app.html" });
    const html = (read.contents[0] as { text?: string }).text ?? "";
    expect(html).toContain('window.__NUTRIENT_LICENSE_KEY__ = ""');
    expect(html).toContain("window.__NUTRIENT_REMOTE_MODE__ = true");
    expect(html).toContain("window.__NUTRIENT_APP_NAME__ = null");
  });

  it("stores viewer saves for remote documents", async () => {
    const doc = __putRemoteDocumentForTesting("a.pdf", PDF_BYTES);
    const client = await connectRemote();
    const edited = Buffer.from("%PDF-1.7 edited");
    const first = edited.subarray(0, 5);
    const rest = edited.subarray(5);
    await client.callTool({
      name: "write_document_bytes",
      arguments: {
        offset: 0,
        byteCount: first.length,
        dataBase64: first.toString("base64"),
        isFinal: false,
        documentPath: doc.documentPath
      }
    });
    const final = (await client.callTool({
      name: "write_document_bytes",
      arguments: {
        offset: first.length,
        byteCount: rest.length,
        dataBase64: rest.toString("base64"),
        isFinal: true,
        documentPath: doc.documentPath
      }
    })) as { isError?: boolean };
    expect(final.isError).not.toBe(true);
    expect(getRemoteDocument(doc.documentPath)?.bytes.equals(edited)).toBe(true);
    expect(getRemoteDocument(doc.documentPath)?.saveCount).toBe(1);
  });

  it("returns the stale sentinel for unknown remote documents", async () => {
    const client = await connectRemote();
    await expect(
      client.readResource({ uri: `nutrient-doc:///current?path=${encodeURIComponent("remote-doc://missing/a.pdf")}` })
    ).rejects.toThrow(/stale-document-path/);
  });
});

describe("per-session isolation", () => {
  it("keeps the open document and owned views per session context", () => {
    const a = session.createSessionContext();
    const b = session.createSessionContext();
    session.runInSessionContext(a, () => {
      session.setOpenDocument("remote-doc://a/a.pdf");
      session.addOwnedView("view-a");
      expect(session.isScopedSession()).toBe(true);
    });
    session.runInSessionContext(b, () => {
      expect(session.hasOpenDocument()).toBe(false);
      expect(session.isOwnedView("view-a")).toBe(false);
    });
    session.runInSessionContext(a, () => {
      expect(session.getDocumentPath()).toBe("remote-doc://a/a.pdf");
      expect(session.isOwnedView("view-a")).toBe(true);
    });
    // Default (stdio) context is unaffected and unscoped.
    expect(session.hasOpenDocument()).toBe(false);
    expect(session.isScopedSession()).toBe(false);
  });
});

describe("Streamable HTTP entry point", () => {
  it("serves health and MCP sessions over HTTP", async () => {
    const httpServer = startHttpServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
    const { port } = httpServer.address() as AddressInfo;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);

      const clients = await Promise.all(
        [1, 2].map(async () => {
          const client = new Client(
            { name: "claude-ai-test", version: "1.0.0" },
            { capabilities: UI_CAPABILITIES as unknown as Record<string, never> }
          );
          await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
          return client;
        })
      );
      for (const client of clients) {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("open_document_url");
      }
      const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(rejected.status).toBe(400);
      await Promise.all(clients.map((c) => c.close()));
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
