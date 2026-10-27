import { isIP } from 'node:net';

export function readConfig(env = process.env) {
  const integer = (name, fallback, minimum = 1) => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const host = env.LINEAR_HOST || '127.0.0.1';
  if (!isIP(host)) throw new Error('Invalid LINEAR_HOST: use an IPv4 or IPv6 address.');
  const port = integer('LINEAR_PORT', 8089);
  if (port > 65535) throw new Error('Invalid LINEAR_PORT');
  return { host, port, pollMs: integer('LINEAR_POLL_MS', 1500, 500), timeoutMs: integer('LINEAR_TIMEOUT_MS', 180000, 1000) };
}
