// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * ESLint for the frontend.
 *
 * WHY THIS EXISTS AT ALL
 * ──────────────────────
 * The notification settings page shipped a crash — "Rendered more hooks than
 * during the previous render" — caused by a useState placed after the
 * component's early returns. A typecheck cannot catch that: the Rules of Hooks
 * are a runtime contract about call ORDER, not about types. There was no
 * ESLint anywhere in this workspace, so nothing was checking.
 *
 * rules-of-hooks is the reason this config exists; everything else is
 * deliberately mild so that adding linting does not turn into a repo-wide
 * refactor. The existing code has plenty of `any` and unused vars, and turning
 * those into errors today would bury the one rule that matters.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src/generated/**", "**/*.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // ── The rules this config was added for ──────────────────────────────
      // A violation is a runtime crash, not a style opinion.
      "react-hooks/rules-of-hooks": "error",
      // Warn, not error: the existing codebase has intentional omissions with
      // eslint-disable comments, and promoting this to an error would block
      // the build on pre-existing code rather than on new mistakes.
      "react-hooks/exhaustive-deps": "warn",

      // ── Deliberately relaxed, for now ───────────────────────────────────
      // The codebase documents its `as any` debt; these stay warnings so the
      // signal above is not drowned out. Tighten them in a dedicated pass.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
);
