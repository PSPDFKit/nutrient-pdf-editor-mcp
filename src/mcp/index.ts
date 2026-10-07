import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startStaleViewSweep } from "./session.js";
import { startHttpServer } from "./http-server.js";

const KNOWN_FLAGS = new Set(["--stdio", "--http", "--ping"]);

function parseArgs(argv: string[]): { stdio: boolean; http: boolean; ping: boolean } {
  const flags = { stdio: false, http: false, ping: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--stdio") flags.stdio = true;
    else if (arg === "--http") flags.http = true;
    else if (arg === "--ping") flags.ping = true;
    else {
      console.error(`[nutrient-pdf-editor] Unknown flag: ${arg}`);
      console.error(`[nutrient-pdf-editor] Known flags: ${Array.from(KNOWN_FLAGS).join(", ")}`);
      process.exit(1);
    }
  }
  return flags;
}

async function main() {
  const { stdio, http, ping } = parseArgs(process.argv);

  if (ping) {
    console.log("nutrient-pdf-editor scaffold OK");
    process.exit(0);
  }

  if (http) {
    // Hosted connector (remote mode). PORT is set by most hosting platforms.
    const port = Number(process.env.PORT ?? 8787);
    startHttpServer(Number.isFinite(port) && port > 0 ? port : 8787);
    startStaleViewSweep();
    return;
  }

  if (!stdio) {
    console.error(
      "[nutrient-pdf-editor] Pass --stdio (desktop extension) or --http (hosted connector). Exiting."
    );
    process.exit(1);
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  startStaleViewSweep();
}

main().catch((err) => {
  console.error("[nutrient-pdf-editor] fatal:", err);
  process.exit(1);
});
