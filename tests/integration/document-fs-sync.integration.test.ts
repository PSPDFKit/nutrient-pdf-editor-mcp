import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCPClient } from "./mcp-client.js";

/**
 * End-to-end integration tests for the document/fs-sync feature
 * (project: hype-tools-mcp / 06-viewer-mcp-document-fs-sync, phases 1-4).
 *
 * Strategy: spawn a real MCP server (dist/index.js) via the existing
 * MCPClient, then drive both the model side (open_document, operating
 * tools) AND the iframe side (write_document_bytes) from the test
 * process. There is no real Nutrient SDK in this test; the chunked
 * write tool is the iframe→server transport, and we exercise it
 * directly with bytes we control.
 *
 * Coverage:
 *   1. End-to-end byte round-trip via write_document_bytes.
 *   2. requireFreshDocument fires on operating tools after an external
 *      edit + watcher event.
 *   3. D11 pre-rename stat-compare aborts the save when the destination
 *      diverges from the checkpoint mid-stream.
 *   4. Self-save preserves freshness for a subsequent save (the
 *      isPendingSave suppression + checkpoint refresh combo).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");

interface CallToolResponseSuccess {
  jsonrpc: string;
  id: number | string;
  result?: {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
    _meta?: { viewUUID?: string };
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function callTool(
  client: MCPClient,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResponseSuccess> {
  return (await client.send({
    method: "tools/call",
    params: { name, arguments: args },
  })) as CallToolResponseSuccess;
}

function expectToolError(
  res: CallToolResponseSuccess,
  matcher: RegExp,
): void {
  // The MCP SDK surfaces handler-thrown McpErrors as a JSON-RPC error on
  // the response envelope. Some clients also surface them via isError +
  // text content. Accept either shape.
  if (res.error) {
    expect(res.error.message).toMatch(matcher);
    return;
  }
  expect(res.result?.isError).toBe(true);
  const text = res.result?.content?.find((c) => c.type === "text")?.text;
  expect(text ?? "").toMatch(matcher);
}

async function chunkedWrite(
  client: MCPClient,
  bytes: Buffer,
  documentPath: string,
): Promise<CallToolResponseSuccess> {
  const CHUNK = 256 * 1024;
  let last: CallToolResponseSuccess | null = null;
  if (bytes.length === 0) {
    return await callTool(client, "write_document_bytes", {
      offset: 0,
      byteCount: 0,
      dataBase64: "",
      isFinal: true,
      documentPath,
    });
  }
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    const chunk = bytes.subarray(offset, end);
    last = await callTool(client, "write_document_bytes", {
      offset,
      byteCount: chunk.length,
      dataBase64: chunk.toString("base64"),
      isFinal: end === bytes.length,
      documentPath,
    });
    if (last.error || last.result?.isError) return last;
  }
  return last!;
}

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 4000,
  stepMs = 100,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise<void>((r) => setTimeout(r, stepMs));
  }
  return cond();
}

/**
 * Drain the command queue and ack a `close_document` command so the
 * server-side handler resolves promptly instead of waiting out its
 * 30 s viewer timeout. Without this, a prior test's `close_document`
 * stays pending across the test boundary and eventually clears the
 * next test's session state mid-run.
 *
 * `viewUUID` is the active session id captured at the most recent
 * `open_document` call site (replaces the prior ping-then-read pattern,
 * since `ping` was removed from the public tool surface).
 */
