/**
 * Shared MCPClient for integration tests.
 * Handles stdio spawning, message queuing, the MCP handshake (including
 * `roots/list` advertisement), and request/response matching.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");

export interface MCPMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export class MCPClient {
  private process: ChildProcess;
  private messageId = 1;
  private pendingResponses = new Map<number | string, (msg: MCPMessage) => void>();
  protected notifications: MCPMessage[] = [];
  private rootsAdvertisedResolvers: Array<() => void> = [];
  private rootsRefreshedSeen = false;
  private readonly fixturesDir: string;

  constructor(fixturesDir: string, envOverrides: Record<string, string> = {}) {
    this.fixturesDir = path.resolve(fixturesDir);

    this.process = spawn("node", [path.join(projectRoot, "dist/index.js"), "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: projectRoot,
      env: { ...process.env, ...envOverrides }
    });

    this.process.stdout!.setEncoding("utf8");
    let buffer = "";

    this.process.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as MCPMessage;
          this.dispatch(msg);
        } catch (e) {
          console.error("Failed to parse MCP message:", line, e);
        }
      }
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      console.error("[SERVER STDERR]:", chunk.toString());
    });
  }

  private dispatch(msg: MCPMessage): void {
    // Server-initiated request (has both id and method) — handle known ones.
    if (msg.id !== undefined && typeof msg.method === "string") {
      this.handleServerRequest(msg);
      return;
    }
    // Server response to a client request.
    if (msg.id !== undefined) {
      const resolver = this.pendingResponses.get(msg.id);
      if (resolver) {
        this.pendingResponses.delete(msg.id);
        resolver(msg);
      }
      return;
    }
    // Notification.
    this.notifications.push(msg);
    if (this.isRootsRefreshedLog(msg)) {
      this.rootsRefreshedSeen = true;
      const waiters = this.rootsAdvertisedResolvers.splice(0);
      for (const r of waiters) r();
    }
  }

  private handleServerRequest(req: MCPMessage): void {
    // A request without `id` is a notification; the JSON-RPC spec forbids
    // responding to it. The dispatch path only forwards method-bearing
    // messages here, but TS can't narrow that — the explicit guard keeps
    // `id` typed as `number | string` for the response objects below.
    if (req.id === undefined) return;
    if (req.method === "roots/list") {
      const response: MCPMessage = {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          roots: [
            {
              uri: pathToFileURL(this.fixturesDir).href,
              name: path.basename(this.fixturesDir)
            }
          ]
        }
      };
      this.process.stdin!.write(JSON.stringify(response) + "\n");
      return;
    }
    // Any other server-initiated request — respond with method-not-found so
    // the SDK doesn't time out.
    const response: MCPMessage = {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` }
    };
    this.process.stdin!.write(JSON.stringify(response) + "\n");
  }

  private isRootsRefreshedLog(msg: MCPMessage): boolean {
    return (
      msg.method === "notifications/message" &&
      msg.params?.data?.msg === "client.roots.refreshed"
    );
  }

  send(request: Omit<MCPMessage, "jsonrpc" | "id">): Promise<MCPMessage> {
    return new Promise((resolve) => {
      const id = this.messageId++;
      const msg: MCPMessage = {
        jsonrpc: "2.0",
        id,
        ...request
      };

      this.pendingResponses.set(id, resolve);
      this.process.stdin!.write(JSON.stringify(msg) + "\n");

      setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id);
          resolve({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "Timeout waiting for response" }
          });
        }
      }, 5000);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: MCPMessage = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.process.stdin!.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Run the full MCP handshake, including advertising filesystem roots so the
   * server's path guard accepts paths under `fixturesDir` and the MCP Apps
   * UI capability so the server's init-time UI gate accepts the connection
   * (see `src/mcp/require-ui-capability.ts`). Resolves once the server has
   * logged `client.roots.refreshed` (so subsequent tool calls race-free).
   */
  async initialize(opts: {
    protocolVersion?: string;
    clientInfo?: { name: string; version: string };
    extraCapabilities?: Record<string, unknown>;
  } = {}): Promise<MCPMessage> {
    const initRes = await this.send({
      method: "initialize",
      params: {
        protocolVersion: opts.protocolVersion ?? "2024-11-05",
        capabilities: {
          roots: { listChanged: true },
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"]
            }
          },
          ...(opts.extraCapabilities ?? {})
        },
        clientInfo: opts.clientInfo ?? { name: "test", version: "1.0" }
      }
    });
    this.notify("notifications/initialized");
    await this.waitForRootsRefreshed();
    return initRes;
  }

  /** Resolves once the server has confirmed it ingested our roots. */
  private waitForRootsRefreshed(): Promise<void> {
    if (this.rootsRefreshedSeen) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.rootsAdvertisedResolvers.indexOf(resolveAndClear);
        if (idx >= 0) this.rootsAdvertisedResolvers.splice(idx, 1);
        reject(new Error("Timed out waiting for client.roots.refreshed"));
      }, 5000);
      const resolveAndClear = () => {
        clearTimeout(timer);
        resolve();
      };
      this.rootsAdvertisedResolvers.push(resolveAndClear);
    });
  }

  getNotifications(): MCPMessage[] {
    return this.notifications;
  }

  close(): void {
    if (this.process) {
      this.process.kill();
    }
  }
}
