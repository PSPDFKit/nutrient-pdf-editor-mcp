import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InitializeRequestSchema,
  LATEST_PROTOCOL_VERSION,
  RootsListChangedNotificationSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type InitializeResult,
  type ServerCapabilities
} from "@modelcontextprotocol/sdk/types.js";
import { setClientRoots } from "./client-roots.js";
import { initLogger, log } from "./logger.js";
import { requireUiCapability } from "./require-ui-capability.js";
import { registerViewerAppResource } from "./app-resource.js";
import { registerCurrentDocumentResource } from "./document-resource.js";
import { registerInternalTools } from "./internal-tools.js";
import { registerOpenDocument } from "./tools/open-document.js";
import { registerWriteDocumentBytes } from "./tools/write-document-bytes.js";
import { registerViewStateTools } from "./tools/view-state.js";
import { registerSearchExactTextTool } from "./tools/search-exact-text.js";
import { registerDocumentInformationTool } from "./tools/read-document-information.js";
import { registerPageInfoTool } from "./tools/read-page-info.js";
import { registerPageImageTool } from "./tools/get-page-image.js";
import { registerCreateAnnotationTool } from "./tools/create-annotation.js";
import { registerReadAnnotationsTool } from "./tools/read-annotations.js";
import { registerUpdateAnnotationTool } from "./tools/update-annotation.js";
import { registerDeleteAnnotationTool } from "./tools/delete-annotation.js";
import { registerApplyAnnotationsTool } from "./tools/apply-annotations.js";
import { registerReadFormFields } from "./tools/read-form-fields.js";
import { registerUpdateFormFieldValues } from "./tools/update-form-field-values.js";
import { registerReadTextTool } from "./tools/read-text.js";
import { registerCloseDocumentTool } from "./tools/close-document.js";
import { installInternalToolsFilter } from "./tool-registry.js";

