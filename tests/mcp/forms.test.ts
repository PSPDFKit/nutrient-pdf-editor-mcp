import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { registerReadFormFields } from "../../src/mcp/tools/read-form-fields.js";
import { registerUpdateFormFieldValues } from "../../src/mcp/tools/update-form-field-values.js";
import { randomUUID } from "node:crypto";
import { createTestClient, flushMicrotasks } from "../helpers/mcpTestClient.js";

describe("read_form_fields", () => {
  beforeEach(() => {
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    sessionModule.setOpenDocument("/tmp/forms-fixture.pdf");
  });

  afterEach(() => {
    sessionModule.clearOpenDocument();
  });

  it("viewer-mcp.AC5.1: read_form_fields returns InstantJSON-shaped fields with markdown content", async () => {
    const { callTool } = await createTestClient([registerReadFormFields]);

    const { viewUUID: sessionUUID } = sessionModule.getSession();

    const resultPromise = callTool("read_form_fields", {});

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    expect(queuedCommands.length).toBe(1);
    const queuedCommand = queuedCommands[0]!;
    expect(queuedCommand.type).toBe("read_form_fields");
    const requestId = (queuedCommand as any).requestId;

    // Simulate the viewer returning InstantJSON-shaped form fields.
    sessionModule.resolvePending(requestId, {
      fields: [
        {
          v: 1,
          type: "pspdfkit/form-field/text",
          id: "id-text-1",
          pdfObjectId: 1,
          name: "applicant.name",
          annotationIds: ["w1"],
          label: "Full Name",
          additionalActions: undefined,
          flags: ["required"],
          password: false,
          doNotScroll: false,
          multiLine: false,
          defaultValue: "",
          comb: false,
          doNotSpellCheck: false,
          value: "John Doe",
          pageIndex: 0,
          rect: { left: 10, top: 20, width: 100, height: 20 }
        },
        {
          v: 1,
          type: "pspdfkit/form-field/checkbox",
          id: "id-check-1",
          pdfObjectId: 2,
          name: "applicant.agree",
          annotationIds: ["w2"],
          label: "I Agree",
          additionalActions: undefined,
          options: [{ value: "Yes", label: "Yes" }],
          defaultValues: [],
          value: "Yes",
          pageIndex: 0,
          rect: { left: 10, top: 50, width: 20, height: 20 }
        },
        {
          v: 1,
          type: "pspdfkit/form-field/radio",
          id: "id-radio-1",
          pdfObjectId: 3,
          name: "applicant.choice",
          annotationIds: ["w3"],
          label: "Choose One",
          additionalActions: undefined,
          options: [
            { value: "A", label: "Option A" },
            { value: "B", label: "Option B" }
          ],
          noToggleToOff: false,
          radiosInUnison: false,
          defaultValue: "",
          value: "A",
          pageIndex: 1,
          rect: { left: 10, top: 100, width: 150, height: 30 }
        }
      ]
    });

    const result = await resultPromise;

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("structuredContent");
    expect(result).toHaveProperty("_meta");

    // structuredContent carries the same field array for hosts that route the
    // structured channel to the model (Claude Code) — see formatters.ts header.
    const fields = (result.structuredContent as any).fields;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields).toHaveLength(3);
    expect(fields[0]!.type).toBe("pspdfkit/form-field/text");
    expect(fields[1]!.type).toBe("pspdfkit/form-field/checkbox");
    expect(fields[2]!.type).toBe("pspdfkit/form-field/radio");

    // content[0].text is the markdown render — primary channel for MCP Apps
    // hosts (Claude.ai/ext-apps).
    const text = (result as any).content[0].text as string;
    expect(text).toContain("# Form Fields");
    expect(text).toContain("## Full Name");
    expect(text).toContain("## I Agree");
    expect(text).toContain("## Choose One");
    expect(text).toContain('**Options:** "A" (Option A), "B" (Option B)');
    expect(text).toContain("Use one of the options above to check");

    expect((result as any)._meta).toEqual({ viewUUID: sessionUUID });
  });

  it("viewer-mcp.AC5.2: read_form_fields with pageIndex filters to matching page", async () => {
    const { callTool } = await createTestClient([registerReadFormFields]);

    const resultPromise = callTool("read_form_fields", { pageIndex: 1 });

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    expect(queuedCommands.length).toBe(1);
    const queuedCommand = queuedCommands[0] as any;
    expect(queuedCommand.pageIndex).toBe(1);

    sessionModule.resolvePending(queuedCommand.requestId, {
      fields: [
        {
          v: 1,
          type: "pspdfkit/form-field/radio",
          id: "id-radio",
          pdfObjectId: 3,
          name: "choice",
          annotationIds: ["w3"],
          label: "Choose",
          additionalActions: undefined,
          options: [
            { value: "A", label: "A" },
            { value: "B", label: "B" }
          ],
          noToggleToOff: false,
          radiosInUnison: false,
          defaultValue: "",
          value: "A",
          pageIndex: 1,
          rect: { left: 10, top: 100, width: 150, height: 30 }
        }
      ]
    });

    const result = await resultPromise;
    const fields = (result.structuredContent as any).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.pageIndex).toBe(1);
  });
});

