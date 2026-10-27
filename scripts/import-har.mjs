import fs from 'node:fs/promises';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-har.mjs <local.har-or-session.json> [account-label]');
const credential = await fs.readFile(source, 'utf8');
const { api_key } = JSON.parse(await fs.readFile(new URL('../.local-runtime/access.json', import.meta.url), 'utf8'));
const response = await fetch(`http://127.0.0.1:${process.env.LINEAR_PORT ?? 8089}/v1/accounts/import`, {
  method: 'POST', headers: { authorization: 'Bearer ' + api_key, 'content-type': 'application/json' },
  body: JSON.stringify({ credential, label: process.argv[3] ?? '' }), signal: AbortSignal.timeout(30000),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error?.message ?? 'Account import failed. Start the gateway before importing.');
console.log(JSON.stringify({ updated: result.updated, account: result.account }));
