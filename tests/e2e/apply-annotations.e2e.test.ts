import { describe, it, expect } from "vitest";
import { withScenario, type ScenarioContext } from "./harness/scenario.js";
import { openAndWait } from "./harness/helpers.js";
import { CLA_PDF, FIXTURE_ROOTS, SAMPLE_PDF } from "./harness/fixtures.js";

async function createRedaction(
  ctx: ScenarioContext,
  pageIndex: number,
  sourceTerm: string,
  rect: { left: number; top: number; width: number; height: number } = {
    left: 40,
    top: 60,
    width: 120,
    height: 16
  }
): Promise<string> {
  const result = (await ctx.client.callTool("create_annotation", {
    annotation: {
      type: "redaction",
      pageIndex,
      rects: [rect],
      customData: { sourceTerm }
    }
  })) as { isError?: boolean; structuredContent?: { id?: string } };
  if (result.isError || !result.structuredContent?.id) {
    throw new Error(`create_annotation failed: ${JSON.stringify(result)}`);
  }
  return result.structuredContent.id;
}

interface ApplyResult {
  isError?: boolean;
  content?: Array<{ text: string }>;
  structuredContent?: {
    applied?: Array<{ id: string; type: string; pageIndex: number; sourceTerm?: string }>;
    userDeclined?: boolean;
    nothingToApply?: boolean;
    action?: string;
    viewUUID?: string;
  };
}

describe("apply_annotations with elicitation", () => {
  it("nothing-to-apply: returns nothingToApply=true and does not invoke elicitation", async () => {
    let elicitationCount = 0;
    await withScenario(
      {
        roots: FIXTURE_ROOTS,
        elicitation: () => {
          elicitationCount += 1;
          return { action: "accept", content: { confirm: true } };
        }
      },
      async (ctx) => {
        const pdfPath = await ctx.copyFixture(SAMPLE_PDF);
        await openAndWait(ctx, pdfPath);

        // Do not create any redactions. apply_annotations should short-circuit.
        const result = (await ctx.client.callTool("apply_annotations", {})) as ApplyResult;

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.nothingToApply).toBe(true);
        expect(result.structuredContent?.applied).toEqual([]);
        expect(elicitationCount).toBe(0);
      }
    );
  });

  it("accept: applies redactions and returns applied list", async () => {
    await withScenario(
      {
        roots: FIXTURE_ROOTS,
        elicitation: () => ({ action: "accept", content: { confirm: true } })
      },
      async (ctx) => {
        const pdfPath = await ctx.copyFixture(SAMPLE_PDF);
        await openAndWait(ctx, pdfPath);

        const id = await createRedaction(ctx, 0, "SSN");

        const result = (await ctx.client.callTool("apply_annotations", {})) as ApplyResult;

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.nothingToApply).toBeFalsy();
        expect(result.structuredContent?.userDeclined).toBeFalsy();
        const applied = result.structuredContent?.applied ?? [];
        expect(applied.length).toBeGreaterThan(0);
        expect(applied.some((a) => a.id === id)).toBe(true);
        expect(applied[0]?.sourceTerm).toBe("SSN");
      }
    );
  });

  it("decline: returns userDeclined=true and leaves the redaction in place", async () => {
    await withScenario(
      {
        roots: FIXTURE_ROOTS,
        elicitation: () => ({ action: "decline" })
      },
      async (ctx) => {
        const pdfPath = await ctx.copyFixture(SAMPLE_PDF);
        await openAndWait(ctx, pdfPath);

        const id = await createRedaction(ctx, 0, "EMAIL");

        const result = (await ctx.client.callTool("apply_annotations", {})) as ApplyResult;

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.userDeclined).toBe(true);
        expect(result.structuredContent?.applied).toEqual([]);
        expect(result.structuredContent?.action).toBe("decline");

        // Redaction still present on read-back by id
        const read = (await ctx.client.callTool("read_annotations", {
          pageIndex: 0
        })) as { structuredContent?: { annotations?: Array<{ id: string }> } };
        const ids = (read.structuredContent?.annotations ?? []).map((a) => a.id);
        expect(ids).toContain(id);
      }
    );
  });
});

describe("apply_annotations — multi-redaction across pages with audit metadata", () => {
  it("applies 2 redactions on different pages of the CLA, preserving sourceTerm on each entry", async () => {
    await withScenario(
      {
        roots: FIXTURE_ROOTS,
        elicitation: () => ({ action: "accept", content: { confirm: true } })
      },
      async (ctx) => {
        const pdfPath = await ctx.copyFixture(CLA_PDF);
        await openAndWait(ctx, pdfPath);

        // Two redactions on different pages of the CLA, each tagged with a
        // distinct sourceTerm. The rects don't need to cover real text for
        // this test — we're verifying the apply pipeline's audit metadata
        // round-trips correctly across multiple pages, not the SDK's
        // text-burning fidelity (covered indirectly by the single-page
        // accept test above).
        const idA = await createRedaction(ctx, 0, "TermA", {
          left: 60,
          top: 80,
          width: 140,
          height: 18
        });
        const idB = await createRedaction(ctx, 1, "TermB", {
          left: 60,
          top: 200,
          width: 140,
          height: 18
        });

        const result = (await ctx.client.callTool(
          "apply_annotations",
          {}
        )) as ApplyResult;

        expect(result.isError).toBeFalsy();
        const applied = result.structuredContent?.applied ?? [];
        expect(applied).toHaveLength(2);

        const byId = new Map(applied.map((a) => [a.id, a]));
        const a = byId.get(idA);
        const b = byId.get(idB);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a?.sourceTerm).toBe("TermA");
        expect(b?.sourceTerm).toBe("TermB");
        expect(a?.pageIndex).toBe(0);
        expect(b?.pageIndex).toBe(1);
      }
    );
  });
});
