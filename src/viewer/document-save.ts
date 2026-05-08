/**
 * Chunked write-back of an exported PDF buffer to the MCP server's
 * `write_document_bytes` internal tool. Mirror of the read-side
 * `fetchDocumentBytes` flow in `main.ts`, in the opposite direction.
 *
 * Pure (no module-level state); all environmental dependencies pass through
 * the `sink` parameter so it is unit-testable without an iframe.
 *
 * The destination path is server-controlled (read from the session at
 * write time). Each chunk also carries `documentPath` — the path the
 * caller captured when the save started — so the server can refuse the
 * stream if the session's open document changed under us mid-save (an
 * in-place SDK swap to a different document). Without that guard, a
 * save against the prior document would silently overwrite the
 * freshly-opened new document. See
 * `docs/document-lifecycle.md` § "In-flight save during in-place SDK
 * swap" for the full rationale.
 */

export interface ChunkedWriteSink {
  callServerTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

interface ServerToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

const CHUNK_SIZE = 512 * 1024;

export async function streamBytesToServer(
  bytes: Uint8Array | ArrayBuffer,
  sink: ChunkedWriteSink,
  documentPath: string
): Promise<void> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (u8.length === 0) {
    await sendChunk(sink, 0, new Uint8Array(0), true, documentPath);
    return;
  }

  let offset = 0;
  while (offset < u8.length) {
    const end = Math.min(offset + CHUNK_SIZE, u8.length);
    const chunk = u8.subarray(offset, end);
    const isFinal = end === u8.length;
    await sendChunk(sink, offset, chunk, isFinal, documentPath);
    offset = end;
  }
}

async function sendChunk(
  sink: ChunkedWriteSink,
  offset: number,
  chunk: Uint8Array,
  isFinal: boolean,
  documentPath: string
): Promise<void> {
  const dataBase64 = uint8ArrayToBase64(chunk);
  const res = (await sink.callServerTool({
    name: "write_document_bytes",
    arguments: {
      offset,
      byteCount: chunk.length,
      dataBase64,
      isFinal,
      documentPath
    }
  })) as ServerToolResult;
  if (res.isError) {
    const text = res.content?.find((c) => c.type === "text")?.text;
    throw new Error(text ?? "write_document_bytes failed");
  }
}

export function uint8ArrayToBase64(u8: Uint8Array): string {
  // Browser-safe base64 encoding without TextDecoder. For very large buffers
  // (many MiB) String.fromCharCode(...u8) blows the call stack; we already
  // chunk to <=512 KiB so the simple per-byte loop is fine.
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}
