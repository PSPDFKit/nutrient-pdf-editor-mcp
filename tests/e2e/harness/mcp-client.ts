import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

export type ElicitRule = (params: ElicitRequest["params"]) => ElicitResult | Promise<ElicitResult>;

export interface McpHarnessClient {
  client: Client;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readResource: (uri: string) => Promise<unknown>;
  listTools: () => Promise<{ tools: Array<{ name: string }> }>;
  setElicitationRule: (rule: ElicitRule) => void;
  close: () => Promise<void>;
}

export async function createMcpClient(opts: {
  env?: Record<string, string>;
  /**
   * Filesystem roots to advertise to the server via `roots/list`. The server
   * fails fast on document tools when no roots are advertised.
   */
  roots?: string[];
} = {}): Promise<McpHarnessClient> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    env[k] = v;
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(projectRoot, "dist/index.js"), "--stdio"],
    env,
    cwd: projectRoot,
    stderr: "pipe"
  });

  const client = new Client(
    { name: "dogfood-harness", version: "0.0.0" },
    {
      capabilities: {
        elicitation: {},
        roots: { listChanged: false },
        // The server gates `initialize` on the MCP Apps UI capability. The
        // harness is a non-UI test client, but advertising the capability
        // here matches what real hosts (Claude Desktop, Claude Code, Cowork)
        // do and keeps the gate honest.
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"]
          }
        }
      }
    }
  );

  let elicitRule: ElicitRule = () => ({ action: "cancel" });
  client.setRequestHandler(ElicitRequestSchema, async (req) => elicitRule(req.params));

  const advertisedRoots = (opts.roots ?? []).map((p) => ({
    uri: pathToFileURL(path.resolve(p)).href,
    name: path.basename(p)
  }));
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: advertisedRoots }));

  await client.connect(transport);

  return {
    client,
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    readResource: (uri) => client.readResource({ uri }),
    listTools: () => client.listTools(),
    setElicitationRule: (rule) => {
      elicitRule = rule;
    },
    close: async () => {
      await client.close();
    }
  };
}
