import { describe, it, expect } from "vitest";
import {
  streamBytesToServer,
  uint8ArrayToBase64,
  type ChunkedWriteSink,
} from "../../src/viewer/document-save.js";

interface RecordedCall {
  name: string;
  arguments: {
    offset: number;
    byteCount: number;
    dataBase64: string;
    isFinal: boolean;
    documentPath: string;
  };
}

const DOC_PATH = "/mnt/virtiofs/test.pdf";

function makeSink(
  responder: (call: RecordedCall) => unknown = () => ({
    structuredContent: { finalized: false },
  }),
): { sink: ChunkedWriteSink; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const sink: ChunkedWriteSink = {
    async callServerTool(args) {
      const recorded = args as RecordedCall;
      calls.push(recorded);
      return responder(recorded);
    },
  };
  return { sink, calls };
}

function reconstruct(calls: RecordedCall[]): Uint8Array {
  const total = calls.reduce((n, c) => n + c.arguments.byteCount, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const call of calls) {
    const decoded = Buffer.from(call.arguments.dataBase64, "base64");
    out.set(new Uint8Array(decoded), pos);
    pos += call.arguments.byteCount;
  }
  return out;
}

describe("streamBytesToServer", () => {
  it("sends a single chunk with isFinal=true for a small buffer", async () => {
    const { sink, calls } = makeSink();
    const bytes = new TextEncoder().encode("hello world");
    await streamBytesToServer(bytes, sink, DOC_PATH);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("write_document_bytes");
    expect(calls[0]!.arguments.offset).toBe(0);
    expect(calls[0]!.arguments.byteCount).toBe(bytes.length);
    expect(calls[0]!.arguments.isFinal).toBe(true);
    expect(reconstruct(calls)).toEqual(bytes);
  });

  it("sends one final empty chunk for a zero-byte buffer", async () => {
    const { sink, calls } = makeSink();
    await streamBytesToServer(new Uint8Array(0), sink, DOC_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments.byteCount).toBe(0);
    expect(calls[0]!.arguments.dataBase64).toBe("");
    expect(calls[0]!.arguments.isFinal).toBe(true);
  });

  it("splits a larger-than-chunk-size buffer and finalizes only on the last call", async () => {
    const { sink, calls } = makeSink();
    // 1.5 MiB exercises multi-chunk; CHUNK_SIZE is 512 KiB.
    const size = 1.5 * 1024 * 1024;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = i % 256;
    await streamBytesToServer(original, sink, DOC_PATH);

    expect(calls.length).toBeGreaterThan(1);
    // Only the last call may have isFinal=true
    for (let i = 0; i < calls.length - 1; i++) {
      expect(calls[i]!.arguments.isFinal).toBe(false);
    }
    expect(calls[calls.length - 1]!.arguments.isFinal).toBe(true);

    // Offsets are sequential and contiguous
    let expected = 0;
    for (const c of calls) {
      expect(c.arguments.offset).toBe(expected);
      expected += c.arguments.byteCount;
    }
    expect(expected).toBe(size);

    // Reconstructed bytes match the original
    expect(reconstruct(calls)).toEqual(original);
  });

  it("accepts an ArrayBuffer (not just Uint8Array) as input", async () => {
    const { sink, calls } = makeSink();
    const bytes = new TextEncoder().encode("from arraybuffer");
    await streamBytesToServer(bytes.buffer.slice(0), sink, DOC_PATH);
    expect(calls).toHaveLength(1);
    expect(reconstruct(calls)).toEqual(bytes);
  });

  it("propagates server errors as a thrown Error", async () => {
    const { sink } = makeSink((call) => {
      if (call.arguments.isFinal) {
        return {
          isError: true,
          content: [{ type: "text", text: "rename failed: EACCES" }],
        };
      }
      return { structuredContent: { finalized: false } };
    });
    await expect(
      streamBytesToServer(new TextEncoder().encode("hi"), sink, DOC_PATH),
    ).rejects.toThrow("rename failed: EACCES");
  });

  it("falls back to a generic message when an isError response has no text", async () => {
    const { sink } = makeSink(() => ({ isError: true }));
    await expect(
      streamBytesToServer(new TextEncoder().encode("hi"), sink, DOC_PATH),
    ).rejects.toThrow("write_document_bytes failed");
  });

  it("includes documentPath verbatim on every chunk (stream-binding for in-place SDK swap)", async () => {
    const { sink, calls } = makeSink();
    const size = 1.2 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    await streamBytesToServer(bytes, sink, DOC_PATH);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      // Each chunk carries the same captured path — the auto-save controller
      // captured it at setup, so it doesn't move under the stream even if
      // the iframe later swaps to a different document mid-flight.
      expect(call.arguments.documentPath).toBe(DOC_PATH);
    }
  });
});

describe("uint8ArrayToBase64", () => {
  it("encodes the empty array as empty string", () => {
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe("");
  });

  it("round-trips ASCII bytes", () => {
    const bytes = new TextEncoder().encode("Hello, world!");
    const b64 = uint8ArrayToBase64(bytes);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Hello, world!");
  });

  it("preserves binary bytes including null and 0xff", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
    const b64 = uint8ArrayToBase64(bytes);
    expect(new Uint8Array(Buffer.from(b64, "base64"))).toEqual(bytes);
  });

  it("encodes PDF magic bytes correctly", () => {
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    expect(uint8ArrayToBase64(pdfMagic)).toBe("JVBERg==");
  });
});
