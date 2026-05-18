import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import { openAndWait, type RawToolResult } from "./harness/helpers.js";
import { FIXTURE_ROOTS, SAMPLE_PDF } from "./harness/fixtures.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("read-only tool coverage — happy paths", () => {
  it("read_document_information returns the SDK's 8-key DocumentPermissions record end-to-end", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("read_document_information", {})) as {
        isError?: boolean;
        structuredContent?: {
          pageCount?: number;
          permissions?: Record<string, boolean>;
        };
      };

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.pageCount).toBe(3);

      const permissions = result.structuredContent?.permissions ?? {};
      const expectedKeys = [
        "annotationsAndForms",
        "assemble",
        "extract",
        "extractAccessibility",
        "fillForms",
        "modification",
        "printHighQuality",
        "printing"
      ];
      for (const key of expectedKeys) {
        expect(permissions).toHaveProperty(key);
        expect(typeof permissions[key]).toBe("boolean");
      }
      // sample.pdf is an unencrypted PDF with no restrictions; the SDK reports
      // all permissions as granted.
      for (const key of expectedKeys) {
        expect(permissions[key]).toBe(true);
      }
    });
  });

  it("read_page_info returns positive width/height for each page", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      for (const pageIndex of [0, 1, 2]) {
        const result = (await ctx.client.callTool("read_page_info", {
          pageIndex
        })) as {
          structuredContent?: { width?: number; height?: number; rotation?: number };
        };

        expect(result.structuredContent?.width).toBeGreaterThan(0);
        expect(result.structuredContent?.height).toBeGreaterThan(0);
        expect([0, 90, 180, 270]).toContain(result.structuredContent?.rotation);
      }
    });
  });

  it("get_page_image returns an MCP image content block with valid PNG bytes", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("get_page_image", {
        pageIndex: 0,
        width: 400
      })) as {
        content?: Array<
          | { type: "image"; data: string; mimeType: string }
          | { type: "text"; text: string }
        >;
        structuredContent?: Record<string, unknown>;
      };

      const imageBlock = result.content?.[0];
      expect(imageBlock?.type).toBe("image");
      if (imageBlock?.type !== "image") throw new Error("expected image block");
      expect(imageBlock.mimeType).toBe("image/png");
      expect(imageBlock.data).not.toMatch(/^data:/);
      const bytes = Buffer.from(imageBlock.data, "base64");
      expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);

      // pngDataUrl must not appear in structuredContent — that's what was
      // blowing past the host's per-tool-result token cap.
      expect(result.structuredContent).not.toHaveProperty("pngDataUrl");
    });
  });

  it("set_view_state navigates to a different page and get_view_state reflects it", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const before = (await ctx.client.callTool("get_view_state", {})) as {
        structuredContent?: { activePage?: number; pageCount?: number };
      };
      expect(before.structuredContent?.activePage).toBe(0);
      expect(before.structuredContent?.pageCount).toBe(3);

      const after = (await ctx.client.callTool("set_view_state", {
        activePage: 2
      })) as { structuredContent?: { activePage?: number } };
      expect(after.structuredContent?.activePage).toBe(2);

      const verify = (await ctx.client.callTool("get_view_state", {})) as {
        structuredContent?: { activePage?: number };
      };
      expect(verify.structuredContent?.activePage).toBe(2);
    });
  });

  it("search_exact_text finds a known string and returns zero hits for an absent one", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const found = (await ctx.client.callTool("search_exact_text", {
        query: "Page 2"
      })) as {
        structuredContent?: { hits?: Array<{ pageIndex: number; snippet?: string }> };
      };
      const hits = found.structuredContent?.hits ?? [];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.pageIndex === 1)).toBe(true);

      const missing = (await ctx.client.callTool("search_exact_text", {
        query: "ZZZ-NOT-IN-THIS-DOC-ZZZ"
      })) as { structuredContent?: { hits?: unknown[] } };
      expect(missing.structuredContent?.hits).toEqual([]);
    });
  });
});

describe("read_page_info — boundary errors", () => {
  it("pageIndex equal to pageCount returns isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("read_page_info", {
        pageIndex: 3 // sample.pdf has pages 0..2
      })) as RawToolResult;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(/out of range/i);
    });
  });

  it("negative pageIndex returns isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("read_page_info", {
        pageIndex: -1
      })) as RawToolResult;

      expect(result.isError).toBe(true);
    });
  });
});

describe("get_page_image — width and bounds", () => {
  it("renders at small width (100px) and reports renderedWidth correctly", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("get_page_image", {
        pageIndex: 0,
        width: 100
      })) as {
        content?: Array<{ type?: string; data?: string; mimeType?: string }>;
        structuredContent?: { renderedWidth?: number };
      };

      expect(result.structuredContent?.renderedWidth).toBe(100);
      const imageBlock = result.content?.[0];
      expect(imageBlock?.type).toBe("image");
      expect(imageBlock?.mimeType).toBe("image/png");
      const bytes = Buffer.from(imageBlock!.data!, "base64");
      expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    });
  });

  it(
    "renders at large width (4000px) without truncating or corrupting the PNG",
    async () => {
      await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
        await openAndWait(ctx, SAMPLE_PDF);

        const result = (await ctx.client.callTool("get_page_image", {
          pageIndex: 0,
          width: 4000
        })) as {
          content?: Array<{ type?: string; data?: string; mimeType?: string }>;
          structuredContent?: { renderedWidth?: number };
        };

        expect(result.structuredContent?.renderedWidth).toBe(4000);
        const imageBlock = result.content?.[0];
        expect(imageBlock?.type).toBe("image");
        // The 4000-pixel render is the case the chunked-base64 fix unblocked
        // — the PNG body crosses many 32 KiB boundaries. Verify the magic
        // is intact end-to-end.
        const bytes = Buffer.from(imageBlock!.data!, "base64");
        expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
        // Byte length scales with width; assert the buffer is non-trivial.
        expect(bytes.length).toBeGreaterThan(10_000);
      });
    },
    120_000
  );

  it("pageIndex past last page returns isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("get_page_image", {
        pageIndex: 99,
        width: 200
      })) as RawToolResult;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(/out of range/i);
    });
  });
});

describe("set_view_state — input validation", () => {
  it("rejects empty input (no activePage, scrollTo, or selection)", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool(
        "set_view_state",
        {}
      )) as RawToolResult;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(
        /requires at least one of/i
      );
    });
  });

  it("activePage at the last valid index succeeds", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("set_view_state", {
        activePage: 2 // sample.pdf has pages 0..2
      })) as { isError?: boolean; structuredContent?: { activePage?: number } };

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.activePage).toBe(2);
    });
  });
});

describe("search_exact_text — query and scope edges", () => {
  it("scoped to a page that contains the hit returns it", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const onPage1 = (await ctx.client.callTool("search_exact_text", {
        query: "Page 2",
        pageIndex: 1
      })) as { structuredContent?: { hits?: Array<{ pageIndex: number }> } };

      const hits = onPage1.structuredContent?.hits ?? [];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.pageIndex === 1)).toBe(true);
    });
  });

  it("scoped to a page that does NOT contain the hit returns []", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const onPage0 = (await ctx.client.callTool("search_exact_text", {
        query: "Page 2",
        pageIndex: 0
      })) as { structuredContent?: { hits?: unknown[] } };

      expect(onPage0.structuredContent?.hits).toEqual([]);
    });
  });

  it("pageIndex out of range returns isError: true", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("search_exact_text", {
        query: "Page 2",
        pageIndex: 99
      })) as RawToolResult;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(/out of range/i);
    });
  });
});
