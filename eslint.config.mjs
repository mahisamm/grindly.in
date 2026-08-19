import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".venv/**",
    // Scratch directories the test suites create and hold open. ESLint walks
    // every path it is not told to skip, and on Windows a directory a running
    // process has locked answers EPERM — which aborts the whole lint run rather
    // than skipping one folder. `npm run lint` simply did not work on a machine
    // that had run the tests.
    ".pytest_tmp/**",
    ".pytest_cache/**",
    ".test-tmp/**",
    "data/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
