Development & Testing
Backend (TypeScript)
The backend/ pillar contains the "Agent Brain." Use it to define tools and manage agent state.

npm run build: Compiles the TypeScript agent core.
Smart Contracts (Rust/Soroban)
The contracts/ pillar holds your escrow and payment logic.

cd contracts/escrow && cargo test: Run the suite of Soroban unit tests to ensure contract safety.
Integration Testing
We use Vitest to ensure the entire flow—from AI reasoning to network settlement—works as expected.

npm run test:ts: Executes the /tests suite (excluding E2E).
npm run test:ui: Runs the test suite with the interactive Vitest UI.
