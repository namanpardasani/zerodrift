// Browser smoke test against the RUNNING stack (docker compose up -d --build).
//   node e2e/smoke.mjs            -> checks every page, drives a real shop checkout
//   SCREENSHOTS=dir node ...      -> also saves a screenshot of each page
// Fails (exit 1) on any page error, console error, failed API call or missing content.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3008';
const SHOP = process.env.SHOP_URL ?? 'http://localhost:3009';
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const problems = [];
let expectedAuthFailure = false; // the wrong-password step deliberately provokes a 401, which browsers log as a console error
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => {
  problems.push(msg);
  console.log(`  FAIL ${msg}`);
};

const browser = await chromium.launch();
const watch = (page, label) => {
  page.on('pageerror', (e) => fail(`${label}: uncaught error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && !(expectedAuthFailure && /401/.test(m.text())) && fail(`${label}: console error: ${m.text()}`));
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if ((u.pathname.startsWith('/api') || u.pathname.startsWith('/auth')) && r.status() >= 500) {
      const body = await r.text().catch(() => '');
      fail(`${label}: ${r.request().method()} ${u.pathname} -> HTTP ${r.status()} ${body.slice(0, 200)}`);
    }
  });
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && fail(`${label}: request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`));
};
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }));

// ------------------------------------------------------------------ the console
console.log('Console');
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
watch(page, 'console');

await page.goto(DASHBOARD);
await page.waitForSelector('text=Console');
await shot(page, '01-login');
expectedAuthFailure = true;
await page.fill('input[autocomplete=current-password]', 'definitely-wrong');
await page.click('button:has-text("Sign in")');
await page.waitForSelector('[role=alert]');
ok('wrong password is rejected with a visible error');
expectedAuthFailure = false;

await page.fill('input[autocomplete=current-password]', process.env.DASHBOARD_PASSWORD ?? 'zerodrift');
await page.click('button:has-text("Sign in")');
await page.waitForSelector('text=Operator console');
ok('login works');

const pages = [
  ['/', 'Overview', 'Services', '02-overview'],
  ['/payments', 'Payments', 'Newest first', '03-payments'],
  ['/accounts', 'Accounts', 'Available', '04-accounts'],
  ['/ledger', 'Ledger', 'double-entry', '05-ledger'],
  ['/webhooks', 'Webhooks', 'Deliveries', '06-webhooks'],
  ['/reconciliation', 'Reconciliation', 'Latest internal run', '07-reconciliation'],
  ['/audit', 'Audit log', 'append-only', '07b-audit'],
  ['/metrics', 'Metrics', 'Gateway circuit', '08-metrics'],
  ['/chaos', 'Chaos', 'Mock bank faults', '09-chaos'],
];
for (const [path, title, text, name] of pages) {
  await page.click(`nav[aria-label=Main] >> text="${title}"`);
  try {
    await page.waitForSelector(`text=${text}`, { timeout: 15_000 });
    await page.waitForTimeout(600); // let polled data render
    await shot(page, name);
    ok(`${title} page renders (${path})`);
  } catch {
    fail(`${title} page did not show "${text}"`);
    await shot(page, `${name}-FAILED`);
  }
}

// a payment detail page, reached by clicking through
await page.click('nav[aria-label=Main] >> text="Payments"');
const row = page.locator('table tbody tr').first();
if (await row.count()) {
  await row.click();
  try {
    await page.waitForSelector('text=Timeline', { timeout: 10_000 });
    await shot(page, '10-payment-detail');
    ok('payment detail page shows its timeline');
  } catch {
    fail('payment detail did not render');
  }
}

// ------------------------------------------------------------------ the shop
console.log('Shop');
const shopPage = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
watch(shopPage, 'shop');
await shopPage.goto(SHOP);
await shopPage.waitForSelector('text=Add to cart');
await shot(shopPage, '11-shop-home');
ok('product grid renders');

await shopPage.click('button:has-text("+₹1,000.00")'); // add funds
try {
  await shopPage.waitForFunction(() => /Wallet:\s*₹1,000\.00/.test(document.body.innerText), null, { timeout: 20_000 });
  ok('wallet top-up works (balance shows ₹1,000.00)');
} catch {
  fail(`wallet did not show the top-up. Page says: ${(await shopPage.innerText('body')).slice(0, 300).replace(/\n/g, ' | ')}`);
  await shot(shopPage, '12-shop-wallet-FAILED');
}

await shopPage.click('button[aria-label^="Add Assam Chai"]');
await shopPage.click('nav[aria-label=Main] >> text=/Cart/');
await shopPage.waitForSelector('text=Pay from wallet');
await shot(shopPage, '12-shop-cart');
await shopPage.click('text=Pay from wallet');
try {
  await shopPage.waitForSelector('text=Thank you, your order is confirmed', { timeout: 30_000 });
  await shot(shopPage, '13-shop-order-paid');
  ok('checkout completes: order confirmed after the payment saga + webhook');
} catch {
  fail('order did not reach "paid" within 30s');
  await shot(shopPage, '13-shop-order-FAILED');
}

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nAll browser checks passed');
process.exit(problems.length ? 1 : 0);
