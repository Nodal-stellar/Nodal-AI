/**
 * scripts/doctor.ts
 *
 * Diagnostic script that verifies the local development environment against
 * the prerequisites required for running and testing Nodal AI.
 *
 * Usage:
 *   npx ts-node scripts/doctor.ts
 *   npm run doctor
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

interface CheckResult {
  category: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  remedy?: string;
}

const results: CheckResult[] = [];

function checkNode(): void {
  const current = process.version;
  const major = parseInt(current.slice(1).split('.')[0] || '0', 10);
  if (major >= 20) {
    results.push({
      category: 'Runtime',
      name: 'Node.js Version',
      status: 'ok',
      message: `${current} (>= 20 required)`,
    });
  } else {
    results.push({
      category: 'Runtime',
      name: 'Node.js Version',
      status: 'error',
      message: `${current} is below the required Node.js 20 LTS`,
      remedy: 'Install Node.js 20 or later from https://nodejs.org',
    });
  }
}

function checkNpm(): void {
  try {
    const version = execSync('npm --version', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    results.push({
      category: 'Tooling',
      name: 'npm',
      status: 'ok',
      message: `v${version}`,
    });
  } catch {
    results.push({
      category: 'Tooling',
      name: 'npm',
      status: 'error',
      message: 'npm is not accessible in PATH',
      remedy: 'Ensure npm is installed with Node.js',
    });
  }
}

function checkGit(): void {
  try {
    const version = execSync('git --version', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    results.push({
      category: 'Tooling',
      name: 'Git',
      status: 'ok',
      message: version,
    });
  } catch {
    results.push({
      category: 'Tooling',
      name: 'Git',
      status: 'error',
      message: 'git command not found',
      remedy: 'Install Git from https://git-scm.com',
    });
  }
}

function checkEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  const examplePath = resolve(process.cwd(), '.env.example');

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    const hasNetwork = /STELLAR_NETWORK\s*=/i.test(content);
    const hasKey = /AGENT_SECRET_KEY\s*=/i.test(content);

    if (hasNetwork && hasKey) {
      results.push({
        category: 'Config',
        name: '.env configuration',
        status: 'ok',
        message: 'Present with core Stellar configuration',
      });
    } else {
      results.push({
        category: 'Config',
        name: '.env configuration',
        status: 'warn',
        message: 'Present, but may be missing STELLAR_NETWORK or AGENT_SECRET_KEY',
        remedy: 'Run `npm run setup` to configure missing variables interactively',
      });
    }
  } else if (existsSync(examplePath)) {
    results.push({
      category: 'Config',
      name: '.env configuration',
      status: 'warn',
      message: 'Missing .env file (found .env.example)',
      remedy: 'Run `npm run setup` or `cp .env.example .env`',
    });
  } else {
    results.push({
      category: 'Config',
      name: '.env configuration',
      status: 'error',
      message: 'Neither .env nor .env.example found in root directory',
      remedy: 'Create a .env file with your network configuration',
    });
  }
}

function checkRust(): void {
  try {
    const version = execSync('cargo --version', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    results.push({
      category: 'Contracts (Optional)',
      name: 'Rust / Cargo',
      status: 'ok',
      message: version,
    });
  } catch {
    results.push({
      category: 'Contracts (Optional)',
      name: 'Rust / Cargo',
      status: 'warn',
      message: 'Cargo not found. Only needed if building and testing Soroban contracts locally',
      remedy: 'Install Rust from https://rustup.rs if you wish to run `npm run test:rust`',
    });
  }
}

function checkStellarCli(): void {
  try {
    const version = execSync('stellar --version', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    results.push({
      category: 'Contracts (Optional)',
      name: 'Stellar CLI',
      status: 'ok',
      message: version,
    });
  } catch {
    results.push({
      category: 'Contracts (Optional)',
      name: 'Stellar CLI',
      status: 'warn',
      message: 'Stellar CLI not found. Required for deploying Soroban contracts to testnet',
      remedy: 'Install via `cargo install --locked stellar-cli` or brew install stellar-cli',
    });
  }
}

function main(): void {
  console.log('\n🔍 Nodal AI Development Environment Doctor\n' + '='.repeat(45));

  checkNode();
  checkNpm();
  checkGit();
  checkEnv();
  checkRust();
  checkStellarCli();

  let hasError = false;

  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} [${r.category}] ${r.name}: ${r.message}`);
    if (r.remedy) {
      console.log(`   👉 Fix: ${r.remedy}`);
    }
    if (r.status === 'error') {
      hasError = true;
    }
  }

  console.log('='.repeat(45));
  if (hasError) {
    console.log('❌ Environment check failed. Please resolve the errors above.\n');
    process.exit(1);
  } else {
    console.log(
      '✨ All required dependencies are satisfied! You are ready to build and contribute.\n'
    );
  }
}

main();
