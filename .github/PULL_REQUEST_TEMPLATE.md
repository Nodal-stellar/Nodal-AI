## Description

<!-- Summarise what this PR does and why. Reference the issue it closes. -->

Closes #

---

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation update
- [ ] CI / tooling change
- [ ] Other (describe below)

---

## PR Checklist

- [ ] All tests pass (`npm run test` and `cargo test --manifest-path contracts/escrow/Cargo.toml`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] Linting passes (`npm run lint`)
- [ ] No secrets or private keys are in the diff
- [ ] Issue number is referenced above

---

## Security Checklist

- [ ] No secrets, private keys, or tokens are logged or exposed in output
- [ ] All external inputs are validated (e.g. via Zod schemas) before use
- [ ] Spending limits (`AGENT_SPENDING_LIMIT`, mainnet cap) are respected and not bypassed
- [ ] Authentication / authorisation paths are unchanged, or changes have been reviewed for correctness
- [ ] New environment variables are added to `.env.example` and validated in `backend/config.ts`

---

## Test Coverage

<!-- Describe what tests were added or updated. If no tests were added, explain why. -->

- **New tests:**
- **Updated tests:**
- **Why no tests (if applicable):**

---

## Breaking Changes

- [ ] This PR introduces a breaking change

<!-- If checked, describe what breaks and what callers / consumers need to update. -->

---

## Additional Notes

<!-- Anything else reviewers should know: deployment steps, follow-up issues, known limitations. -->
