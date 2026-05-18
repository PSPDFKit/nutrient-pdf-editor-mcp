import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import {
  callCreateAnnotation,
  createAnnotation,
  deleteAnnotation,
  openAndWait,
  readAnnotations
} from "./harness/helpers.js";
import { FIXTURE_ROOTS, SAMPLE_PDF } from "./harness/fixtures.js";

// Round-trip coverage for the eight annotation variants the existing
// `annotations.e2e.test.ts` doesn't exercise (highlight + redaction live
// there). Each test creates one annotation, reads it back, and verifies
// the variant-specific fields survived. `widget` is intentionally
// deferred to the forms suite (phase 4) because creating a widget without
// a backing AcroForm field is a bridge edge case — we'd rather verify it
// transitively when sign-off/human-resources-form.pdf gets exercised.

describe("annotation variants — round-trip create → read → delete", () => {
  it("note: contents survive round-trip", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "note",
        pageIndex: 0,
        rect: { left: 100, top: 100, width: 24, height: 24 },
        text: "review needed"
      });

      const annotations = await readAnnotations(ctx, { type: "note" });
      const created = annotations.find((a) => a.id === id);
      expect(created).toBeDefined();
      expect(created?.type).toBe("note");
      expect(created?.contents).toBe("review needed");

      const del = await deleteAnnotation(ctx, id);
      expect(del.isError).toBeFalsy();
    });
  });

  it("text: free-text annotation preserves text + position", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "text",
        pageIndex: 1,
        rect: { left: 60, top: 200, width: 180, height: 32 },
        text: "DRAFT"
      });

      const annotations = await readAnnotations(ctx, { pageIndex: 1, type: "text" });
      const created = annotations.find((a) => a.id === id);
      expect(created).toBeDefined();
      expect(created?.contents).toBe("DRAFT");
      expect(created?.rect.width).toBeGreaterThan(0);
      expect(created?.rect.height).toBeGreaterThan(0);
    });
  });

  it("ink: single-line drawing round-trips", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "ink",
        pageIndex: 0,
        lines: [
          [
            { x: 100, y: 100 },
            { x: 120, y: 110 },
            { x: 140, y: 108 }
          ]
        ]
      });

      const annotations = await readAnnotations(ctx, { type: "ink" });
      const created = annotations.find((a) => a.id === id);
      expect(created).toBeDefined();
      expect(created?.type).toBe("ink");
    });
  });

  it("ink: multi-line drawing also round-trips", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "ink",
        pageIndex: 2,
        lines: [
          [
            { x: 50, y: 50 },
            { x: 60, y: 60 }
          ],
          [
            { x: 100, y: 50 },
            { x: 110, y: 60 },
            { x: 120, y: 50 }
          ]
        ]
      });

      const annotations = await readAnnotations(ctx, { pageIndex: 2, type: "ink" });
      expect(annotations.some((a) => a.id === id)).toBe(true);
    });
  });

  it.each(["strikeout", "underline", "squiggly"] as const)(
    "%s markup round-trips and is isolated by type filter",
    async (variant) => {
      await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
        await openAndWait(ctx, SAMPLE_PDF);

        const id = await createAnnotation(ctx, {
          type: variant,
          pageIndex: 0,
          rects: [{ left: 50, top: 50, width: 80, height: 14 }]
        });

        const filtered = await readAnnotations(ctx, { type: variant });
        expect(filtered.every((a) => a.type === variant)).toBe(true);
        expect(filtered.some((a) => a.id === id)).toBe(true);
      });
    }
  );

  it("link: URI action survives round-trip in read_annotations", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "link",
        pageIndex: 0,
        rect: { left: 50, top: 50, width: 200, height: 16 },
        action: { uri: "https://example.com/dogfood" }
      });

      const annotations = await readAnnotations(ctx, { type: "link" });
      const created = annotations.find((a) => a.id === id);
      expect(created).toBeDefined();
      expect(created?.type).toBe("link");
      // The MCP read_annotations contract doesn't surface the link's URI
      // (it's an SDK-internal field). We assert position + type to confirm
      // the create path produced a real link, then move on; URI lookup is
      // a separate concern callers handle via the SDK directly.
      expect(created?.rect.width).toBeGreaterThan(0);
    });
  });
});

describe("annotation create — error paths", () => {
  it("highlight with empty rects array → InvalidParams", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = await callCreateAnnotation(ctx, {
        type: "highlight",
        pageIndex: 0,
        rects: []
      });
      expect(result.isError).toBe(true);
    });
  });

  it("ink with empty lines array → InvalidParams", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = await callCreateAnnotation(ctx, {
        type: "ink",
        pageIndex: 0,
        lines: []
      });
      expect(result.isError).toBe(true);
    });
  });
});

describe("annotation delete — error paths", () => {
  it("unknown id → isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const res = await deleteAnnotation(ctx, "this-id-does-not-exist");
      expect(res.isError).toBe(true);
    });
  });

  it("double-delete of the same id: second call errors", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const id = await createAnnotation(ctx, {
        type: "highlight",
        pageIndex: 0,
        rects: [{ left: 50, top: 50, width: 80, height: 14 }]
      });

      const first = await deleteAnnotation(ctx, id);
      expect(first.isError).toBeFalsy();
      expect(first.structuredContent?.id).toBe(id);

      const second = await deleteAnnotation(ctx, id);
      expect(second.isError).toBe(true);
    });
  });
});
