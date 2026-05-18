import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// MCP spec logging levels (RFC 5424 syslog severities used by notifications/message).
export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

const LOGGER_NAME = "nutrient-pdf-editor";
const LOG_FILE =
  process.env.NUTRIENT_VIEWER_LOG_FILE ??
  path.join(os.homedir(), "Library", "Logs", "Claude", `${LOGGER_NAME}.log`);

let mcpServer: McpServer | null = null;

function appendToFile(line: string): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Filesystem unavailable — ignore; stderr still has the line.
  }
}

export function initLogger(server: McpServer): void {
  mcpServer = server;
  log("info", "logger.init", { logFile: LOG_FILE, pid: process.pid });
}

export function log(level: LogLevel, message: string, data?: unknown): void {
  // pid on every entry so we can correlate which server process handled
  // which call — important when Claude Desktop spawns multiple instances
  // of the same .mcpb (e.g. one for agent mode + one for the iframe-host
  // chat session).
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    pid: process.pid,
    ...(data !== undefined ? { data } : {})
  };
  const line = JSON.stringify(entry);

  // 1. stderr — captured by hosts that do hook stdio (standard Claude Desktop chat).
  console.error(`[${LOGGER_NAME}] ${line}`);

  // 2. local file — survives both managers (LocalMcpServerManager swallows stderr).
  appendToFile(line);

  // 3. notifications/message — travels over JSON-RPC; lands in ~/Library/Logs/Claude/mcp.log.
  if (mcpServer) {
    mcpServer.server.sendLoggingMessage({ level, logger: LOGGER_NAME, data: entry }).catch(() => {
      // Client may not have completed initialize, or doesn't accept logging — ignore.
    });
  }
}
