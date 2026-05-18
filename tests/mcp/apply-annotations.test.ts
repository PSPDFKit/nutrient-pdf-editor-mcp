import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { registerApplyAnnotationsTool } from "../../src/mcp/tools/apply-annotations.js";
import { flushMicrotasks } from "../helpers/mcpTestClient.js";
import { createSessionFixture, type SessionFixture } from "../helpers/sessionFixture.js";

describe("apply_annotations tool (AC4.*)", () => {
  let fixture: SessionFixture;

  beforeEach(async () => {
    fixture = await createSessionFixture([registerApplyAnnotationsTool], {
      extraCapabilities: { elicitation: {} }
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("AC4.4: nothing-to-apply path", () => {
    it("returns nothingToApply:true when no redactions exist, without calling elicit", async () => {
      const { server, callTool } = fixture;

      // Install a spy to verify elicitInput is not called
      const mockElicitInput = vi.fn();
      vi.spyOn(server.server, "elicitInput").mockImplementation(mockElicitInput);

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_annotations");
      expect((commands[0]! as any).annotationType).toBe("redaction");
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate viewer returning empty redactions array
      sessionModule.resolvePending(readRequestId, { annotations: [] });

      const result = await resultPromise;

      // Verify response structure for nothing-to-apply
      expect(result).toHaveProperty("structuredContent");
      expect(result.structuredContent).toEqual({
        applied: [],
        nothingToApply: true,
        viewUUID: expect.any(String)
      });
      expect(result.content).toEqual([{ type: "text", text: "Nothing to apply." }]);

      // Verify elicitInput was not called
      expect(mockElicitInput).not.toHaveBeenCalled();
    });
  });

  describe("AC4.1: elicitation prompt", () => {
    it("calls elicit with a message summarizing pending redactions", async () => {
      const { server, callTool } = fixture;

      // Advertise client elicitation capability — required to take the
      // host-rendered confirm path.
      (server as any).server._clientCapabilities = { elicitation: {} };

      // Mock the underlying Server's elicitInput method
      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "accept",
        content: { confirm: true }
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate viewer returning one redaction
      const redaction = {
        id: "ann-red-1",
        type: "redaction",
        pageIndex: 0,
        rect: { left: 10, top: 20, width: 100, height: 30 },
        customData: { sourceTerm: "SSN" }
      };
      sessionModule.resolvePending(readRequestId, { annotations: [redaction] });

      await flushMicrotasks();

      // Verify elicit was called with the correct message
      const callArgs = mockElicitInput.mock.calls[0]![0]! as any;
      expect(callArgs.message).toContain("About to permanently redact 1 area(s)");
      expect(callArgs.message).toContain("page 1");
      expect(callArgs.message).toContain('rect (10,20) 100×30 — "SSN"');
      expect(callArgs.requestedSchema).toEqual({
        type: "object",
        properties: {
          confirm: { type: "boolean", description: expect.any(String) }
        },
        required: ["confirm"]
      });

      // Drain and resolve the apply_redactions_now command so the promise completes
      await flushMicrotasks();
      const applyCommands = sessionModule.drain();
      if (applyCommands.length > 0) {
        sessionModule.resolvePending((applyCommands[0]! as any).requestId, { ok: true });
      }
      await resultPromise;
    });
  });

  describe("AC4.3: decline/cancel paths", () => {
    it("returns userDeclined:true with action:decline when user declines", async () => {
      const { server, callTool } = fixture;

      (server as any).server._clientCapabilities = { elicitation: {} };

      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "decline",
        content: { confirm: false }
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate one redaction
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-1",
            type: "redaction",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 30 }
          }
        ]
      });

      const result = await resultPromise;

      // Verify decline path
      expect(result.structuredContent).toEqual({
        applied: [],
        userDeclined: true,
        action: "decline",
        viewUUID: expect.any(String)
      });
      expect(result.content).toEqual([{ type: "text", text: "User declined apply" }]);

      // Verify no apply_redactions_now command was enqueued
      const finalCommands = sessionModule.drain();
      expect(finalCommands).toHaveLength(0);
    });

    it("returns userDeclined:true with action:cancel when user cancels", async () => {
      const { server, callTool } = fixture;

      (server as any).server._clientCapabilities = { elicitation: {} };

      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "cancel"
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate one redaction
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-2",
            type: "redaction",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 25 }
          }
        ]
      });

      const result = await resultPromise;

      // Verify cancel path
      expect(result.structuredContent).toEqual({
        applied: [],
        userDeclined: true,
        action: "cancel",
        viewUUID: expect.any(String)
      });
      expect(result.content).toEqual([{ type: "text", text: "User declined apply" }]);

      // Verify no apply_redactions_now command was enqueued
      const finalCommands = sessionModule.drain();
      expect(finalCommands).toHaveLength(0);
    });

    it("returns userDeclined:true when elicit.content.confirm is false", async () => {
      const { server, callTool } = fixture;

      (server as any).server._clientCapabilities = { elicitation: {} };

      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "accept",
        content: { confirm: false }
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate one redaction
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-3",
            type: "redaction",
            pageIndex: 2,
            rect: { left: 100, top: 150, width: 50, height: 20 }
          }
        ]
      });

      const result = await resultPromise;

      // Verify confirm:false still leads to userDeclined
      expect(result.structuredContent).toEqual({
        applied: [],
        userDeclined: true,
        action: "accept",
        viewUUID: expect.any(String)
      });

      // Verify no apply_redactions_now command was enqueued
      const finalCommands = sessionModule.drain();
      expect(finalCommands).toHaveLength(0);
    });
  });

  describe("AC4.2: accept path with apply", () => {
    it("applies redactions and returns audit payload on accept", async () => {
      const { server, callTool } = fixture;

      (server as any).server._clientCapabilities = { elicitation: {} };

      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "accept",
        content: { confirm: true }
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      let commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate two redactions with and without sourceTerm
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-1",
            type: "redaction",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 30 },
            customData: { sourceTerm: "SSN" }
          },
          {
            id: "ann-red-2",
            type: "redaction",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 25 }
          }
        ]
      });

      await flushMicrotasks();

      commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("apply_redactions_now");
      const applyRequestId = (commands[0]! as any).requestId;

      // Simulate viewer success
      sessionModule.resolvePending(applyRequestId, { ok: true });

      const result = await resultPromise;

      // Verify applied audit payload
      expect(result.structuredContent).toEqual({
        applied: [
          {
            id: "ann-red-1",
            type: "redaction",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 30 },
            sourceTerm: "SSN"
          },
          {
            id: "ann-red-2",
            type: "redaction",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 25 }
          }
        ],
        viewUUID: expect.any(String)
      });
      expect(result.content).toEqual([{ type: "text", text: "Applied 2 redactions." }]);
    });

    it("includes sourceTerm in applied array when present", async () => {
      const { server, callTool } = fixture;

      (server as any).server._clientCapabilities = { elicitation: {} };

      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "accept",
        content: { confirm: true }
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      let commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate redaction with sourceTerm
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-src",
            type: "redaction",
            pageIndex: 5,
            rect: { left: 100, top: 200, width: 120, height: 40 },
            customData: { sourceTerm: "phone: (555) 123-4567" }
          }
        ]
      });

      await flushMicrotasks();

      commands = sessionModule.drain();
      const applyRequestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(applyRequestId, { ok: true });

      const result = await resultPromise;

      // Verify sourceTerm is included in the applied item
      const applied = (result.structuredContent as any).applied[0];
      expect(applied).toEqual({
        id: "ann-red-src",
        type: "redaction",
        pageIndex: 5,
        rect: { left: 100, top: 200, width: 120, height: 40 },
        sourceTerm: "phone: (555) 123-4567"
      });
    });
  });

  describe("AC4.2: error handling during apply", () => {
    it("returns error result when apply_redactions_now fails", async () => {
      const { server, callTool } = fixture;

      (server as any).server._clientCapabilities = { elicitation: {} };

      const mockElicitInput = vi.fn().mockResolvedValue({
        action: "accept",
        content: { confirm: true }
      });
      (server as any).server.elicitInput = mockElicitInput;

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      let commands = sessionModule.drain();
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate one redaction
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-1",
            type: "redaction",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 30 }
          }
        ]
      });

      await flushMicrotasks();

      commands = sessionModule.drain();
      const applyRequestId = (commands[0]! as any).requestId;

      // Simulate viewer error
      sessionModule.resolvePending(applyRequestId, {
        error: "SDK error: applyRedactions not supported"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("SDK error");
    });
  });

  // Hosts that do not advertise `capabilities.elicitation` (e.g. Cowork
  // today) take a different branch: the host-rendered confirm form is
  // skipped entirely and the model is the gate via the description-driven
  // chat-confirmation contract. We assert via mock that elicitInput is
  // never called on this branch.
  describe("client without elicitation capability (Cowork path)", () => {
    it("applies redactions directly without calling elicitInput when redactions are pending", async () => {
      const { server, callTool } = fixture;

      // Client capabilities deliberately omit elicitation.
      (server as any).server._clientCapabilities = { roots: {} };

      const mockElicitInput = vi.fn();
      vi.spyOn(server.server, "elicitInput").mockImplementation(mockElicitInput);

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      let commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_annotations");
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate two pending redactions
      sessionModule.resolvePending(readRequestId, {
        annotations: [
          {
            id: "ann-red-1",
            type: "redaction",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 30 },
            customData: { sourceTerm: "SSN" }
          },
          {
            id: "ann-red-2",
            type: "redaction",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 25 }
          }
        ]
      });

      await flushMicrotasks();

      // The handler must enqueue apply_redactions_now without an
      // intervening elicitInput call.
      commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("apply_redactions_now");
      const applyRequestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(applyRequestId, { ok: true });

      const result = await resultPromise;

      // elicitInput must not have been called at any point.
      expect(mockElicitInput).not.toHaveBeenCalled();

      // Audit payload matches the elicitation-accept path.
      expect(result.structuredContent).toEqual({
        applied: [
          {
            id: "ann-red-1",
            type: "redaction",
            pageIndex: 0,
            rect: { left: 10, top: 20, width: 100, height: 30 },
            sourceTerm: "SSN"
          },
          {
            id: "ann-red-2",
            type: "redaction",
            pageIndex: 1,
            rect: { left: 50, top: 60, width: 80, height: 25 }
          }
        ],
        viewUUID: expect.any(String)
      });
      expect(result.content).toEqual([{ type: "text", text: "Applied 2 redactions." }]);
      // No userDeclined / action keys leak onto the apply branch.
      expect((result.structuredContent as any).userDeclined).toBeUndefined();
      expect((result.structuredContent as any).action).toBeUndefined();
    });

    it("returns nothingToApply early without calling elicitInput when zero redactions are pending", async () => {
      const { server, callTool } = fixture;

      // Client capabilities deliberately omit elicitation.
      (server as any).server._clientCapabilities = {};

      const mockElicitInput = vi.fn();
      vi.spyOn(server.server, "elicitInput").mockImplementation(mockElicitInput);

      const resultPromise = callTool("apply_annotations", {});

      await flushMicrotasks();

      let commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_annotations");
      const readRequestId = (commands[0]! as any).requestId;

      // Simulate viewer returning empty redactions array
      sessionModule.resolvePending(readRequestId, { annotations: [] });

      const result = await resultPromise;

      // Same nothing-to-apply early result as the elicitation-capable branch.
      expect(result.structuredContent).toEqual({
        applied: [],
        nothingToApply: true,
        viewUUID: expect.any(String)
      });
      expect(result.content).toEqual([{ type: "text", text: "Nothing to apply." }]);

      // Neither elicitInput nor apply_redactions_now should have been issued.
      expect(mockElicitInput).not.toHaveBeenCalled();
      const finalCommands = sessionModule.drain();
      expect(finalCommands).toHaveLength(0);
    });
  });
});