describe("update_form_field_values", () => {
  beforeEach(() => {
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    sessionModule.setOpenDocument("/tmp/forms-fixture.pdf");
  });

  afterEach(() => {
    sessionModule.clearOpenDocument();
  });

  it("viewer-mcp.AC5.3: text + checkbox update returns {updated, unresolved: []}", async () => {
    const { callTool } = await createTestClient([registerUpdateFormFieldValues]);

    const { viewUUID: sessionUUID } = sessionModule.getSession();

    const resultPromise = callTool("update_form_field_values", {
      formFieldValues: [
        { name: "applicant.name", value: "hello" },
        { name: "applicant.agree", value: ["Yes"] }
      ]
    });

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    expect(queuedCommands.length).toBe(1);
    const queuedCommand = queuedCommands[0] as any;
    expect(queuedCommand.type).toBe("update_form_field_values");
    expect(queuedCommand.formFieldValues).toEqual([
      { name: "applicant.name", value: "hello" },
      { name: "applicant.agree", value: ["Yes"] }
    ]);

    sessionModule.resolvePending(queuedCommand.requestId, {
      // The viewer reports the post-write value of each accepted field so
      // the agent can verify the field state without a follow-up read.
      updated: [
        { name: "applicant.name", value: "hello" },
        { name: "applicant.agree", value: ["Yes"] }
      ],
      unresolved: []
    });

    const result = await resultPromise;
    expect((result.structuredContent as any).updated).toEqual([
      { name: "applicant.name", value: "hello" },
      { name: "applicant.agree", value: ["Yes"] }
    ]);
    expect((result.structuredContent as any).unresolved).toEqual([]);
    expect((result as any)._meta).toEqual({ viewUUID: sessionUUID });

    // content[0].text carries the markdown success line plus a "Now set to:"
    // block so the agent sees post-write values inline.
    const text = (result as any).content[0].text as string;
    expect(text).toContain("Successfully updated 2 form field(s)");
    expect(text).toContain("Now set to:");
    expect(text).toContain('applicant.name: "hello"');
    expect(text).toContain('applicant.agree: "Yes"');
  });

  it("viewer-mcp.AC5.4: radio with string value passes the new schema", async () => {
    const { callTool } = await createTestClient([registerUpdateFormFieldValues]);

    const resultPromise = callTool("update_form_field_values", {
      formFieldValues: [{ name: "applicant.choice", value: "B" }]
    });

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    const queuedCommand = queuedCommands[0] as any;
    expect(queuedCommand.formFieldValues).toEqual([{ name: "applicant.choice", value: "B" }]);

    sessionModule.resolvePending(queuedCommand.requestId, {
      updated: [{ name: "applicant.choice", value: "B" }],
      unresolved: []
    });

    const result = await resultPromise;
    expect((result.structuredContent as any).updated).toEqual([
      { name: "applicant.choice", value: "B" }
    ]);
  });

  it("viewer-mcp.AC5.5: unknown field name in unresolved; known fields still applied", async () => {
    const { callTool } = await createTestClient([registerUpdateFormFieldValues]);

    const resultPromise = callTool("update_form_field_values", {
      formFieldValues: [
        { name: "applicant.name", value: "hello" },
        { name: "unknown_field", value: "value2" }
      ]
    });

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    const requestId = (queuedCommands[0] as any).requestId;

    sessionModule.resolvePending(requestId, {
      updated: [{ name: "applicant.name", value: "hello" }],
      unresolved: [{ name: "unknown_field", reason: "Unknown field name" }]
    });

    const result = await resultPromise;
    expect((result.structuredContent as any).updated).toEqual([
      { name: "applicant.name", value: "hello" }
    ]);
    expect((result.structuredContent as any).unresolved).toEqual([
      { name: "unknown_field", reason: "Unknown field name" }
    ]);

    // The markdown summary surfaces unresolved entries inline so the model
    // sees the failure even when a host routes only content[].text.
    const text = (result as any).content[0].text as string;
    expect(text).toContain("Successfully updated 1 form field(s)");
    expect(text).toContain("Unresolved:");
    expect(text).toContain("unknown_field: Unknown field name");
  });

  it("viewer-mcp.AC5.6: array value for multi-select listbox passes through schema", async () => {
    const { callTool } = await createTestClient([registerUpdateFormFieldValues]);

    const resultPromise = callTool("update_form_field_values", {
      formFieldValues: [{ name: "tags", value: ["red", "blue"] }]
    });

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    const queuedCommand = queuedCommands[0] as any;
    expect(queuedCommand.formFieldValues).toEqual([{ name: "tags", value: ["red", "blue"] }]);

    sessionModule.resolvePending(queuedCommand.requestId, {
      updated: [{ name: "tags", value: ["red", "blue"] }],
      unresolved: []
    });

    const result = await resultPromise;
    expect((result.structuredContent as any).updated).toEqual([
      { name: "tags", value: ["red", "blue"] }
    ]);
  });

  it("viewer-mcp.AC5.7: null value passes through schema (uncheck/clear)", async () => {
    const { callTool } = await createTestClient([registerUpdateFormFieldValues]);

    const resultPromise = callTool("update_form_field_values", {
      formFieldValues: [{ name: "applicant.agree", value: null }]
    });

    await flushMicrotasks();

    const queuedCommands = sessionModule.drain();
    const queuedCommand = queuedCommands[0] as any;
    expect(queuedCommand.formFieldValues).toEqual([{ name: "applicant.agree", value: null }]);
  });
});
