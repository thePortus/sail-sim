#!/usr/bin/env node
/**
 * One-command player backup: logs in as the Owner (credentials read from the repo-root docker-compose.yml)
 * and downloads GET /user/export into server/seeders/import/users.json — the exact location the import
 * seeder restores from. So `npm run backup` produces a ready-to-restore backup with no manual steps.
 *
 *   cd server && npm run backup
 *
 * The Docker stack must be running (the nodejs container is hit on its host port). Override anything via env:
 *   OWNER_USERNAME, OWNER_PASSWORD  — credentials (default: parsed from docker-compose.yml)
 *   BACKUP_URL                      — server base URL (default: http://localhost:<nodejs host port>)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT     = path.resolve(__dirname, '..', '..');                 // repo root (docker-compose.yml lives here)
const COMPOSE  = path.join(ROOT, 'docker-compose.yml');
const OUT_DIR  = path.resolve(__dirname, '..', 'seeders', 'import');
const OUT_FILE = path.join(OUT_DIR, 'users.json');

const compose = (() => { try { return fs.readFileSync(COMPOSE, 'utf8'); } catch { return ''; } })();
const fromCompose = (key) => { const m = compose.match(new RegExp(`${key}\\s*=\\s*([^\\s#]+)`)); return m ? m[1] : null; };

const username = process.env.OWNER_USERNAME || fromCompose('OWNER_USERNAME');
const password = process.env.OWNER_PASSWORD || fromCompose('OWNER_PASSWORD');
const base = process.env.BACKUP_URL || `http://localhost:${(compose.match(/(\d+):8080/) || [, '9080'])[1]}`;

function fail(msg) { console.error(`[backup] ${msg}`); process.exit(1); }

if (typeof fetch !== 'function') fail(`Node 18+ required (global fetch). Yours: ${process.version}`);
if (!username || !password) fail('Missing OWNER_USERNAME/OWNER_PASSWORD (not in docker-compose.yml or env).');

async function main() {
  console.log(`[backup] Logging in as "${username}" at ${base} …`);
  let loginRes;
  try {
    loginRes = await fetch(`${base}/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch (err) {
    fail(`Could not reach ${base} (${err.code || err.message}). Is the Docker stack running?`);
  }
  if (!loginRes.ok) fail(`Login failed: HTTP ${loginRes.status} ${await loginRes.text().catch(() => '')}`);
  const { token, role } = await loginRes.json();
  if (!token) fail('Login returned no token.');
  if (role !== 'Owner') fail(`Account "${username}" is ${role}, not Owner — /export is owner-only.`);

  console.log('[backup] Downloading /user/export …');
  const expRes = await fetch(`${base}/user/export`, { headers: { Authorization: `Bearer ${token}` } });
  if (!expRes.ok) fail(`Export failed: HTTP ${expRes.status} ${await expRes.text().catch(() => '')}`);
  const json = await expRes.text();   // keep the server's pretty-printed JSON verbatim

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, json);
  let count = '?';
  try { count = (JSON.parse(json).users || []).length; } catch { /* leave as ? */ }
  console.log(`[backup] Saved ${count} player(s) → ${path.relative(ROOT, OUT_FILE)}`);
  console.log('[backup] Restore later with: cd server && npm run migrate   (the import seeder picks it up).');
}

main();
