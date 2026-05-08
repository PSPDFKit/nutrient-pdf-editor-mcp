/**
 * Typed discriminated union of every command the MCP server can enqueue for
 * the viewer iframe to execute. Shared between the server (Node target) and
 * the viewer (browser target) — MUST NOT import from node:* or from any
 * target-specific module.
 *
 * This is the single source of truth for the viewer command contract.
 * Previously duplicated between src/mcp/session.ts (server) and an inline
 * interface in src/viewer/main.ts (browser). These are now unified here.
 */
import type { AnnotationInput, AnnotationType, AnnotationPatch } from "./annotation-types.js";

export type ViewerCommand =
  | { type: "get_view_state"; requestId: string }
  | {
      type: "set_view_state";
      requestId: string;
      activePage?: number;
      scrollTo?: {
        pageIndex: number;
        rect: { left: number; top: number; width: number; height: number };
      };
      selection?: unknown;
    }
  | { type: "search_exact_text"; requestId: string; query: string; pageIndex?: number }
  | { type: "read_document_information"; requestId: string }
  | { type: "read_page_info"; requestId: string; pageIndex: number }
  | { type: "get_page_image"; requestId: string; pageIndex: number; width?: number }
  | { type: "create_annotation"; requestId: string; input: AnnotationInput }
  | {
      type: "read_annotations";
      requestId: string;
      pageIndex?: number;
      annotationType?: AnnotationType;
    }
  | { type: "update_annotation"; requestId: string; id: string; patch: AnnotationPatch }
  | { type: "delete_annotation"; requestId: string; id: string }
  | { type: "apply_redactions_now"; requestId: string }
  | { type: "read_form_fields"; requestId: string; pageIndex?: number }
  | {
      type: "update_form_field_values";
      requestId: string;
      formFieldValues: Array<{ name: string; value: string | string[] | null }>;
    }
  | { type: "read_text"; requestId: string; pageStart: number; pageEnd: number }
  | { type: "close_document"; requestId: string };
