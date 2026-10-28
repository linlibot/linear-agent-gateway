import fs from 'node:fs/promises';

// CLI tools use the same password session and CSRF checks as the browser.
export async function openAdminSession(base, { username = process.env.LINEAR_ADMIN_USERNAME, passwordFile = process.env.LINEAR_ADMIN_PASSWORD_FILE } = {}) {
  if (!username || !passwordFile) throw new Error('Set LINEAR_ADMIN_USERNAME and LINEAR_ADMIN_PASSWORD_FILE after initializing the administrator in /login.');
  let password;
  try {
    if ((await fs.stat(passwordFile)).size > 4096) throw new Error();
    password = (await fs.readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  } catch { throw new Error('Cannot read the administrator password file (maximum 4096 bytes).'); }
  const response = await fetch(base + '/auth/login', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(10000) });
  password = undefined;
  const profile = await response.json();
  if (!response.ok) throw new Error(profile.error?.message ?? 'Administrator login failed.');
  let cookie = response.headers.get('set-cookie')?.split(';')[0], csrf = profile.csrf_token;
  if (!cookie || !csrf) throw new Error('Administrator login did not return a session.');
  async function request(route, body) {
    if (!cookie) throw new Error('Administrator session is closed.');
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Expected a local API path.');
    return fetch(base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json', ...(body === undefined ? {} : { 'x-csrf-token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  }
  return { request, async close() { try { if (cookie) { const result = await request('/auth/logout', {}); if (!result.ok) throw new Error('Administrator logout failed.'); } } finally { cookie = undefined; csrf = undefined; } } };
}
