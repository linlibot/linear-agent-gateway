import fs from 'node:fs/promises';
import { readConfig } from '../config.mjs';
import { openAdminSession } from './admin-session.mjs';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-har.mjs <local.har-or-session.json> [account-label]');
const credential = await fs.readFile(source, 'utf8');
const session = await openAdminSession(`http://127.0.0.1:${readConfig().port}`);
try {
  const response = await session.request('/v1/accounts/import', { credential, label: process.argv[3] ?? '' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Account import failed. Start the gateway before importing.');
  console.log(JSON.stringify({ updated: result.updated, account: result.account }));
} finally { await session.close(); }
