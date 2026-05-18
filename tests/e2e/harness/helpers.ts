import type { Page } from "playwright";
import type { ScenarioContext } from "./scenario.js";

/**
 * Seed the viewer (primes `viewUUID` via an idempotent pre-open
 * `close_document`) and open a document. Every test that exercises an
 * operating tool must run this before doing so: `seedViewer` is what wires
 * `viewUUID` into the iframe so the bridge can route subsequent commands.
 *
 * Throws if `open_document` returns without echoing the input path — that
 * signals a path-guard rejection or a bridge regression and we'd rather fail
 * loudly here than at the next tool call with an opaque "no document" error.
 */
export async function openDocument(
  ctx: ScenarioContext,
  absolutePath: string
): Promise<void> {
  await ctx.seedViewer();
  const result = (await ctx.client.callTool("open_document", {
    path: absolutePath
  })) as { isError?: boolean; structuredContent?: { documentPath?: string } };
  if (result.isError || result.structuredContent?.documentPath !== absolutePath) {
    throw new Error(
      `open_document did not echo the input path; got ${JSON.stringify(result)}`
    );
  }
}

/**
 * Block until the viewer's SDK instance has mounted.
 *
 * `open_document` returns synchronously after path validation; the iframe
 * loads the SDK asynchronously. Operating tools (read/write/search/...) all
 * fan out through the SDK, so they will hang or error if called before this
 * resolves. Tests should await this between `openDocument` and the first
 * operating tool call.
 */
export async function waitForViewerInstance(
  page: Page,
  timeoutMs = 10_000
): Promise<void> {
  await page.waitForFunction(
    () => {
      const getter = (window as unknown as {
        __e2eGetInstance?: () => unknown;
      }).__e2eGetInstance;
      return typeof getter === "function" && getter() != null;
    },
    { timeout: timeoutMs }
  );
}

/**
 * Convenience: open a document and wait for the SDK instance in one call.
 * Most tests want both; only document-lifecycle tests that intentionally
 * inspect the half-mounted state should skip this.
 */
export async function openAndWait(
  ctx: ScenarioContext,
  absolutePath: string,
  timeoutMs = 10_000
): Promise<void> {
  await openDocument(ctx, absolutePath);
  await waitForViewerInstance(ctx.page, timeoutMs);
}

/**
 * Plain-JSON shape that `read_annotations` returns. Mirrors the
 * `Annotation` interface declared in `src/mcp/tools/annotation-types.ts`
 * but kept local so test files don't reach across the test/source boundary.
 */
export interface AnnotationRecord {
  id: string;
  type: string;
  pageIndex: number;
  rect: { left: number; top: number; width: number; height: number };
  contents?: string;
  customData?: Record<string, unknown>;
}

/**
 * Generic CallToolResult shape — convenient for negative tests where the
 * caller wants to inspect `isError` and `content[0].text` itself.
 */
export interface RawToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Create an annotation via `create_annotation` and
 * return the new id. Throws if the call errored — use `callCreateAnnotation`
 * for the raw result.
 */
export async function createAnnotation(
  ctx: ScenarioContext,
  input: Record<string, unknown>
): Promise<string> {
  const result = await callCreateAnnotation(ctx, input);
  if (result.isError || typeof result.structuredContent?.id !== "string") {
    throw new Error(`create_annotation failed: ${JSON.stringify(result)}`);
  }
  return result.structuredContent.id;
}

/**
 * Same as `createAnnotation` but returns the raw `CallToolResult`. Use
 * when the test intentionally probes an error path (zod rejection,
 * `isError: true`, etc.).
 */
export async function callCreateAnnotation(
  ctx: ScenarioContext,
  input: Record<string, unknown>
): Promise<RawToolResult> {
  return (await ctx.client.callTool("create_annotation", {
    annotation: input
  })) as RawToolResult;
}

/**
 * Read annotations from the open document. Optional `pageIndex` and
 * `type` map onto the tool's filter args.
 */
export async function readAnnotations(
  ctx: ScenarioContext,
  filter: { pageIndex?: number; type?: string } = {}
): Promise<AnnotationRecord[]> {
  const args: Record<string, unknown> = {};
  if (filter.pageIndex !== undefined) args.pageIndex = filter.pageIndex;
  if (filter.type !== undefined) args.type = filter.type;
  const result = (await ctx.client.callTool("read_annotations", args)) as {
    structuredContent?: { annotations?: AnnotationRecord[] };
  };
  return result.structuredContent?.annotations ?? [];
}

/**
 * Delete an annotation. Returns the raw `CallToolResult` so negative tests
 * (unknown id, double-delete) can assert `isError`.
 */
export async function deleteAnnotation(
  ctx: ScenarioContext,
  id: string
): Promise<RawToolResult> {
  return (await ctx.client.callTool("delete_annotation", {
    id
  })) as RawToolResult;
}
