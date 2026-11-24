module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: { node: true, es2022: true },

  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },

  overrides: [
    {
      // Enforce structured logger usage across all backend source files.
      // console.* calls are forbidden here; use createLogger() from
      // backend/utils/logger.ts instead.
      files: ["backend/**/*.ts"],
      excludedFiles: [
        // backend/logger.ts is the deprecated shim — it must be allowed to
        // re-export from utils/logger for backward compatibility.
        "backend/logger.ts",
      ],
      rules: {
        "no-console": "error",
        // pino's signature is (mergingObject, message). A string-first call
        // with a fields object silently drops the fields, so forbid it.
        "no-restricted-syntax": [
          "error",
          {
            selector:
              "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(trace|debug|info|warn|error|fatal)$/][callee.object.name=/^(logger|log|[a-z]+Log)$/][arguments.length>1][arguments.0.type=/^(Literal|TemplateLiteral)$/]",
            message:
              "pino expects logger.<level>({ ...fields }, 'message'). Put the fields object first and the message string second.",
          },
          {
            selector:
              "CallExpression[callee.name='parseFloat'], CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
            message:
              "Do not use parseFloat in backend/. Use BigInt stroop helpers from 'backend/utils/amount.ts' instead (fixes #734, #956).",
          },
        ],
        // Block imports from the deprecated ./logger shim. Use ./utils/logger instead.
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["./logger", "../logger", "../../logger"],
                message: "Import from './utils/logger' instead. The './logger' shim is deprecated.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["backend/**/*.ts"],
      excludedFiles: ["backend/config.ts"],

      // Environment variables must be accessed through backend/config.ts
      // so they pass Zod validation and secret-redaction logic.
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "process",
            property: "env",
            message:
              "Do not access process.env directly. Use backend/config.ts instead.",
          },
        ],
      },
    },
    {
      // Test files use require() inside vi.mock() factories which are hoisted
      // by Vitest and cannot use ESM import syntax. Disable the rule for tests.
      files: ["tests/**/*.ts"],
      rules: {
        "@typescript-eslint/no-var-requires": "off",
      },
    },
    {
      // Allow-listed display helper: backend/utils/amount.ts is permitted to use parseFloat (#956).
      files: ["backend/utils/amount.ts"],
      rules: {
        "no-restricted-syntax": "off",
      },
    },
  ],
};