export function createServer(): McpServer {
  // Elicitation is consumed by `apply_annotations` to confirm permanent
  // redactions; the call site is gated on the client's
  // `capabilities.elicitation` advertisement (read fresh per invocation).
  const capabilities: ServerCapabilities & { elicitation?: Record<string, never> } = {
    tools: {},
    elicitation: {},
    logging: {}
  };
  // serverInfo.name MUST equal manifest.json#display_name. Cowork keys MCP-App
  // resource lookups by display name; a mismatch makes the host silently skip
  // resources/read so the iframe never renders. Enforced by verify-server-name.mjs.
  const server = new McpServer(
    { name: "Nutrient PDF Editor", version: "0.1.0" },
    {
      capabilities,
      instructions: [
        'Use this server whenever the user works with a document file — PDF, Word/Excel/PowerPoint, or scanned images (.pdf, .docx, .xlsx, .pptx, .png, .jpg, .tiff). Triggers include: "review this contract", "redact PII", "fill out this form", "extract X from this report", "show me page N", "find every signature", "highlight clauses about Y", or any prompt that names a document path with one of these extensions.',
        "Workflow: call open_document first with the file path. The viewer iframe mounts so the user can see and verify the work. After it returns, use the operating tools — read_text, search_exact_text, read/create/update/delete_annotation, read/update_form_field_values, get_page_image, apply_annotations. Only one document is open at a time; opening another replaces it.",
        "This server treats these documents as documents — extracting text with page boundaries, rendering pages as images, finding form fields, applying redactions — and surfaces a viewer the user can watch. Reach for it whenever a task involves the contents of one of the supported document file types.",
        'LICENSE_ERROR: If any tool returns an McpError whose data.code is "LICENSE_ERROR", the Nutrient Web SDK rejected the license configuration. The error data also contains a subKind ("invalid", "expired", or "host-mismatch") and a guidance string with a support-contact URL. All subsequent tool calls on the same session will return the same error until a new open_document succeeds with a valid license. Inform the user of the license issue and provide the guidance text.'
      ].join("\n\n")
    }
  );
  initLogger(server);

  // Replace the SDK's default `initialize` handler with one that gates on the
  // MCP Apps UI capability. The default handler is registered by the SDK
  // `Server` constructor and writes `_clientCapabilities` / `_clientVersion`
  // before returning the standard `InitializeResult`. We duplicate that body
  // verbatim on the success path so `oninitialized` (which reads
  // `getClientCapabilities()` / `getClientVersion()`) keeps working. On the
  // reject path we throw `McpError(InvalidRequest)` before any side effects
  // so the server never moves out of the pre-initialized state.
  //
  // The duplication is intentional and load-bearing: the SDK's body is short
  // and we want a single visible place that says "this is what the server
  // does on initialize". See `require-ui-capability.ts` for the rejection
  // message shape and the experimental-fallback policy.
  // The SDK keeps `_clientCapabilities` / `_clientVersion` / `_serverInfo` /
  // `_instructions` private and `getCapabilities()` private; reading and
  // writing them requires casting through `unknown`. We narrow to a typed
  // shape so the rest of the body type-checks.
  type ServerInternals = {
    _clientCapabilities?: unknown;
    _clientVersion?: unknown;
    _serverInfo: InitializeResult["serverInfo"];
    _instructions?: string;
    getCapabilities(): InitializeResult["capabilities"];
  };
  server.server.setRequestHandler(
    InitializeRequestSchema,
    async (request): Promise<InitializeResult> => {
      requireUiCapability(request.params.capabilities as Parameters<typeof requireUiCapability>[0]);
      // SDK-default initialize body (see
      // node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js).
      // Duplicated here so the gate runs before the side effects;
      // `oninitialized` reads `_clientCapabilities` / `_clientVersion` via
      // the public `getClientCapabilities` / `getClientVersion` accessors,
      // so we set them explicitly on the success path.
      const internals = server.server as unknown as ServerInternals;
      const requestedVersion = request.params.protocolVersion;
      internals._clientCapabilities = request.params.capabilities;
      internals._clientVersion = request.params.clientInfo;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;
      const result: InitializeResult = {
        protocolVersion,
        capabilities: internals.getCapabilities(),
        serverInfo: internals._serverInfo
      };
      if (internals._instructions) result.instructions = internals._instructions;
      return result;
    }
  );

  async function refreshClientRoots(): Promise<void> {
    if (!server.server.getClientCapabilities()?.roots) return;
    try {
      const { roots } = await server.server.listRoots();
      setClientRoots(
        roots.map((r) => ({ uri: r.uri, ...(r.name !== undefined && { name: r.name }) }))
      );
      log("info", "client.roots.refreshed", { count: roots.length });
    } catch (err) {
      log("warning", "client.roots.refresh_failed", { error: String(err) });
    }
  }

  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    const version = server.server.getClientVersion();
    log("info", "client.initialized", {
      name: version?.name,
      version: version?.version,
      capabilities: caps,
      extensions: (caps as { extensions?: unknown } | undefined)?.extensions
    });
    void refreshClientRoots();
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await refreshClientRoots();
  });

  // Build the explicit tool registry as we register tools. Maps tool name to RegisteredTool.
  const allToolsRegistry = new Map<string, RegisteredTool>();

  registerViewerAppResource(server);
  // Document bytes flow: viewer reads `nutrient-doc:///current` via
  // `app.readServerResource`; one round-trip, no chunked tool calls.
  registerCurrentDocumentResource(server);

  // Internal tools (poll_commands, submit_response, write_document_bytes)
  // are registered separately and collected for the tools/list filter.
  // Document reads go through the `nutrient-doc:///current` resource (not a
  // tool); writes still need a chunked tool because resources are read-only.
  // registerInternalTools returns [poll, submit, viewer_event].
  const [pollCommandsTool, submitResponseTool, viewerEventTool] = registerInternalTools(server);
  const writeDocumentBytesTool = registerWriteDocumentBytes(server);
  const internalTools = [
    pollCommandsTool,
    submitResponseTool,
    viewerEventTool,
    writeDocumentBytesTool
  ];

  // open_document is the entry point. All operating tools are statically advertised;
  // each enforces "document is open" via requireOpenDocument() at handler entry.
  const openDocumentTool = registerOpenDocument(server);
  allToolsRegistry.set("open_document", openDocumentTool);

  // View state returns 2 RegisteredTools
  const viewStateTools = registerViewStateTools(server);
  allToolsRegistry.set("get_view_state", viewStateTools[0]!);
  allToolsRegistry.set("set_view_state", viewStateTools[1]!);

  // Tools using defineOperatingTool register themselves directly into
  // allToolsRegistry — no explicit .set() calls needed here.
  registerSearchExactTextTool(server, allToolsRegistry);
  registerDocumentInformationTool(server, allToolsRegistry);
  registerPageInfoTool(server, allToolsRegistry);
  registerPageImageTool(server, allToolsRegistry);
  registerCreateAnnotationTool(server, allToolsRegistry);
  registerReadAnnotationsTool(server, allToolsRegistry);
  registerUpdateAnnotationTool(server, allToolsRegistry);
  registerDeleteAnnotationTool(server, allToolsRegistry);
  registerReadFormFields(server, allToolsRegistry);
  registerUpdateFormFieldValues(server, allToolsRegistry);
  registerReadTextTool(server, allToolsRegistry);

  const applyAnnotationsTool = registerApplyAnnotationsTool(server);
  allToolsRegistry.set("apply_annotations", applyAnnotationsTool);

  const closeDocumentTool = registerCloseDocumentTool(server);
  allToolsRegistry.set("close_document", closeDocumentTool);

  // Install the custom tools/list filter that hides internal tools from the model
  // while keeping them callable from the iframe via tools/call.
  // Pass the explicit registry and the internal tools for reference-based filtering.
  installInternalToolsFilter(server, allToolsRegistry, internalTools);

  return server;
}
