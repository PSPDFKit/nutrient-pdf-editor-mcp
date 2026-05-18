import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Annotation } from "./annotation-types.js";
import { getSession } from "../session.js";
import { enqueueAndWait } from "../bridge.js";
import {
  requireValidLicense,
  requireOpenDocument,
  requireFreshDocument
} from "../document-guard.js";

interface PendingRedaction extends Record<string, unknown> {
  id: string;
  pageIndex: number;
  rect: { left: number; top: number; width: number; height: number };
  sourceTerm?: string;
}

interface ApplyAnnotationsResult extends Record<string, unknown> {
  applied: Array<{
    id: string;
    type: "redaction";
    pageIndex: number;
    rect: { left: number; top: number; width: number; height: number };
    sourceTerm?: string;
  }>;
  userDeclined?: boolean;
  nothingToApply?: boolean;
  action?: string;
  viewUUID: string;
}

export function registerApplyAnnotationsTool(server: McpServer): RegisteredTool {
  return server.registerTool(
    "apply_annotations",
    {
      title: "Apply redactions",
      description: [
        "Permanently burn in pending redaction annotations on the open document. THIS IS IRREVERSIBLE — once applied, the redacted content is removed from the file and cannot be recovered.",
        'MANDATORY confirmation contract for the model: BEFORE calling this tool, you MUST (1) list every pending redaction back to the user in chat — page number, source term, and total count — and (2) wait for an explicit, unambiguous yes from the user in the current turn. Phrases like "go ahead", "apply them", or "yes" said about a fresh listing are valid; a stale approval from earlier in the conversation is not.',
        "Some hosts ALSO render a separate confirm dialog (via MCP elicitation) listing each redaction. That dialog is a backstop, not a substitute for asking in chat — on hosts that do not support elicitation it does not appear at all, and the chat confirmation is the only gate.",
        'DO NOT call this tool as a workflow finalizer, as cleanup, as part of a multi-step plan that the user approved in the abstract, or because the user asked you to "redact" something — "redact" means mark with create_annotation; only call this tool when the user has explicitly said to apply / burn in / commit / make permanent the redactions you have already listed.',
        "To remove a draft redaction without applying it, use delete_annotation instead."
      ].join("\n\n"),
      inputSchema: {},
      annotations: { destructiveHint: true }
    },
    async () => {
      requireValidLicense();
      requireOpenDocument();
      requireFreshDocument();
      // Read the client elicitation capability fresh per call — never cache.
      // A host that grows the capability mid-session should be picked up on
      // its next call, and a host that lies and advertises but never
      // implements is the host's bug (we trust the advertisement).
      const elicitationAdvertised = Boolean(server.server.getClientCapabilities()?.elicitation);
      const readRequestId = randomUUID();

      // Use the shared bridge.ts enqueueAndWait — no local shadow. The
      // shared helper handles AbortSignal.timeout, deletePending cleanup, and
      // the 4-clause viewer-error guard (error payload → McpError(InvalidParams)).
      // Task 1: Enumerate pending redactions
      const typed = await enqueueAndWait<{ annotations: Annotation[] }>(
        {
          type: "read_annotations",
          requestId: readRequestId,
          annotationType: "redaction"
        },
        readRequestId
      );

      const { viewUUID } = getSession();
      const pending: PendingRedaction[] = typed.annotations.map((a) => {
        const sourceTerm = a.customData?.sourceTerm as string | undefined;
        return {
          id: a.id,
          pageIndex: a.pageIndex,
          rect: a.rect,
          ...(sourceTerm !== undefined && { sourceTerm })
        };
      });

      // Task 5: Nothing-to-apply path
      if (pending.length === 0) {
        return {
          content: [{ type: "text", text: "Nothing to apply." }],
          structuredContent: {
            applied: [],
            nothingToApply: true,
            viewUUID
          },
          _meta: { viewUUID }
        };
      }

      // Task 2: Elicitation form-mode prompt — only when the client
      // advertises `capabilities.elicitation`. Hosts without it (e.g.
      // Cowork today) skip the host-rendered confirm form entirely; the
      // model is the gate via the chat-confirmation contract baked into
      // the tool description.
      if (elicitationAdvertised) {
        const summary = pending
          .map(
            (r) =>
              `- page ${r.pageIndex + 1}: rect (${r.rect.left.toFixed(0)},${r.rect.top.toFixed(0)}) ${r.rect.width.toFixed(0)}×${r.rect.height.toFixed(0)}${r.sourceTerm ? ` — "${r.sourceTerm}"` : ""}`
          )
          .join("\n");

        let elicitResult: unknown;
        try {
          // Use the server's elicitInput API
          elicitResult = await server.server.elicitInput({
            message: `About to permanently redact ${pending.length} area(s):\n\n${summary}\n\nThis cannot be undone. Confirm to proceed.`,
            requestedSchema: {
              type: "object" as const,
              properties: {
                confirm: {
                  type: "boolean",
                  description: "Check to confirm permanent redaction"
                }
              },
              required: ["confirm"]
            }
          });
        } catch (err) {
          throw new McpError(
            ErrorCode.InternalError,
            `Elicitation failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const elicit = elicitResult as {
          action: "accept" | "decline" | "cancel";
          content?: { confirm?: boolean; [key: string]: unknown };
        };

        // Task 3: Handle decline / cancel
        if (elicit.action !== "accept" || elicit.content?.confirm !== true) {
          return {
            content: [{ type: "text", text: "User declined apply" }],
            structuredContent: {
              applied: [],
              userDeclined: true,
              action: elicit.action,
              viewUUID
            },
            _meta: { viewUUID }
          };
        }
      }

      // Task 4: Apply path + audit payload
      // shared enqueueAndWait handles error payload → McpError conversion.
      const applyRequestId = randomUUID();

      await enqueueAndWait<{ ok?: boolean }>(
        {
          type: "apply_redactions_now",
          requestId: applyRequestId
        },
        applyRequestId
      );

      const result: ApplyAnnotationsResult = {
        applied: pending.map((r) => ({
          id: r.id,
          type: "redaction",
          pageIndex: r.pageIndex,
          rect: r.rect,
          ...(r.sourceTerm ? { sourceTerm: r.sourceTerm } : {})
        })),
        viewUUID
      };

      return {
        content: [{ type: "text", text: `Applied ${pending.length} redactions.` }],
        structuredContent: result,
        _meta: { viewUUID }
      };
    }
  );
}
