import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/", "**/.next/", "**/coverage/", "**/.venv/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.js"],
    languageOptions: { globals: globals.node },
  },
  // marketing-logic may import types from attribution, never the reverse.
  {
    files: ["packages/attribution/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@cdp/marketing-logic", "@cdp/marketing-logic/*", "**/marketing-logic/**"],
              message: "packages/attribution must not depend on packages/marketing-logic.",
            },
          ],
        },
      ],
    },
  },
);
