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
const SIZES = [['1440', { width: 1440, height: 900 }], ['1024', { width: 1024, height: 768 }], ['768', { width: 768, height: 1024 }], ['390', { width: 390, height: 844 }]];
/** Screenshot at 1440 / 1024 / 768 / 390 wide (when SCREENSHOTS is set), then restore the desktop viewport. */
const shot = async (page, name, { settle = 0 } = {}) => {
  if (!SHOTS) return;
  for (const [label, size] of SIZES) {
    await page.setViewportSize(size);
    await page.waitForTimeout(settle || 350);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize(SIZES[0][1]);
};

// ------------------------------------------------------------------ the public pages
console.log('Public pages');
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
watch(page, 'console');

await page.goto(`${DASHBOARD}/`);
await page.waitForSelector('text=money that never drifts.');
ok('landing page renders');
if (SHOTS) {
  // scroll through so every in-view animation plays, then let the last ones finish
  for (let y = 0; y < 9000; y += 700) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(450); }
  await page.waitForTimeout(6000);
}
await page.waitForSelector('text=tested with violence.');
ok('landing page shows the chaos results section');
await shot(page, '01-landing', { settle: 800 });

await page.goto(`${DASHBOARD}/styleguide`);
await page.waitForSelector('text=style guide');
await page.waitForTimeout(SHOTS ? 5000 : 500);
await shot(page, '02-styleguide', { settle: 800 });
ok('style guide renders');

await page.goto(`${DASHBOARD}/this-does-not-exist`);
await page.waitForSelector("text=this account doesn’t exist in the books.");
await shot(page, '03-not-found');
ok('404 page speaks in the product voice');

// ------------------------------------------------------------------ the console
console.log('Console');
await page.goto(`${DASHBOARD}/login`);
await page.waitForSelector('text=Operator console');
await shot(page, '04-login');
expectedAuthFailure = true;
await page.fill('input[autocomplete=current-password]', 'definitely-wrong');
await page.click('button:has-text("Sign in")');
await page.waitForSelector('[role=alert]');
ok('wrong password is rejected with a visible error');
expectedAuthFailure = false;

await page.fill('input[autocomplete=current-password]', process.env.DASHBOARD_PASSWORD ?? 'zerodrift');
await page.click('button:has-text("Sign in")');
await page.waitForSelector('text=Recent payments');
ok('login works and lands on the overview');

const pages = [
  ['Overview', 'Money in system', '05-overview'],
  ['Payments', 'Newest first', '06-payments'],
  ['Accounts', 'Available', '07-accounts'],
  ['Ledger', 'double-entry', '08-ledger'],
  ['Webhooks', 'Deliveries', '09-webhooks'],
  ['Reconciliation', 'Latest internal run', '10-reconciliation'],
  ['Audit log', 'append-only', '11-audit'],
  ['Metrics', 'Gateway circuit', '12-metrics'],
  ['Chaos bench', 'chaos bench', '13-chaos-bench'],
];
for (const [title, text, name] of pages) {
  await page.click(`nav[aria-label=Main] >> text="${title}"`);
  try {
    await page.waitForSelector(`text=${text}`, { timeout: 15_000 });
    await page.waitForTimeout(SHOTS ? 2500 : 600); // let polled data render and entrance animations finish
    await shot(page, name);
    ok(`${title} page renders`);
  } catch {
    fail(`${title} page did not show "${text}"`);
    await shot(page, `${name}-FAILED`);
  }
}

// a ledger transaction opened into its journal (ink rows, bracket, BALANCED stamp)
await page.click('nav[aria-label=Main] >> text="Ledger"');
await page.waitForSelector('button[aria-expanded]');
await page.locator('button[aria-expanded]').first().click();
try {
  await page.waitForSelector('text=balanced', { timeout: 10_000 });
  await page.waitForTimeout(SHOTS ? 4000 : 1500);
  await shot(page, '14-ledger-journal');
  ok('an opened ledger transaction shows its journal and the BALANCED stamp');
} catch {
  fail('the ledger journal did not show a BALANCED stamp');
}

// a payment detail page, reached by clicking through
await page.click('nav[aria-label=Main] >> text="Payments"');
const row = page.locator('table tbody tr').first();
await row.waitFor({ timeout: 15_000 }).catch(() => undefined);
if (await row.count()) {
  await row.click();
  try {
    await page.waitForSelector('text=Timeline', { timeout: 10_000 });
    await page.waitForSelector('text=Journal', { timeout: 10_000 });
    await page.waitForTimeout(SHOTS ? 5000 : 1000);
    await shot(page, '15-payment-detail');
    ok('payment detail shows its state line, journal and timeline');
  } catch {
    fail('payment detail did not render');
  }
} else {
  fail('the payments table had no rows to open');
}

// a webhook delivery with its retry track
await page.click('nav[aria-label=Main] >> text="Webhooks"');
const drow = page.locator('table tbody tr').first();
await drow.waitFor({ timeout: 10_000 }).catch(() => undefined);
if (await drow.count()) {
  await drow.click();
  try {
    await page.waitForSelector('text=Attempts, to scale', { timeout: 10_000 });
    await page.waitForTimeout(SHOTS ? 3000 : 800);
    await shot(page, '16-webhook-delivery');
    ok('webhook delivery shows its attempts on a to-scale track');
  } catch {
    fail('webhook delivery did not render');
  }
}

// ------------------------------------------------------------------ the shop
console.log('Shop');
const shopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const shopPage = await shopCtx.newPage();
watch(shopPage, 'shop');
await shopPage.goto(SHOP);
await shopPage.waitForSelector('text=Add to cart');
await shopPage.waitForTimeout(SHOTS ? 1200 : 200);
await shot(shopPage, '17-shop-menu');
ok('menu renders');

await shopPage.click('button:has-text("+₹1,000.00")'); // add funds
try {
  await shopPage.waitForFunction(() => /Wallet\s*₹1,000\.00/.test(document.body.innerText), null, { timeout: 20_000 });
  ok('wallet top-up works (balance shows ₹1,000.00)');
} catch {
  fail(`wallet did not show the top-up. Page says: ${(await shopPage.innerText('body')).slice(0, 300).replace(/\n/g, ' | ')}`);
  await shot(shopPage, '18-shop-wallet-FAILED');
}

await shopPage.click('button[aria-label^="Add Assam Chai"]');
await shopPage.click('nav[aria-label=Main] >> text=/Cart/');
await shopPage.waitForSelector('text=Pay from wallet');
await shot(shopPage, '18-shop-cart');
await shopPage.click('text=Pay from wallet');
try {
  await shopPage.waitForSelector('text=Thank you, your order is confirmed', { timeout: 30_000 });
  await shopPage.waitForTimeout(SHOTS ? 4500 : 500); // the receipt finishes printing
  await shot(shopPage, '19-shop-order-paid');
  ok('checkout completes: order confirmed after the payment saga + webhook, receipt printed');
} catch {
  fail('order did not reach "paid" within 30s');
  await shot(shopPage, '19-shop-order-FAILED');
}

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nAll browser checks passed');
process.exit(problems.length ? 1 : 0);