async function ackPendingCloseDocument(client: MCPClient, viewUUID: string): Promise<void> {
  if (!viewUUID) return;
  const start = Date.now();
  while (Date.now() - start < 1000) {
    const poll = await callTool(client, "poll_commands", { viewUUID });
    const text = poll.result?.content?.find((c) => c.type === "text")?.text;
    if (text) {
      const data = JSON.parse(text) as {
        commands?: Array<{ type: string; requestId: string }>;
      };
      const cmd = data.commands?.find((c) => c.type === "close_document");
      if (cmd) {
        await callTool(client, "submit_response", {
          requestId: cmd.requestId,
          data: { closed: true },
        });
        return;
      }
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

describe("document-fs-sync integration", () => {
  let workspace: string;
  let client: MCPClient;
  // Updated by every `open_document` call site; consumed by `closeDoc` so
  // `ackPendingCloseDocument` can poll the right session without `ping`.
  let activeViewUUID = "";

  beforeAll(async () => {
    const distPath = path.join(projectRoot, "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-fs-sync-int-"));
    client = new MCPClient(workspace, { LONG_POLL_TIMEOUT_MS: "200" });
    await client.initialize();
  });

  afterAll(() => {
    client.close();
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function freshDoc(name: string, contents: Buffer): Promise<string> {
    const docPath = path.join(workspace, name);
    fs.writeFileSync(docPath, contents);
    return docPath;
  }

  async function openDoc(args: { path: string }): Promise<Awaited<ReturnType<typeof callTool>>> {
    // Wraps `open_document` so every callsite updates `activeViewUUID` for
    // `closeDoc` to use later. Returns the underlying tool response so callers
    // can keep asserting on it.
    const open = await callTool(client, "open_document", args);
    const viewUUID = (open.result?._meta as { viewUUID?: string } | undefined)?.viewUUID;
    if (viewUUID) activeViewUUID = viewUUID;
    return open;
  }

  async function closeDoc(): Promise<void> {
    // Issue close_document and concurrently ack the iframe command it
    // enqueues, so the handler resolves promptly. Without this the
    // server's 30 s viewer-timeout fires after the test moves on and
    // clears the NEXT test's session state mid-run.
    const closePromise = callTool(client, "close_document", {});
    await ackPendingCloseDocument(client, activeViewUUID);
    await closePromise;
  }

  it("round-trip: open → chunked write → file matches the bytes we sent", { timeout: 15000 }, async () => {
    const seedBytes = Buffer.from("ORIGINAL-CONTENT-12345");
    const docPath = await freshDoc("round-trip.pdf", seedBytes);
    try {
      const open = await openDoc({ path: docPath });
      expect((open.result?.structuredContent as { documentPath: string }).documentPath).toBe(docPath);

      // Build a buffer that exceeds one CHUNK so we exercise multi-chunk path.
      const newSize = 600 * 1024; // 600 KiB
      const newBytes = Buffer.alloc(newSize);
      for (let i = 0; i < newSize; i++) newBytes[i] = (i * 7 + 3) & 0xff;

      const finalRes = await chunkedWrite(client, newBytes, docPath);
      expect(finalRes.error).toBeUndefined();
      expect(finalRes.result?.isError).not.toBe(true);
      const onDisk = fs.readFileSync(docPath);
      expect(onDisk.length).toBe(newSize);
      expect(onDisk.equals(newBytes)).toBe(true);
    } finally {
      await closeDoc();
    }
  });

  it("D11: external edit during chunked save aborts the finalizing chunk", { timeout: 15000 }, async () => {
    const seed = Buffer.from("PRE-EDIT");
    const docPath = await freshDoc("d11-race.pdf", seed);
    try {
      await openDoc({ path: docPath });

      // Send a non-final chunk first so the staging file exists. Then have
      // an "external editor" rewrite the destination — this changes its
      // size and (with the 1.1s sleep) its mtime, diverging from the
      // checkpoint snapshotted by open_document.
      const part1 = Buffer.from("OUR-SAVE-PART-1-");
      const okRes = await callTool(client, "write_document_bytes", {
        offset: 0,
        byteCount: part1.length,
        dataBase64: part1.toString("base64"),
        isFinal: false,
        documentPath: docPath,
      });
      expect(okRes.error).toBeUndefined();

      // Sleep for mtime granularity (1s on some filesystems), then rewrite.
      await new Promise<void>((r) => setTimeout(r, 1100));
      fs.writeFileSync(docPath, Buffer.from("EXTERNAL-EDIT-BY-OTHER-APP-MUCH-LONGER"));

      // Now finalize. The 1.1 s wait gave the staleness watcher time to
      // fire, so the freshness guard at handler entry typically catches
      // the divergence first. If it didn't (very fast machines, watcher
      // event still queued), the pre-rename stat-compare still aborts.
      // Either error message is correct user-visible behaviour.
      const part2 = Buffer.from("PART-2-FINAL");
      const finalRes = await callTool(client, "write_document_bytes", {
        offset: part1.length,
        byteCount: part2.length,
        dataBase64: part2.toString("base64"),
        isFinal: true,
        documentPath: docPath,
      });
      expectToolError(
        finalRes,
        /(changed during save|has changed since it was opened)/i,
      );

      // The destination still contains the external edit (we did not clobber).
      expect(fs.readFileSync(docPath).toString()).toBe(
        "EXTERNAL-EDIT-BY-OTHER-APP-MUCH-LONGER",
      );

      // The dirty flag was flipped, so the next operating tool also refuses.
      const opRes = await callTool(
        client,
        "read_document_information",
        {},
      );
      expectToolError(opRes, /has changed since it was opened/i);
    } finally {
      await closeDoc();
    }
  });

  it("watcher: external edit while idle flips the dirty flag and operating tools refuse", { timeout: 15000 }, async () => {
    const seed = Buffer.from("STABLE-SEED-1");
    const docPath = await freshDoc("watcher-stale.pdf", seed);
    try {
      await openDoc({ path: docPath });

      // Wait for mtime granularity, then mutate the file externally. The
      // server-side fs.watch + stat-compare should flip documentDirty.
      await new Promise<void>((r) => setTimeout(r, 1100));
      fs.writeFileSync(docPath, Buffer.from("EXTERNAL-EDIT-VALUE-LONGER-AND-DIFFERENT"));

      // Poll the staleness via an operating tool that checks
      // requireFreshDocument before any iframe enqueue. fs.watch latency on
      // macOS can take a few hundred ms; waitFor tolerates that.
      const flipped = await waitFor(async () => {
        const r = await callTool(
          client,
          "read_document_information",
          {},
        );
        return (
          r.error?.message?.match(/has changed since it was opened/i) !==
            null ||
          (r.result?.isError === true &&
            (r.result.content?.find((c) => c.type === "text")?.text ?? "").match(
              /has changed since it was opened/i,
            ) !== null)
        );
      });
      expect(flipped).toBe(true);
    } finally {
      await closeDoc();
    }
  });

  it("self-save preserves freshness: write → another write → no false staleness", { timeout: 15000 }, async () => {
    const seed = Buffer.from("ROUND-1");
    const docPath = await freshDoc("self-save.pdf", seed);
    try {
      await openDoc({ path: docPath });

      const v1 = Buffer.from("FIRST-SAVED-CONTENT");
      const r1 = await chunkedWrite(client, v1, docPath);
      expect(r1.error).toBeUndefined();
      expect(r1.result?.isError).not.toBe(true);
      expect(fs.readFileSync(docPath)).toEqual(v1);

      // Brief delay to let the watcher event from our own rename fire so
      // the isPendingSave suppression actually happens.
      await new Promise<void>((r) => setTimeout(r, 150));

      const v2 = Buffer.from("SECOND-SAVED-CONTENT-LONGER");
      const r2 = await chunkedWrite(client, v2, docPath);
      expect(r2.error).toBeUndefined();
      expect(r2.result?.isError).not.toBe(true);
      expect(fs.readFileSync(docPath)).toEqual(v2);
    } finally {
      await closeDoc();
    }
  });
});
