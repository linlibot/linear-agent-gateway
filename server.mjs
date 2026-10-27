import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGateway, ensureAccess } from './gateway.mjs';
import { AccountStore } from './accounts.mjs';
import { loadModelEntries, modelEntries } from './models.mjs';
import { AccountRouter } from './routing.mjs';

const runtimeDir = new URL('./.local-runtime/', import.meta.url);
const access = await ensureAccess(runtimeDir);
const sessionFile = process.env.LINEAR_SESSION_FILE ? path.resolve(process.env.LINEAR_SESSION_FILE) : fileURLToPath(new URL('./.local-runtime/linear-session.json', import.meta.url));
const accounts = new AccountStore(runtimeDir);
await accounts.initialize(sessionFile);
function positiveInt(name, fallback, minimum = 1) {
  if (!process.env[name]) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}
const port = positiveInt('LINEAR_PORT', 8089);
if (port > 65535) throw new Error('Invalid LINEAR_PORT');
const modelsProvider = async accountId => {
  const state = await accounts.state();
  const id = accountId ?? state.defaultAccountId;
  if (!id) return modelEntries();
  await accounts.get(id);
  return loadModelEntries(accounts.modelReportPath(id));
};
const accountRouter = new AccountRouter(accounts, { modelsProvider });
await accountRouter.initialize();
const server = createGateway({ apiKey: access.api_key, sessionFile, accountStore: accounts, accountRouter, modelsProvider, pollMs: positiveInt('LINEAR_POLL_MS', 1500, 500), timeoutMs: positiveInt('LINEAR_TIMEOUT_MS', 180000, 1000), onError: event => console.error(JSON.stringify(event)) });
server.listen(port, '127.0.0.1', () => {
  console.log(`Linear Agent gateway: http://127.0.0.1:${port}/v1`);
  console.log(`Local API key file: ${fileURLToPath(new URL('access.json', runtimeDir))}`);
});
server.on('error', error => { console.error(`Gateway startup failed: ${error.code ?? 'unknown'}`); process.exitCode = 1; });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await server.shutdown();
});
