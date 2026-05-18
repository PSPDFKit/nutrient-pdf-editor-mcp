import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { registerCreateAnnotationTool } from "../../src/mcp/tools/create-annotation.js";
import { registerReadAnnotationsTool } from "../../src/mcp/tools/read-annotations.js";
import { registerUpdateAnnotationTool } from "../../src/mcp/tools/update-annotation.js";
import { registerDeleteAnnotationTool } from "../../src/mcp/tools/delete-annotation.js";
import { assertPlainJson } from "../helpers/assertPlainJson.js";
import { flushMicrotasks } from "../helpers/mcpTestClient.js";
import { createSessionFixture, type SessionFixture } from "../helpers/sessionFixture.js";

describe("annotation CRUD tools (AC3.*)", () => {
  let fixture: SessionFixture;

  beforeEach(async () => {
    fixture = await createSessionFixture([
      registerCreateAnnotationTool,
      registerReadAnnotationsTool,
      registerUpdateAnnotationTool,
      registerDeleteAnnotationTool
    ]);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("AC3.1: create_annotation succeeds for all 10 types", () => {
    const types = [
      {
        type: "highlight",
        input: {
          type: "highlight",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: 100, height: 15 }]
        }
      },
      {
        type: "note",
        input: {
          type: "note",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          text: "note content"
        }
      },
      {
        type: "text",
        input: {
          type: "text",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          text: "free text"
        }
      },
      {
        type: "ink",
        input: {
          type: "ink",
          pageIndex: 0,
          lines: [
            [
              { x: 10, y: 20 },
              { x: 30, y: 40 }
            ]
          ]
        }
      },
      {
        type: "strikeout",
        input: {
          type: "strikeout",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: 100, height: 15 }]
        }
      },
      {
        type: "underline",
        input: {
          type: "underline",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: 100, height: 15 }]
        }
      },
      {
        type: "squiggly",
        input: {
          type: "squiggly",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: 100, height: 15 }]
        }
      },
      {
        type: "link",
        input: {
          type: "link",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          action: { uri: "https://example.com" }
        }
      },
      {
        type: "widget",
        input: {
          type: "widget",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          formFieldName: "field1"
        }
      },
      {
        type: "redaction",
        input: {
          type: "redaction",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: 100, height: 15 }]
        }
      }
    ];

    for (const { type, input } of types) {
      it(`creates ${type} annotation`, async () => {
        const { callTool } = fixture;
        const { viewUUID: sessionUUID } = sessionModule.getSession();

        const resultPromise = callTool("create_annotation", {
          annotation: input
        });

        await flushMicrotasks();

        const commands = sessionModule.drain();
        expect(commands.length).toBe(1);
        expect(commands[0]!.type).toBe("create_annotation");
        const requestId = (commands[0]! as any).requestId;

        // Simulate viewer successfully creating annotation
        const annotationId = `ann-${type}`;
        // The viewer reports the post-create InstantJSON snapshot so the
        // agent can see SDK-side defaulting without a follow-up read.
        const annotationSnapshot = {
          v: 1,
          type: `pspdfkit/${type}`,
          id: annotationId,
          pageIndex: 0
        };
        sessionModule.resolvePending(requestId, {
          id: annotationId,
          annotation: annotationSnapshot
        });

        const result = await resultPromise;

        // Verify response structure
        expect(result).toHaveProperty("structuredContent");
        expect(result.structuredContent).toEqual({
          id: annotationId,
          annotation: annotationSnapshot,
          viewUUID: sessionUUID
        });

        // AC9.1: Verify response is plain JSON (no Immutable collections)
        assertPlainJson(result.structuredContent);
      });
    }
  });

  describe("AC3.2: created ids round-trip through update/delete", () => {
    it("create → update → delete sequence", async () => {
      const { callTool } = fixture;

      // Step 1: Create annotation
      const createPromise = callTool("create_annotation", {
        annotation: {
          type: "highlight",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: 100, height: 15 }]
        }
      });

      await flushMicrotasks();
      let commands = sessionModule.drain();
      const createRequestId = (commands[0]! as any).requestId;
      const annotationId = "ann-highlight-1";
      sessionModule.resolvePending(createRequestId, { id: annotationId });

      const createResult = await createPromise;
      expect((createResult.structuredContent as any).id).toBe(annotationId);

      // Step 2: Update with same id
      const updatePromise = callTool("update_annotation", {
        id: annotationId,
        patch: { text: { format: "plain", value: "updated" } }
      });

      await flushMicrotasks();
      commands = sessionModule.drain();
      const updateRequestId = (commands[0]! as any).requestId;
      expect((commands[0]! as any).id).toBe(annotationId);
      sessionModule.resolvePending(updateRequestId, { id: annotationId });

      const updateResult = await updatePromise;
      expect((updateResult.structuredContent as any).id).toBe(annotationId);

      // Step 3: Delete with same id
      const deletePromise = callTool("delete_annotation", {
        id: annotationId
      });

      await flushMicrotasks();
      commands = sessionModule.drain();
      const deleteRequestId = (commands[0]! as any).requestId;
      expect((commands[0]! as any).id).toBe(annotationId);
      sessionModule.resolvePending(deleteRequestId, { id: annotationId });

      const deleteResult = await deletePromise;
      expect((deleteResult.structuredContent as any).id).toBe(annotationId);
    });
  });

  describe("AC3.3: read_annotations returns plain JSON array", () => {
    it("returns annotations with plain JSON structure (no Immutable.List)", async () => {
      const { callTool } = fixture;
      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("read_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_annotations");
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer returning plain array
      sessionModule.resolvePending(requestId, {
        annotations: [
          {
            id: "a1",
            type: "highlight",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 15 },
            contents: "highlighted text"
          },
          {
            id: "a2",
            type: "note",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 20 },
            contents: "my note"
          }
        ]
      });

      const result = await resultPromise;

      expect(result.structuredContent).toEqual({
        annotations: [
          {
            id: "a1",
            type: "highlight",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 15 },
            contents: "highlighted text"
          },
          {
            id: "a2",
            type: "note",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 20 },
            contents: "my note"
          }
        ],
        viewUUID: sessionUUID
      });

      // content[0].text is now markdown — assert key human-readable signals.
      const contentText = (result.content[0] as any).text as string;
      expect(contentText).toContain("# Annotations");
      expect(contentText).toContain("## Annotation a1");
      expect(contentText).toContain("## Annotation a2");
      expect(contentText).toContain("highlighted text");
    });
  });

  describe("AC3.4: read_annotations filters by pageIndex and type", () => {
    it("filters by pageIndex only", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_annotations", { pageIndex: 1 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect((commands[0]! as any).pageIndex).toBe(1);
      expect((commands[0]! as any).annotationType).toBeUndefined();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        annotations: [
          {
            id: "a2",
            type: "note",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 20 },
            contents: "on page 1"
          }
        ]
      });

      const result = await resultPromise;
      const annotations = (result.structuredContent as any).annotations;
      expect(annotations.length).toBe(1);
      expect(annotations[0]!.pageIndex).toBe(1);
    });

    it("filters by type only", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_annotations", { type: "highlight" });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect((commands[0]! as any).annotationType).toBe("highlight");
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        annotations: [
          {
            id: "a1",
            type: "highlight",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 15 },
            contents: "highlight text"
          }
        ]
      });

      const result = await resultPromise;
      const annotations = (result.structuredContent as any).annotations;
      expect(annotations.length).toBe(1);
      expect(annotations[0]!.type).toBe("highlight");
    });

    it("filters by both pageIndex and type", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_annotations", {
        pageIndex: 2,
        type: "note"
      });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect((commands[0]! as any).pageIndex).toBe(2);
      expect((commands[0]! as any).annotationType).toBe("note");
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        annotations: [
          {
            id: "a5",
            type: "note",
            pageIndex: 2,
            rect: { left: 100, top: 150, width: 60, height: 25 },
            contents: "on page 2"
          }
        ]
      });

      const result = await resultPromise;
      const annotations = (result.structuredContent as any).annotations;
      expect(annotations.length).toBe(1);
      expect(annotations[0]!.pageIndex).toBe(2);
      expect(annotations[0]!.type).toBe("note");
    });
  });

  describe("AC3.5: update_annotation applies patch successfully", () => {
    it("updates annotation with patch", async () => {
      const { callTool } = fixture;
      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("update_annotation", {
        id: "ann-123",
        patch: { text: { format: "plain", value: "updated note" } }
      });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect((commands[0]! as any).id).toBe("ann-123");
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        id: "ann-123",
        annotation: { v: 1, type: "pspdfkit/markup/highlight", id: "ann-123", pageIndex: 0 }
      });

      const result = await resultPromise;

      // structuredContent now carries the post-update InstantJSON snapshot.
      expect((result.structuredContent as any).id).toBe("ann-123");
      expect((result.structuredContent as any).annotation).toEqual({
        v: 1,
        type: "pspdfkit/markup/highlight",
        id: "ann-123",
        pageIndex: 0
      });
      expect((result.structuredContent as any).viewUUID).toBe(sessionUUID);
    });
  });

  describe("AC3.6: delete_annotation removes annotation", () => {
    it("deletes annotation by id", async () => {
      const { callTool } = fixture;
      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("delete_annotation", { id: "ann-456" });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect((commands[0]! as any).id).toBe("ann-456");
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        id: "ann-456",
        annotation: { v: 1, type: "pspdfkit/note", id: "ann-456", pageIndex: 0 }
      });

      const result = await resultPromise;

      // structuredContent now carries the pre-delete snapshot of the
      // annotation that was just removed — the agent's record of what it lost.
      expect((result.structuredContent as any).id).toBe("ann-456");
      expect((result.structuredContent as any).annotation).toEqual({
        v: 1,
        type: "pspdfkit/note",
        id: "ann-456",
        pageIndex: 0
      });
      expect((result.structuredContent as any).viewUUID).toBe(sessionUUID);
    });

    it("deletes redaction annotations (removes mark without applying)", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("delete_annotation", {
        id: "redaction-789"
      });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, { id: "redaction-789" });

      const result = await resultPromise;
      expect((result.structuredContent as any).id).toBe("redaction-789");
    });
  });

  describe("AC3.7: update/delete with unknown id returns not-found error", () => {
    it("update_annotation with unknown id → isError with 'not found' message", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("update_annotation", {
        id: "nonexistent-id",
        patch: { text: "new" }
      });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer responding with not-found error
      sessionModule.resolvePending(requestId, {
        error: "Annotation not found: nonexistent-id"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });

    it("delete_annotation with unknown id → isError with 'not found' message", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("delete_annotation", { id: "bad-id" });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer responding with not-found error
      sessionModule.resolvePending(requestId, {
        error: "Annotation not found: bad-id"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("AC3.8: create_annotation validation errors", () => {
    it("zod validation error: missing required field → isError result", async () => {
      const { callTool } = fixture;

      // Missing 'rects' for highlight type — caught by SDK input validation
      const result = await callTool("create_annotation", {
        annotation: {
          type: "highlight",
          pageIndex: 0
          // rects is missing
        }
      });

      expect(result.isError).toBe(true);
      // SDK validates input schema before calling handler; error message includes "rects"
      expect((result.content[0] as any).text).toContain("rects");
    });

    it("SDK validation error: bad rect → isError result", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("create_annotation", {
        annotation: {
          type: "highlight",
          pageIndex: 0,
          rects: [{ left: 10, top: 20, width: -100, height: 15 }] // negative width
        }
      });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      // Simulate SDK validation error from viewer
      sessionModule.resolvePending(requestId, {
        error: "SDK validation: invalid rect dimensions"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("SDK validation");
    });
  });

  describe("AC3.*: error handling for document-not-open", () => {
    it("read_annotations with no document → isError result", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, { error: "Document not open" });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Document not open");
    });

    it("update_annotation with no document → isError result", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("update_annotation", {
        id: "any-id",
        patch: {}
      });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, { error: "Document not open" });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Document not open");
    });

    it("delete_annotation with no document → isError result", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("delete_annotation", { id: "any-id" });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, { error: "Document not open" });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Document not open");
    });
  });
});
