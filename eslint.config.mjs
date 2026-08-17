import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

// `js.configs.recommended` is used directly rather than through
// @eslint/eslintrc's FlatCompat. The compat layer exists to read the old
// `.eslintrc` format, and it validates whatever it is handed against the old
// schema -- so `compat.extends("eslint:recommended")` broke outright on
// @eslint/js 10, which adds a top-level `name` to its shared configs:
// `Unexpected top-level property "name"`. Nothing here needs eslintrc
// semantics, so the layer is gone and @eslint/eslintrc with it.
export default defineConfig([globalIgnores(["**/dist/"]), {
    extends: [js.configs.recommended],
    ignores: [
        "eslint.config.mjs",
        "dist/"
    ],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.jest,
            ...globals.node,
            Atomics: "readonly",
            SharedArrayBuffer: "readonly",
        },

        ecmaVersion: 2018,
        sourceType: "commonjs",
    },

    rules: {},
}]);
