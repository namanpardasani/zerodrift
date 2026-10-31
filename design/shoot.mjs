// Screenshot every plate of the design reference (run inside the e2e image, see design/README.md).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const src = process.env.REF_URL ?? 'file:///design/zerodrift-design-reference.html';
const out = '/shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [label, width] of [['1440', 1440], ['390', 390]]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(src, { waitUntil: 'networkidle' });
  const plates = await page.$$('[data-run]');
  let i = 1;
  for (const p of plates) {
    const name = await p.getAttribute('data-run');
    await p.scrollIntoViewIfNeeded();
    await page.waitForTimeout(name === 'chaos' ? 600 : 9500); // let the plate's animation finish
    await p.screenshot({ path: `${out}/${String(i).padStart(2, '0')}-${name}-${label}.png` });
    i++;
  }
  await page.close();
}
await browser.close();
