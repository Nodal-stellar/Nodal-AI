# Installation

## Prerequisites

Before you begin, ensure you have the following installed:

### Required

- **Node.js** 22 or later ([Download](https://nodejs.org/))
- **npm** (comes with Node.js)
- **Git** ([Download](https://git-scm.com/))
- **Rust** toolchain with `wasm32-unknown-unknown` target ([Install via rustup](https://rustup.rs/))
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup target add wasm32-unknown-unknown
  ```

### Optional

- **Stellar CLI** - For contract deployment and advanced operations
  ```bash
  cargo install stellar-cli
  ```
- **Docker** - For containerized development and testing ([Download](https://www.docker.com/))

### Quick Check

Run the built-in doctor script to verify your environment:

```bash
npm run doctor
```

This checks that all required tools are installed at the correct versions.

## Install Dependencies

```bash
npm install
```

## Build the Project

```bash
npm run build
```

## Run Tests

```bash
npm run test:all
```

> **Note:** `npm run test:all` runs both TypeScript and Rust tests. For TypeScript-only verification, use `npm run test:ts`.

## Development Setup

For development, you can run the TypeScript compiler in watch mode:

```bash
npm run typecheck
```

## Next Steps

- [Quick Start](./quick-start.md) - Build your first agent
