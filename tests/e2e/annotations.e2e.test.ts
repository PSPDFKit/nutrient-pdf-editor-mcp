import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import {
  createAnnotation,
  deleteAnnotation,
  openAndWait,
  readAnnotations
} from "./harness/helpers.js";
import { FIXTURE_ROOTS, SAMPLE_PDF } from "./harness/fixtures.js";

describe("annotation CRUD", () => {
  it("highlight: create → read → update customData → delete", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "highlight",
        pageIndex: 0,
        rects: [{ left: 50, top: 50, width: 80, height: 14 }]
      });
      expect(id).toMatch(/\S+/);

      const onPage0 = await readAnnotations(ctx, { pageIndex: 0 });
      const created = onPage0.find((a) => a.id === id);
      expect(created).toBeDefined();
      expect(created?.type).toBe("highlight");
      expect(created?.pageIndex).toBe(0);
      expect(created?.rect.width).toBeGreaterThan(0);
      expect(created?.rect.height).toBeGreaterThan(0);

      // Filter by type round-trips
      const highlights = await readAnnotations(ctx, { type: "highlight" });
      expect(highlights.some((a) => a.id === id)).toBe(true);

      const updateRes = (await ctx.client.callTool("update_annotation", {
        id,
        patch: { customData: { note: "first-review" } }
      })) as { isError?: boolean; structuredContent?: { id?: string } };
      expect(updateRes.isError).toBeFalsy();
      expect(updateRes.structuredContent?.id).toBe(id);

      const afterUpdate = await readAnnotations(ctx, { pageIndex: 0 });
      const updated = afterUpdate.find((a) => a.id === id);
      expect(updated?.customData).toEqual({ note: "first-review" });

      const deleteRes = await deleteAnnotation(ctx, id);
      expect(deleteRes.isError).toBeFalsy();
      expect(deleteRes.structuredContent?.id).toBe(id);

      const afterDelete = await readAnnotations(ctx, { pageIndex: 0 });
      expect(afterDelete.some((a) => a.id === id)).toBe(false);
    });
  });

  it("redaction: create round-trips id and customData.sourceTerm", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "redaction",
        pageIndex: 1,
        rects: [{ left: 40, top: 60, width: 120, height: 16 }],
        customData: { sourceTerm: "SSN" }
      });

      const onPage1 = await readAnnotations(ctx, { pageIndex: 1 });
      const created = onPage1.find((a) => a.id === id);
      expect(created).toBeDefined();
      expect(created?.type).toBe("redaction");
      expect(created?.pageIndex).toBe(1);
      expect(created?.rect.width).toBeGreaterThan(0);
      expect(created?.customData).toEqual({ sourceTerm: "SSN" });

      // type filter isolates redactions
      const redactions = await readAnnotations(ctx, { type: "redaction" });
      expect(redactions.every((a) => a.type === "redaction")).toBe(true);
      expect(redactions.some((a) => a.id === id)).toBe(true);
    });
  });

  it("update_annotation returns an error for an unknown id", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const res = (await ctx.client.callTool("update_annotation", {
        id: "definitely-not-a-real-id",
        patch: { customData: { x: 1 } }
      })) as { isError?: boolean; content?: Array<{ text: string }> };

      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text ?? "").toMatch(/not found/i);
    });
  });
});
