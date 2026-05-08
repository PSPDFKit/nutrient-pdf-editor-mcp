import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import { openAndWait } from "./harness/helpers.js";
import {
  FIXTURE_ROOTS,
  PAPERS_PDF,
  SAMPLE_PDF,
  UBER_10K_PDF
} from "./harness/fixtures.js";

interface ReadTextResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: {
    text?: string;
    pageCount?: number;
    firstPage?: number;
    lastPage?: number;
    extractedPages?: number;
    truncated?: boolean;
    nextPageStart?: number | null;
  };
}

async function readText(
  ctx: { client: { callTool: (n: string, a: Record<string, unknown>) => Promise<unknown> } },
  args: Record<string, unknown> = {}
): Promise<ReadTextResult> {
  return (await ctx.client.callTool("read_text", args)) as ReadTextResult;
}

describe("read_text happy paths", () => {
  it("default args (no pageStart/pageEnd) extracts the full document on a small PDF", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = await readText(ctx);

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent;
      expect(sc?.firstPage).toBe(0);
      expect(sc?.lastPage).toBe(2); // sample.pdf has 3 pages
      expect(sc?.extractedPages).toBe(3);
      expect(sc?.pageCount).toBe(3);
      expect(sc?.truncated).toBe(false);
      expect(sc?.nextPageStart).toBeNull();
      // The text should at least include the page-2 marker we know is there
      // (search test in read-only.e2e.test.ts also depends on this string).
      expect(sc?.text ?? "").toContain("Page 2");
    });
  });

  it("single-page slice (pageStart=0, pageEnd=0) returns only page 0 text", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, PAPERS_PDF);

      const all = await readText(ctx);
      const first = await readText(ctx, { pageStart: 0, pageEnd: 0 });

      expect(first.structuredContent?.firstPage).toBe(0);
      expect(first.structuredContent?.lastPage).toBe(0);
      expect(first.structuredContent?.extractedPages).toBe(1);
      expect(first.structuredContent?.truncated).toBe(false);

      const fullText = all.structuredContent?.text ?? "";
      const firstText = first.structuredContent?.text ?? "";
      // Single-page slice text must be a strict subset of full-doc text.
      expect(fullText.length).toBeGreaterThan(firstText.length);
      expect(fullText).toContain(firstText);
    });
  });

  it("omitting pageEnd defaults to the last page", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      // pageEnd = -1 is the server↔viewer sentinel for "last page". The
      // tool schema rejects negatives at the zod boundary, so the way a
      // caller asks for "to the end" is to omit pageEnd. Confirms the
      // server-side default kicks in correctly.
      const result = await readText(ctx, { pageStart: 0 });
      expect(result.structuredContent?.lastPage).toBe(2);
      expect(result.structuredContent?.extractedPages).toBe(3);
    });
  });
});

describe("read_text pagination", () => {
  it(
    "uber 10-K: default call paginates; nextPageStart advances and eventually settles",
    async () => {
      await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
        await openAndWait(ctx, UBER_10K_PDF);

        // First call. With ~307 pages and a 100K-char cap, this is
        // overwhelmingly likely to truncate.
        const first = await readText(ctx);
        expect(first.isError).toBeFalsy();
        const firstSc = first.structuredContent;
        expect(firstSc?.firstPage).toBe(0);
        expect(firstSc?.truncated).toBe(true);
        expect(firstSc?.nextPageStart).toBeGreaterThan(0);
        expect(firstSc?.pageCount).toBeGreaterThan(50);

        // Second call: continue from nextPageStart. Must advance past the
        // first call's lastPage and either truncate again or finish cleanly.
        const cursor = firstSc!.nextPageStart!;
        const second = await readText(ctx, { pageStart: cursor });
        expect(second.isError).toBeFalsy();
        const secondSc = second.structuredContent;
        expect(secondSc?.firstPage).toBe(cursor);
        expect(secondSc?.lastPage).toBeGreaterThanOrEqual(cursor);
        // Either we're still truncating (more to come, cursor advances) or
        // we've finished (lastPage hits pageCount-1 and nextPageStart is null).
        if (secondSc?.truncated) {
          expect(secondSc?.nextPageStart).toBeGreaterThan(cursor);
        } else {
          expect(secondSc?.nextPageStart).toBeNull();
          expect(secondSc?.lastPage).toBe((secondSc?.pageCount ?? 0) - 1);
        }
      });
    },
    180_000 // 10-K render is heavy; allow more headroom than the default 60s.
  );
});

describe("read_text validation errors", () => {
  it("pageStart out of range returns isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = await readText(ctx, { pageStart: 9999 });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(/out of range/i);
    });
  });

  it("inverted range (pageStart > pageEnd) returns isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = await readText(ctx, { pageStart: 2, pageEnd: 0 });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(/invalid page range/i);
    });
  });
});
