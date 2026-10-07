import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./server.js";
import { createSessionContext, runInSessionContext, type SessionContext } from "./session.js";
import { pruneRemoteDocuments } from "./remote-documents.js";

/**
 * Hosted (remote) connector: Streamable HTTP transport, one MCP server +
 * transport + session context per MCP session.
 *
 * Must run as a single long-lived process. The viewer bridge keeps command
 * queues, pending responses and cached documents in memory, so serverless or
 * multi-instance deployments would split one conversation across processes.
 */

interface HostedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  context: SessionContext;
  lastSeen: number;
}

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

const sessions = new Map<string, HostedSession>();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function startSession(): Promise<HostedSession> {
  const context = createSessionContext();
  const server = createServer({ mode: "remote" });
  const hosted: HostedSession = {
    // Assigned below; the transport needs `hosted` in its callbacks.
    transport: undefined as unknown as StreamableHTTPServerTransport,
    server,
    context,
    lastSeen: Date.now()
  };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, hosted);
    }
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  hosted.transport = transport;
  // The SDK's transport type declares optional callbacks that conflict with
  // exactOptionalPropertyTypes; the runtime contract is the same.
  await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
  return hosted;
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sessionId = headerValue(req, "mcp-session-id");
  const body = req.method === "POST" ? await readJsonBody(req) : undefined;

  let hosted = sessionId ? sessions.get(sessionId) : undefined;
  if (!hosted) {
    if (sessionId) {
      jsonRpcError(res, 404, "Session not found. Reconnect to start a new session.");
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      jsonRpcError(res, 400, "No session. Send an initialize request first.");
      return;
    }
    hosted = await startSession();
  }
  hosted.lastSeen = Date.now();
  const active = hosted;
  await runInSessionContext(active.context, () => active.transport.handleRequest(req, res, body));
}

function sweepIdleSessions(): void {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, hosted] of sessions) {
    if (hosted.lastSeen < cutoff) {
      sessions.delete(id);
      void hosted.transport.close().catch(() => undefined);
    }
  }
  pruneRemoteDocuments();
}

export function startHttpServer(port: number, host = "0.0.0.0"): http.Server {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, sessions: sessions.size });
      return;
    }
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
      return;
    }
    handleMcp(req, res).catch((err: unknown) => {
      console.error("[nutrient-viewer-http] request failed:", err);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
      else res.end();
    });
  });
  // Long-poll requests from the viewer are held for up to ~25 s.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 65_000;
  httpServer.keepAliveTimeout = 65_000;
  setInterval(sweepIdleSessions, SWEEP_MS).unref();
  httpServer.listen(port, host, () => {
    console.error(`[nutrient-viewer-http] listening on http://${host}:${port}${MCP_PATH}`);
  });
  return httpServer;
}

/** Test-only. */
export function __sessionCountForTesting(): number {
  return sessions.size;
}
