/**
 * scripts/doctor.ts
 *
 * Prerequisites checker for Nodal AI development environment.
 * Verifies that all required tools and versions are installed.
 *
 * Usage:
 *   npx ts-node scripts/doctor.ts
 *   npm run doctor
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

interface CheckResult {
  name: string;
  required: boolean;
  found: boolean;
  version?: string;
  details?: string;
  error?: string;
}

const REQUIRED_NODE_VERSION = 22;
const REQUIRED_RUST_TARGET = 'wasm32-unknown-unknown';

function runCommand(command: string): { stdout: string; error: string | null } {
  try {
    const stdout = execSync(command, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { stdout, error: null };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { stdout: '', error: err.stderr || err.message || String(error) };
  }
}

function checkNode(): CheckResult {
  const result = runCommand('node --version');
  if (result.error) {
    return {
      name: 'Node.js',
      required: true,
      found: false,
      error: 'Node.js not found in PATH',
    };
  }

  const version = result.stdout.replace('v', '');
  const majorVersion = parseInt(version.split('.')[0], 10);

  if (majorVersion < REQUIRED_NODE_VERSION) {
    return {
      name: 'Node.js',
      required: true,
      found: true,
      version: result.stdout,
      error: `Node.js ${REQUIRED_NODE_VERSION}+ required, found ${result.stdout}`,
    };
  }

  return {
    name: 'Node.js',
    required: true,
    found: true,
    version: result.stdout,
  };
}

function checkNpm(): CheckResult {
  const result = runCommand('npm --version');
  if (result.error) {
    return {
      name: 'npm',
      required: true,
      found: false,
      error: 'npm not found in PATH',
    };
  }

  return {
    name: 'npm',
    required: true,
    found: true,
    version: result.stdout,
  };
}

function checkRust(): CheckResult {
  const result = runCommand('rustc --version');
  if (result.error) {
    return {
      name: 'Rust',
      required: true,
      found: false,
      error: 'Rust not found. Install via: https://rustup.rs/',
    };
  }

  return {
    name: 'Rust',
    required: true,
    found: true,
    version: result.stdout,
  };
}

function checkWasmTarget(): CheckResult {
  const result = runCommand('rustup target list --installed');
  if (result.error) {
    return {
      name: 'Rust wasm32-unknown-unknown target',
      required: true,
      found: false,
      error: 'rustup not found. Install Rust first via: https://rustup.rs/',
    };
  }

  const hasTarget = result.stdout.includes(REQUIRED_RUST_TARGET);
  if (!hasTarget) {
    return {
      name: 'Rust wasm32-unknown-unknown target',
      required: true,
      found: false,
      error: `Required target not installed. Add with: rustup target add ${REQUIRED_RUST_TARGET}`,
    };
  }

  return {
    name: 'Rust wasm32-unknown-unknown target',
    required: true,
    found: true,
  };
}

function checkStellarCli(): CheckResult {
  const result = runCommand('stellar --version');
  if (result.error) {
    return {
      name: 'Stellar CLI',
      required: false,
      found: false,
      details: 'Optional. Install with: cargo install stellar-cli',
    };
  }

  return {
    name: 'Stellar CLI',
    required: false,
    found: true,
    version: result.stdout,
  };
}

function checkDocker(): CheckResult {
  const result = runCommand('docker --version');
  if (result.error) {
    return {
      name: 'Docker',
      required: false,
      found: false,
      details: 'Optional. Required for Docker-based development and testing',
    };
  }

  return {
    name: 'Docker',
    required: false,
    found: true,
    version: result.stdout,
  };
}

function checkGit(): CheckResult {
  const result = runCommand('git --version');
  if (result.error) {
    return {
      name: 'Git',
      required: true,
      found: false,
      error: 'Git not found in PATH',
    };
  }

  return {
    name: 'Git',
    required: true,
    found: true,
    version: result.stdout,
  };
}

function checkEnvFile(): CheckResult {
  const envPath = '.env';
  const exists = existsSync(envPath);

  if (!exists) {
    return {
      name: '.env file',
      required: false,
      found: false,
      details: 'Run `npm run setup` to create one from .env.example',
    };
  }

  return {
    name: '.env file',
    required: false,
    found: true,
  };
}

function printResult(result: CheckResult): void {
  const icon = result.found ? '✓' : '✗';
  const required = result.required ? '' : ' (optional)';
  const version = result.version ? ` - ${result.version}` : '';
  
  console.log(`${icon} ${result.name}${required}${version}`);

  if (result.error) {
    console.log(`  Error: ${result.error}`);
  }

  if (result.details) {
    console.log(`  ${result.details}`);
  }
}

function main(): void {
  console.log('Nodal AI — Prerequisites Check\n');

  const checks: CheckResult[] = [
    checkNode(),
    checkNpm(),
    checkGit(),
    checkRust(),
    checkWasmTarget(),
    checkStellarCli(),
    checkDocker(),
    checkEnvFile(),
  ];

  let hasErrors = false;
  let missingRequired = false;

  for (const check of checks) {
    printResult(check);
    if (check.error) {
      hasErrors = true;
      if (check.required) {
        missingRequired = true;
      }
    }
  }

  console.log('\n' + '='.repeat(60));

  if (missingRequired) {
    console.log('\n❌ Missing required prerequisites.');
    console.log('Please install the missing tools above before continuing.');
    process.exit(1);
  }

  if (hasErrors) {
    console.log('\n⚠️  Some optional tools are missing.');
    console.log('You can continue, but some features may not work.');
    process.exit(0);
  }

  console.log('\n✅ All prerequisites are installed!');
  console.log('\nNext steps:');
  console.log('  npm install');
  console.log('  npm run build');
  console.log('  npm run test:all');
  process.exit(0);
}

main();
