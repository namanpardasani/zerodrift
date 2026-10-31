#!/usr/bin/env node
// Post-deploy smoke test of the PUBLIC surface of a running production stack (compose or Kubernetes): it proves what the
// internet can and cannot reach. Nothing is changed.
//   CONSOLE_URL=https://console.example.com SHOP_URL=https://shop.example.com API_URL=https://api.example.com node scripts/verify-prod-stack.mjs
// (SHOP_URL optional. For a local test with self-signed certificates set NODE_TLS_REJECT_UNAUTHORIZED=0.)
const base = (k) => process.env[k]?.replace(/\/$/, '');
const CONSOLE = base('CONSOLE_URL');
const SHOP = base('SHOP_URL');
const API = base('API_URL');
if (!CONSOLE || !API) {
  console.error('CONSOLE_URL and API_URL are required.');
  process.exit(2);
}
let failures = 0;
const get = async (url, init) => {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
    return { status: r.status, headers: r.headers, text: await r.text().catch(() => '') };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e.cause?.code ?? e.message) };
  }
};
const expect = async (what, url, want, init) => {
  const r = await get(url, init);
  const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}  (${init?.method ?? 'GET'} ${new URL(url).pathname} -> ${r.status || r.text}, wanted ${want})`);
  if (!ok) failures++;
  return r;
};

console.log('Public pages');
await expect('landing page', `${CONSOLE}/`, 200);
const home = await get(`${CONSOLE}/`);
const csp = home.headers.get('content-security-policy') ?? '';
console.log(`  ${csp.includes("default-src 'self'") && home.headers.get('x-frame-options') === 'DENY' ? 'ok  ' : 'FAIL'} security headers (CSP default-src 'self', X-Frame-Options DENY)`);
if (!(csp.includes("default-src 'self'") && home.headers.get('x-frame-options') === 'DENY')) failures++;
await expect('console login page', `${CONSOLE}/login`, 200);
const st = await get(`${CONSOLE}/api/public/status`);
const body = (() => { try { return JSON.parse(st.text); } catch { return {}; } })();
console.log(`  ${st.status === 200 && body.available === true && body.ok === true && body.driftMinor === '0' ? 'ok  ' : 'FAIL'} the books balance right now (public status: ${st.text.slice(0, 90)})`);
if (!(st.status === 200 && body.available === true && body.ok === true && body.driftMinor === '0')) failures++;
if (SHOP) await expect('demo shop', `${SHOP}/`, 200);

console.log('\nWhat the internet must NOT reach');
await expect('console API needs a login', `${CONSOLE}/api/overview`, 401);
await expect('console API rejects a forged token', `${CONSOLE}/api/overview`, 401, { headers: { authorization: 'Bearer not.a.token' } });
await expect('the chaos bench is not available', `${CONSOLE}/api/chaos/status`, 401);
await expect('operator route /admin/merchants is not routed', `${API}/admin/merchants`, 404);
await expect('internal route /internal/recovery/run is not routed', `${API}/internal/recovery/run`, 404, { method: 'POST' });
await expect('/metrics is not routed', `${API}/metrics`, 404);
await expect('unknown path is a plain 404', `${API}/nothing`, 404);

console.log('\nThe merchant API is up and authenticated');
await expect('payments API refuses a request without a key', `${API}/v1/payments`, 401, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
await expect('webhook API refuses a request without a key', `${API}/v1/webhook-endpoints`, 401);
await expect('payments API refuses a made-up key', `${API}/v1/me`, 401, { headers: { authorization: 'Bearer zd_live_madeup' } });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nThe public surface is as intended');
process.exit(failures ? 1 : 0);
