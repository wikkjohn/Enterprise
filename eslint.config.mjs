import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/next-env.d.ts", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      // Architectural guardrail: modules must not import provider SDKs or raw DB drivers.
      "no-restricted-imports": ["error", {
        paths: [
          { name: "openai", message: "Use @eaop/ai (shared AI provider layer)." },
          { name: "@anthropic-ai/sdk", message: "Use @eaop/ai (shared AI provider layer)." }
        ]
      }]
    }
  },
  {
    files: ["modules/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "pg", message: "Modules must use @eaop/db tenant-scoped access (withTenant)." },
          { name: "openai", message: "Use @eaop/ai." },
          { name: "@anthropic-ai/sdk", message: "Use @eaop/ai." }
        ]
      }]
    }
  },
  {
    // The shared AI layer is the ONLY place allowed to import provider SDKs.
    files: ["packages/ai/src/providers/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/scripts/**/*.ts", "apps/worker/**/*.ts"],
    rules: { "no-console": "off" }
  }
);
