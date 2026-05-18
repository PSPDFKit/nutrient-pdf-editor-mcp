import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import { openAndWait, openDocument, waitForViewerInstance } from "./harness/helpers.js";
import { FIXTURE_ROOTS, PAPERS_PDF, SAMPLE_PDF } from "./harness/fixtures.js";

interface ViewState {
  documentPath?: string;
  pageCount?: number;
  activePage?: number;
}

interface CloseResult {
  isError?: boolean;
  structuredContent?: { closed?: boolean };
}

async function getViewState(
  ctx: { client: { callTool: (n: string, a: Record<string, unknown>) => Promise<unknown> } }
): Promise<ViewState> {
  const result = (await ctx.client.callTool("get_view_state", {})) as {
    structuredContent?: ViewState;
  };
  return result.structuredContent ?? {};
}

describe("close_document idempotency", () => {
  it("returns {closed: true} when called pre-open (no document yet)", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await ctx.seedViewer();
      const result = (await ctx.client.callTool(
        "close_document",
        {}
      )) as CloseResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.closed).toBe(true);
    });
  });

  it("close → close again returns {closed: true} both times", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const first = (await ctx.client.callTool(
        "close_document",
        {}
      )) as CloseResult;
      expect(first.structuredContent?.closed).toBe(true);

      const second = (await ctx.client.callTool(
        "close_document",
        {}
      )) as CloseResult;
      expect(second.structuredContent?.closed).toBe(true);
    });
  });

  it("close → reopen restores tool functionality", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const closeRes = (await ctx.client.callTool(
        "close_document",
        {}
      )) as CloseResult;
      expect(closeRes.structuredContent?.closed).toBe(true);

      // Re-open the same document. The viewer instance is gone after close,
      // so we need to wait for SDK mount again.
      await openDocument(ctx, SAMPLE_PDF);
      await waitForViewerInstance(ctx.page);

      const view = await getViewState(ctx);
      expect(view.pageCount).toBe(3);
      expect(view.documentPath).toBe(SAMPLE_PDF);
    });
  });
});

describe("in-place document swap", () => {
  it("open A → open B without close: pageCount and documentPath reflect B", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const viewA = await getViewState(ctx);
      expect(viewA.documentPath).toBe(SAMPLE_PDF);
      expect(viewA.pageCount).toBe(3);

      // Open B without closing A. The viewer atomically swaps the SDK
      // instance once SDK.load resolves; openDocument helper does not wait
      // for the swap, so we poll get_view_state until documentPath flips.
      // The 15s deadline covers WASM load + render of a 9-page PDF; on a
      // warm machine this completes well under 5s.
      await openDocument(ctx, PAPERS_PDF);

      let viewB: ViewState = {};
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        viewB = await getViewState(ctx);
        if (viewB.documentPath === PAPERS_PDF) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(viewB.documentPath).toBe(PAPERS_PDF);
      expect(viewB.pageCount).toBeGreaterThan(3); // PAPERS_PDF has > 3 pages
    });
  });

  it("re-opening the same path stays functional (resets watcher cleanly)", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      // Re-open the SAME path. The server's broadcast-close clears local
      // viewer state (including currentDocumentPath) and the subsequent
      // ontoolresult re-runs openDocumentFromPath. Wait for the SDK to
      // re-mount before issuing operating tools.
      await openDocument(ctx, SAMPLE_PDF);
      await waitForViewerInstance(ctx.page);

      const view = await getViewState(ctx);
      expect(view.documentPath).toBe(SAMPLE_PDF);
      expect(view.pageCount).toBe(3);
    });
  });
});

describe("viewUUID stability", () => {
  it("get_view_state returns the active session viewUUID after open_document", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const view = (await ctx.client.callTool(
        "get_view_state",
        {}
      )) as { _meta?: { viewUUID?: string }; structuredContent?: { viewUUID?: string } };
      const viewUuidFromContent = view.structuredContent?.viewUUID;
      expect(viewUuidFromContent).toMatch(/^[0-9a-f-]{36}$/);
      expect(view._meta?.viewUUID).toBe(viewUuidFromContent);
    });
  });
});
