// @ts-check

import { readFileSync } from "node:fs";
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * The .gitignore patterns as flat config globs, so a local virtualenv or an
 * output directory the docs suggest is not linted. This follows
 * includeIgnoreFile() from @eslint/compat, which is not worth a dependency
 * for the simple patterns used here: a pattern without an inner slash
 * matches at any depth, one with a slash is anchored at the root.
 */
function gitignorePatterns() {
  return readFileSync(new URL(".gitignore", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      const slash = pattern.indexOf("/");
      const anywhere = slash < 0 || slash === pattern.length - 1 ? "**/" : "";
      const anchored = slash === 0 ? pattern.slice(1) : pattern;
      return `${negated ? "!" : ""}${anywhere}${anchored}`;
    });
}

export default defineConfig(
  {
    ignores: gitignorePatterns(),
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Strict type safety rules
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // Rules that prevent bugs
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Enforce consistent type-only imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { disallowTypeAnnotations: false },
      ],

      // Keep disabled for legitimate use cases
      "@typescript-eslint/no-unused-expressions": "off", // Allow standalone expressions

      // Enforce no unused vars with underscore prefix support
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // The page enforces Trusted Types (utils/trustedHtml.ts): markup of the
    // app reaches a sink through trustedHtml, or the default policy turns
    // it into text. Writing nothing is replaceChildren(), and += would
    // hand the sink a string again.
    files: ["flown/frontend/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression[left.property.name=/^(inner|outer)HTML$/]:not([operator='='][right.callee.name='trustedHtml'])",
          message: "Assign trustedHtml(markup) (utils/trustedHtml.ts).",
        },
        {
          selector:
            "CallExpression[callee.property.name='insertAdjacentHTML']:not([arguments.1.callee.name='trustedHtml'])",
          message: "Pass trustedHtml(markup) (utils/trustedHtml.ts).",
        },
        {
          selector:
            "CallExpression[callee.property.name='setHTML']:not([arguments.0.callee.name='trustedHtml'])",
          message: "Pass trustedHtml(markup) (utils/trustedHtml.ts).",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(parseFromString|createContextualFragment|setHTMLUnsafe)$/], CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
          message:
            "The default policy would escape it (utils/trustedHtml.ts); build the markup for trustedHtml.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "tests/**/*.ts"],
    rules: {
      // Allow unbound methods in tests (common pattern with mocks/spies)
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
);
