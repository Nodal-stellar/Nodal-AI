## Summary

A brief description of the changes in this PR. What problem does it solve or what feature does it add?

## Changes

List the key changes made:
- Change 1
- Change 2
- Change 3

## Related Issues

Resolves #(issue number)

---

## Security Checklist

Please verify all security invariants before submitting:
- [ ] **No Secrets in Code or Logs**: Confirmed no private keys, seed phrases, API keys, or `.env` files are in the diff or emitted in test logs.
- [ ] **Input Validation**: All public functions and tool inputs are strictly validated (e.g. using Zod schemas or assert guards).
- [ ] **Spending Limits Respected**: Any payment or transaction flow invokes `assertWithinSpendingLimit()` before broadcasting to Stellar.
- [ ] **Soroban Authorization**: Smart contract invocations verify proper `Address::require_auth` without bypassing cryptographic checks.
- [ ] **Simulation Gates**: Non-payment Soroban operations execute simulation dry-runs before submission.

---

## Test Coverage

Describe the automated and manual testing performed:
- **Test Files Added / Modified**: `tests/...`
- **Unit Tests**: [ ] Added / [ ] Updated / [ ] N/A
- **Integration Tests**: [ ] Added / [ ] Updated / [ ] N/A
- **Commands Executed**:
  - `npm run test` (Vitest test suite)
  - `cargo test --manifest-path contracts/escrow/Cargo.toml` (Soroban unit tests)
- **Coverage Summary**: (Briefly note edge cases, failure branches, or mocks tested)

---

## Breaking Changes

- [ ] **None** (Fully backward compatible)
- [ ] **Yes** (Describe breaking API changes, parameter renames, or required configuration updates below)

---

## Contributor Checklist

Before submitting, please confirm:
- [ ] All tests pass locally
- [ ] TypeScript compiles cleanly (`tsc --noEmit` / `npm run build`)
- [ ] Linting passes (`npm run lint`)
- [ ] Commit messages follow Conventional Commits format
- [ ] Branch follows the naming convention (`feat/`, `fix/`, `docs/`, `test/`, `refactor/`)
- [ ] Documentation updated (`README.md`, `ARCHITECTURE.md`, `GLOSSARY.md` if applicable)

## Additional Notes

Any additional context or questions for reviewers.

