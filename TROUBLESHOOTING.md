# Troubleshooting

Common issues and solutions for setting up and running Nodal AI.

---

## Build & Installation

### `npm install` fails with native dependency errors

**Symptoms:** Errors mentioning `node-gyp`, `canvas`, or native module compilation.

**Solution:**
1. Ensure you have Node.js v18+ installed (`node --version`).
2. On macOS, install Xcode Command Line Tools: `xcode-select --install`.
3. On Ubuntu/Debian: `sudo apt install build-essential python3`.
4. Delete `node_modules` and `package-lock.json`, then re-run `npm install`.

### TypeScript compilation errors after pulling latest changes

**Solution:**
```bash
rm -rf node_modules dist
npm install
npm run build
```

---

## Environment & Configuration

### `ConfigError: AGENT_SECRET_KEY must start with 'S'`

**Cause:** The `.env` file contains an invalid or placeholder secret key.

**Solution:**
1. Generate a valid Stellar testnet keypair at [Stellar Laboratory](https://laboratory.stellar.org/#account-creator).
2. Copy the **Secret Key** (starts with `S`, 56 characters) into `.env`.
3. Fund the account on testnet using [Friendbot](https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY).

### `HORIZON_URL` or `SOROBAN_RPC_URL` connection refused

**Cause:** The RPC endpoint is unreachable, or you're behind a corporate proxy.

**Solution:**
- Verify the URL is correct for your target network (see `.env.example`).
- Test connectivity: `curl -s https://horizon-testnet.stellar.org/ | head -5`.
- If behind a proxy, configure `HTTP_PROXY` / `HTTPS_PROXY` environment variables.

---

## Tests

### Tests fail with `ECONNREFUSED` or `ETIMEDOUT`

**Cause:** Tests are trying to reach live Stellar endpoints, which may be down or rate-limited.

**Solution:**
- Run unit tests only (mocked): `npm run test:ts`.
- If running E2E tests, ensure your testnet account is funded and endpoints are reachable.

### Vitest hangs or times out

**Cause:** A test may have an unresolved promise or fake timer leak.

**Solution:**
1. Run with verbose output: `npx vitest run --reporter=verbose`.
2. Increase timeout temporarily: `npx vitest run --test-timeout=30000`.
3. Check that `vi.useRealTimers()` is called in afterEach hooks if fake timers are used.

---

## Soroban / Smart Contracts

### `cargo build` fails for contracts

**Solution:**
1. Ensure Rust is installed: `rustup --version`.
2. Install the Soroban target: `rustup target add wasm32-unknown-unknown`.
3. Install Soroban CLI: `cargo install --locked soroban-cli`.

### WASM size exceeds budget

**Cause:** The compiled contract exceeds the size limit defined in `contracts/escrow/WASM_SIZE_BUDGET.md`.

**Solution:**
- Review recent dependency additions for unnecessary bloat.
- Use `cargo build --release` with `opt-level = 'z'` for size-optimized builds.
- Run `scripts/check_wasm_size.sh` locally to verify.

---

## Docker

### `docker-compose up` fails to build

**Solution:**
1. Ensure Docker and Docker Compose v2+ are installed.
2. Copy `.env.example` to `.env` and fill in required values.
3. Rebuild without cache: `docker-compose build --no-cache`.

---

## Still Stuck?

- Search [existing issues](https://github.com/Nodal-stellar/Nodal-AI/issues) for similar problems.
- Open a new issue with your OS, Node.js version, error output, and steps to reproduce.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.
