# Contributing to Nodal AI

Thank you for your interest in contributing to Nodal AI! This document outlines our contribution workflow and guidelines.

---

## Stellar Wave & Drips Points

Nodal AI participates in the **[Stellar Wave](https://stellar.org/wave)** programme — a developer contribution sprint where every merged PR on a labelled issue earns you **Drips points** that can be redeemed within the Stellar ecosystem.

### What are Drips points?

Drips points are contribution credits issued by the Stellar Development Foundation to reward open-source work. Points are tracked per-contributor and accumulated over each sprint cycle.

### How to earn points

1. **Find a Wave-eligible issue**: Browse the [Issues](https://github.com/Nodal-stellar/Nodal-AI/issues) tab and filter by `good first issue`, `help wanted`, or any issue carrying a `complexity: <score>` label.
2. **Claim the issue**: Comment on it so maintainers can assign it to you and avoid duplicate work.
3. **Submit a PR**: Reference the issue number (`Closes #<number>`) in your PR description. Follow the branch-naming and commit-message conventions below.
4. **Get it merged**: Once your PR passes CI and review, it is merged and your Drips points are recorded.

### Sprint cycle cadence

Stellar Wave runs in **two-week sprints**. Issues labelled for the current sprint are prioritised for review. Check the project board or issue comments for the active sprint tag.

### Finding Wave-eligible issues

| Filter | What it means |
|---|---|
| `good first issue` | Well-scoped, low-complexity tasks ideal for new contributors |
| `help wanted` | Explicitly open for community contributions |
| `complexity: 100` | Small tasks (~1–2 h); earn **100 Drips points** on merge |
| `complexity: 150` | Medium tasks (~3–4 h); earn **150 Drips points** on merge |
| `complexity: 200` | Larger tasks (~5+ h); earn **200 Drips points** on merge |

### Drips points table

| Complexity Score | Estimated effort | Drips points awarded |
|:-:|:-:|:-:|
| 100 | ~1–2 hours | 100 |
| 150 | ~3–4 hours | 150 |
| 200 | ~5+ hours | 200 |

Points are awarded **once per merged PR** on an issue carrying a `complexity` label. A single PR that closes multiple issues earns the sum of their individual scores.

---

## Stellar Wave Sprint Workflow

We are actively participating in the **Stellar Wave** program! Here's how you can earn Drips points for your contributions:

1. **Find an Issue**: Browse the [Issues](https://github.com/Nodal-stellar/Nodal-AI/issues) tab for tickets tagged `good first issue` (ideal for new contributors) or `help wanted`.
2. **Claim the Issue**: Comment on the issue to let maintainers know you're working on it.
3. **Submit a PR**: Follow the guidelines below and reference the issue in your PR.
4. **Earn Drips Points**: Once your PR is merged, you'll be eligible for Drips points!

---

## Branch Naming

Please use these prefixes for your branches:
- `feat/<description>`: New features
- `fix/<description>`: Bug fixes
- `docs/<description>`: Documentation updates
- `test/<description>`: Test additions or improvements
- `refactor/<description>`: Code refactoring

Example:
```bash
git checkout -b feat/33-add-dev-env-validation
```

---

## Commit Message Format

We follow the **Conventional Commits** specification. Your commit messages should be structured like this:

```
<type>(<scope>): <description>
```

Examples:
- `feat(#33): Add environment validation to dev.sh`
- `fix: Handle RPC timeouts gracefully`
- `docs: Update CONTRIBUTING.md with branch naming rules`
- `test: Add coverage for x402 payment tool`

---

## Pull Request Checklist

Before submitting your PR, make sure:
- ✅ All tests pass (`npm run test:all`, which runs `cargo test` for the escrow contract and the TypeScript suite)
- ✅ TypeScript compiles cleanly (`tsc --noEmit`)
- ✅ Linting passes (`npm run lint`)
- ✅ Formatting passes (`npm run format:check`) — run `npm run format` to auto-fix
- ✅ No secrets or private keys are in the diff
- ✅ You've referenced the issue number in your PR description

---

## Development Workflow

1. **Check Issues**: Browse the [Issues](https://github.com/Nodal-stellar/Nodal-AI/issues) tab for tickets tagged `good first issue` or `help wanted`.

2. **Create a Feature Branch**:
   ```bash
   git checkout -b feat/<issue-number>-<description>
   # Example: git checkout -b feat/30-github-actions-ci
   ```

3. **Make Your Changes**:
   - Follow the project structure in `README.md`
   - Ensure all tests pass: `npm run test:all`
   - Run the linter: `npm run lint`
   - Check formatting: `npm run format:check` (or `npm run format` to auto-fix)
   - For TypeScript changes, compile: `npm run build`
   - For Rust changes, test: `cargo test --manifest-path contracts/escrow/Cargo.toml`

4. **Commit with Clear Messages**:
   ```bash
   git commit -m "feat(#30): Add GitHub Actions CI workflow"
   ```

5. **Push and Open a Pull Request**:
   ```bash
   git push origin feat/<issue-number>-<description>
   ```

### Snapshot Tests

Vitest snapshot tests (e.g., `tests/__snapshots__/agent.test.ts.snap`) lock down the serialization contracts and payload shapes of `AgentResult` across tools to prevent breaking webhook consumers.

When your changes intentionally alter an output shape:
- Update snapshots intentionally using `npm run test:ts -- -u` or `npx vitest run -u <path-to-test>`.
- Review the diff in `tests/__snapshots__/*.snap` to ensure all modified fields are intentional and backwards-compatible.
- **Never update snapshots blindly** just to make tests pass; always commit the updated snapshots with your PR.

### Mutation & Fuzz Testing

Two optional quality tools go beyond the standard suite. Neither runs in CI by default — run them locally when you touch the code they target.

**Mutation testing** (`npm run test:mutation`) runs [Stryker](https://stryker-mutator.io/) against the TypeScript suite using `stryker.config.mjs`. Stryker mutates your source (flipping comparisons, removing conditionals, altering return values) and re-runs the tests to see whether they catch the change. A surviving mutant means a test gap. This is most valuable on **validation-heavy code** — Zod schemas and payment math — where a subtly wrong boundary or arithmetic branch can slip past tests that only assert the happy path. Run it when you add or change validation rules, amount/limit calculations, or anything in the payment tools, and use the surviving-mutant report to add the missing assertions.

**Fuzz testing** (`npm run test:fuzz`) runs the property-based tests under `tests/fuzz/` with Vitest. These feed randomized and edge-case inputs (malformed payloads, extreme amounts, boundary values) into the same validation and payment paths to surface crashes, unhandled rejections, and schema inputs that should be rejected but aren't. Run it when you change input schemas, parsing, or numeric handling, and add a fuzz case whenever you fix a bug that a random input could have caught.

---

## Adding a New Tool

The most common contribution to this repo is adding a new tool to the agent (e.g. a new Stellar operation). Follow this checklist rather than reverse-engineering the pattern from existing tools:

1. **Create `backend/tools/YourTool.ts`** with a Zod input schema, a class with an `execute()` (or similarly-named) method, and JSDoc on the exported schema/class. Look at `backend/tools/StellarPaymentTool.ts` for the shape: exported `YourToolInputSchema`, an inferred `YourToolInput` type, and a class that validates its input with `YourToolInputSchema.parse(rawInput)` before doing anything else.
2. **Add a new task type** to the `TaskType` union in `backend/agent.ts` (e.g. `"your_task"`).
3. **Import and instantiate your tool** in the `PayFiAgent` constructor in `backend/agent.ts`, alongside the existing tool instances (`paymentTool`, `sorobanTool`, `x402Tool`, etc.).
4. **Add a `case "your_task":`** to the `switch` in `PayFiAgent.run()` (`backend/agent.ts`) that delegates to your tool's execute method, matching the existing cases (`"stellar_payment"`, `"soroban_invoke"`, `"x402_respond"`, ...).
5. **Add a mock for your tool** in every test file's `vi.mock("../backend/tools/YourTool")` block that exercises `agent.ts` (e.g. wherever `PayFiAgent`/`run()` is tested), so agent-level tests don't hit the real network.
6. **Create `tests/your_tool.test.ts`** covering input validation (schema edge cases), the happy path, and network/error handling — see `tests/payment.test.ts` for the expected level of coverage (validation, happy path, network errors, retry exhaustion, state verification).
7. **Add an entry to the README's [API Reference](./README.md#api-reference) table** (`TaskType` union and the `PayFiAgent` method table) describing the new task type.
8. **Update [ARCHITECTURE.md](./ARCHITECTURE.md)'s** tool list and task-routing diagram/description so the new tool shows up alongside the others.

---

## Automated Checks

All pull requests are automatically validated by GitHub Actions. The CI workflow (`.github/workflows/ci.yml`) runs:

- **Build**: Compiles TypeScript with `npm run build`
- **Lint**: Enforces code style with `npm run lint` and formatting with `npm run format:check`
- **Test**: Runs the Rust contract tests and the TypeScript suite with `npm run test:all`
- **Test Rust**: Validates Soroban contracts with `

/* … truncated 8272 chars — edit only what you need near the top … */
