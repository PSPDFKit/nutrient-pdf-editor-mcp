import { describe, it, expect } from "vitest";

// Pure base64 decoding helper extracted from main.ts for testing
function base64ToUint8Array(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("base64ToUint8Array", () => {
  it("decodes empty base64 string", () => {
    const result = base64ToUint8Array("");
    expect(result).toEqual(new Uint8Array([]));
  });

  it("decodes single character base64", () => {
    // "A" in base64 is 0x00 (one zero byte after decoding)
    const result = base64ToUint8Array("AA==");
    expect(result).toEqual(new Uint8Array([0]));
  });

  it("decodes simple ASCII text as base64", () => {
    // "hello" encoded as base64
    const b64 = Buffer.from("hello").toString("base64");
    const result = base64ToUint8Array(b64);
    const expected = new Uint8Array([104, 101, 108, 108, 111]); // ASCII codes for "hello"
    expect(result).toEqual(expected);
  });

  it("roundtrips: encode then decode", () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const encoded = Buffer.from(original).toString("base64");
    const decoded = base64ToUint8Array(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles binary data with null bytes", () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const encoded = Buffer.from(binary).toString("base64");
    const decoded = base64ToUint8Array(encoded);
    expect(decoded).toEqual(binary);
  });

  it("handles large binary data", () => {
    // Create a 1MB buffer with sequential bytes
    const size = 1024 * 1024;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      original[i] = (i % 256);
    }
    const encoded = Buffer.from(original).toString("base64");
    const decoded = base64ToUint8Array(encoded);
    expect(decoded.length).toBe(original.length);
    expect(decoded).toEqual(original);
  });

  it("handles PDF magic bytes", () => {
    // PDF files start with "%PDF"
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const encoded = Buffer.from(pdfMagic).toString("base64");
    const decoded = base64ToUint8Array(encoded);
    expect(decoded).toEqual(pdfMagic);
  });
});
