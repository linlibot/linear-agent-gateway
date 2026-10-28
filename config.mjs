import { isIP } from 'node:net';

export function readConfig(env = process.env) {
  const integer = (name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const choice = (name, fallback, values) => {
    if (!env[name]) return fallback;
    if (!values.includes(env[name])) throw new Error(`Invalid ${name}: use ${values.join(' or ')}.`);
    return env[name];
  };
  const host = env.LINEAR_HOST || '127.0.0.1';
  if (!isIP(host)) throw new Error('Invalid LINEAR_HOST: use an IPv4 or IPv6 address.');
  const port = integer('LINEAR_PORT', 8089);
  if (port > 65535) throw new Error('Invalid LINEAR_PORT');
  return {
    host, port, pollMs: integer('LINEAR_POLL_MS', 1500, 500), timeoutMs: integer('LINEAR_TIMEOUT_MS', 180000, 1000),
    maxConcurrency: integer('LINEAR_MAX_CONCURRENCY', 4, 1, 64),
    accountConcurrency: integer('LINEAR_ACCOUNT_CONCURRENCY', 1, 1, 16),
    maxQueue: integer('LINEAR_MAX_QUEUE', 8, 1, 1000),
    maxBodyBytes: integer('LINEAR_MAX_BODY_BYTES', 8 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024),
    chat: {
      clientTools: choice('LINEAR_CLIENT_TOOLS', 'structured', ['structured', 'off']),
      streamMode: choice('LINEAR_STREAM_MODE', 'incremental', ['incremental', 'buffered']),
      toolContinuation: choice('LINEAR_TOOL_CONTINUATION', 'native', ['native', 'replay']),
      promptFormat: choice('LINEAR_PROMPT_FORMAT', 'rich', ['rich', 'plain']),
      toolRepairAttempts: integer('LINEAR_TOOL_REPAIR_ATTEMPTS', 1, 0, 3),
      strictParameters: choice('LINEAR_STRICT_PARAMETERS', '0', ['0', '1']) === '1',
      maxPromptChars: integer('LINEAR_MAX_PROMPT_CHARS', 1_000_000, 10_000, 20_000_000),
    },
    toolSessions: {
      ttlSeconds: integer('LINEAR_TOOL_SESSION_TTL_SECONDS', 86400, 60, 30 * 86400),
      idempotencySeconds: integer('LINEAR_IDEMPOTENCY_SECONDS', 300, 0, 86400),
    },
  };
}
