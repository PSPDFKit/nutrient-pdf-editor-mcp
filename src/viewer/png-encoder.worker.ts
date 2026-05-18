/**
 * png-encoder.worker.ts — Off-main-thread PNG encoder
 *
 * Receives RGBA pixel data as an ArrayBuffer transfer (zero-copy), encodes it
 * to PNG via OffscreenCanvas + putImageData + convertToBlob, then posts the
 * PNG bytes back as a transferable ArrayBuffer.
 *
 * The main thread spawns this worker once at module load time and routes all
 * `get_page_image` encode work through it, keeping the ~40–200ms blocking PNG
 * encode off the main JS thread so other MCP commands can be processed
 * concurrently.
 *
 * Protocol (both directions use structured-clone + transferables):
 *
 *   Main → Worker:
 *     { requestId: string, buffer: ArrayBuffer, width: number, height: number }
 *     Transfer list: [buffer]
 *
 *   Worker → Main (success):
 *     { requestId: string, pngBuffer: ArrayBuffer }
 *     Transfer list: [pngBuffer]
 *
 *   Worker → Main (error):
 *     { requestId: string, error: string }
 */

self.onmessage = async (
  e: MessageEvent<{ requestId: string; buffer: ArrayBuffer; width: number; height: number }>
) => {
  const { requestId, buffer, width, height } = e.data;
  try {
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("OffscreenCanvas is not available in this worker context");
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("png-encoder.worker: failed to get 2D context from OffscreenCanvas");
    }

    // buffer is raw RGBA pixel data transferred zero-copy from the main thread.
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    ctx.putImageData(imageData, 0, 0);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const pngBuffer = await blob.arrayBuffer();

    // Transfer the PNG buffer back zero-copy.
    (self as unknown as Worker).postMessage({ requestId, pngBuffer }, [pngBuffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      requestId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
};
