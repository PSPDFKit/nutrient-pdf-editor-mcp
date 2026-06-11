import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startStaleViewSweep } from "./session.js";

const KNOWN_FLAGS = new Set(["--stdio", "--ping"]);

function parseArgs(argv: string[]): { stdio: boolean; ping: boolean } {
  const flags = { stdio: false, ping: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--stdio") flags.stdio = true;
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
  const { stdio, ping } = parseArgs(process.argv);

  if (ping) {
    console.log("nutrient-pdf-editor scaffold OK");
    process.exit(0);
  }

  if (!stdio) {
    console.error("[nutrient-pdf-editor] Only --stdio transport is supported in v1. Exiting.");
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
