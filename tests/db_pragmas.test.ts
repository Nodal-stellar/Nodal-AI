/**
 * tests/db_pragmas.test.ts
 *
 * #962 — the shared SQLite connection didn't set journal_mode=WAL or
 * busy_timeout, so the health server, SSE polling and the agent contended
 * for one rollback-journal database and could hit SQLITE_BUSY under load.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const { DB_PATH } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require('path');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require('os');
  return {
    DB_PATH: nodePath.join(nodeOs.tmpdir(), `nodal-pragma-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../backend/config', () => ({
  config: { DB_PATH },
}));

import { getDb, closeDb } from '../backend/persistence';

function cleanupDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(DB_PATH + suffix);
    } catch {
      // Not present — fine.
    }
  }
}

afterAll(() => {
  closeDb();
  cleanupDbFiles();
});

describe('shared SQLite connection pragmas (#962)', () => {
  it('sets journal_mode=WAL, busy_timeout=5000 and foreign_keys=ON', () => {
    const db = getDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('a concurrent writer does not throw SQLITE_BUSY while this connection holds a write lock', async () => {
    const db = getDb();

    // Hold a write lock open, as a slow transaction on this connection would.
    db.prepare('BEGIN IMMEDIATE').run();
    db.prepare(
      `INSERT INTO agent_results (timestamp, taskType, success) VALUES (?, 'holder', 1)`
    ).run(new Date().toISOString());

    // A second, independent connection (simulating another instance/handle
    // sharing this database file) tries to write while the lock is held.
    // Spawned as a real child process so it runs concurrently with this
    // one instead of blocking the same event loop.
    const childScript = `
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1]);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        db.prepare("INSERT INTO agent_results (timestamp, taskType, success) VALUES (?, 'child', 1)").run(new Date().toISOString());
        db.close();
      `;
    const child = spawn(process.execPath, ['-e', childScript, DB_PATH], {
      cwd: path.resolve(__dirname, '..'),
    });
    const childDone = new Promise<number>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`));
        else resolve(code);
      });
    });

    // Release the lock shortly after the child starts waiting on it — its
    // busy_timeout (5s) comfortably covers this delay.
    setTimeout(() => db.prepare('COMMIT').run(), 150);

    await expect(childDone).resolves.toBe(0);

    const rows = db.prepare(`SELECT taskType FROM agent_results ORDER BY id`).all() as Array<{
      taskType: string;
    }>;
    expect(rows.map((r) => r.taskType)).toEqual(['holder', 'child']);
  }, 10_000);
});
