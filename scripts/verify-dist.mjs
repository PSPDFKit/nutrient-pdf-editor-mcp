#!/usr/bin/env node
import fs from "fs";
import path from "path";

const checks = [
  {
    name: "dist/index.js exists",
    fn: () => fs.existsSync("dist/index.js"),
  },
  {
    name: "dist/index.js line 1 is shebang",
    fn: () => {
      const content = fs.readFileSync("dist/index.js", "utf-8");
      const lines = content.split("\n");
      return lines[0] === "#!/usr/bin/env node";
    },
  },
  {
    name: "dist/mcp-app.html exists",
    fn: () => fs.existsSync("dist/mcp-app.html"),
  },
  {
    // Guards against vite/rollup misconfig (e.g. entryFileNames: "[name].html")
    // silently writing the JS chunk over the HTML output. The result is a file
    // that ends in .html but is raw JS, which Cowork loads into the iframe and
    // renders as a blank gap. Caught us once — never again.
    name: "dist/mcp-app.html starts with <!doctype html",
    fn: () => {
      const head = fs.readFileSync("dist/mcp-app.html", "utf-8").slice(0, 256);
      return /^\s*<!doctype html/i.test(head);
    },
  },
  {
    name: "dist/mcp-app.html has no inline http:// src attributes",
    fn: () => {
      const content = fs.readFileSync("dist/mcp-app.html", "utf-8");
      const httpSrcMatches = (content.match(/src="http/g) || []).length;
      return httpSrcMatches === 0;
    },
  },
  {
    // The build always emits the CDN flavour. The sentinel meta is injected
    // by vite.config.ts and read by humans for build-flavour visibility; its
    // presence also gates against accidental SDK re-inlining (an inline build
    // would be ~6.9 MB and ship without this tag).
    name: "dist/mcp-app.html contains CDN sentinel",
    fn: () => {
      const content = fs.readFileSync("dist/mcp-app.html", "utf-8");
      return content.includes('name="nutrient-sdk-source" content="cdn"');
    },
  },
];

let passed = 0;
let failed = 0;

for (const check of checks) {
  try {
    const result = check.fn();
    if (result) {
      console.log(`✓ ${check.name}`);
      passed++;
    } else {
      console.error(`✗ ${check.name}`);
      failed++;
    }
  } catch (err) {
    console.error(`✗ ${check.name}: ${err.message}`);
    failed++;
  }
}

console.log(`\nPassed: ${passed}/${checks.length}`);
if (failed > 0) {
  process.exit(1);
}
