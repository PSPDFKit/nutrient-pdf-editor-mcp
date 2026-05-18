// @ts-check
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // Base TypeScript-ESLint recommended rules
  ...tseslint.configs.recommended,
  // Prettier last — disables formatting rules that conflict with Prettier
  prettierConfig,
  {
    // Project-wide TypeScript settings
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.server.json", "./tsconfig.viewer.json"],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Allow require() in legacy/config contexts (shared-state uses dynamic require)
      "@typescript-eslint/no-require-imports": "off",
      // Allow explicit any where necessary (SDK boundary casts)
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused vars are errors — catches dead code early
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    // P1-5: Cross-boundary import prohibition for src/mcp/ ↔ src/viewer/.
    // Both layers share types only via src/contract/, not by importing each
    // other's target-specific modules. This rule enforces the boundary at
    // lint time so accidental cross-imports fail CI immediately.
    files: ["src/viewer/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/src/mcp/**", "../mcp/**", "../../mcp/**"],
              message:
                "src/viewer/ must not import from src/mcp/. Move shared types to src/contract/ instead."
            }
          ]
        }
      ]
    }
  },
  {
    // Mirror rule: src/mcp/ must not import from src/viewer/.
    files: ["src/mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/src/viewer/**", "../viewer/**", "../../viewer/**"],
              message:
                "src/mcp/ must not import from src/viewer/. Move shared types to src/contract/ instead."
            }
          ]
        }
      ]
    }
  },
  {
    // Ignore build output, node_modules, and generated artefacts
    ignores: [
      "dist/",
      "build/",
      "node_modules/",
      "scripts/*.mjs",
      "vite.config.ts",
      "vitest.config.ts",
      "vitest.e2e.config.ts",
      // CDN shim: plain JS, not part of any tsconfig project (Batch D 2B.L6).
      "src/viewer/nutrient-sdk-cdn-shim.js"
    ]
  }
);
