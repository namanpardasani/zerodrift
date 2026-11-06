# Manual test guide

A click-by-click checklist for testing every feature by hand on your machine, with what you should see. Takes about 25 minutes. Do it once before you deploy.

## 0. Start it (2 minutes)

```bash
pnpm start:local          # builds if needed, starts everything, waits until it is really ready, seeds demo data once, prints the URLs
```

(`BUILD=0 pnpm start:local` reuses images you already built; `pnpm stop:local` stops it and keeps your data.)

| Open | Login |
|---|---|
| http://localhost:3008 landing page | none |
| http://localhost:3008/app operator console | `admin` / `zerodrift` |
| http://localhost:3009 demo shop (Café Aman) | none |

**Quick automatic check first:** `pnpm verify:features` runs 46 checks against the live stack through the same APIs the screens use (payments, idempotency, refunds, webhooks, recovery, reconciliation, rate limits, the console, the shop, a service kill). Expect `46 of 46 checks passed`. Then use this guide to *see* the same things on screen.

## 1. Landing page (http://localhost:3008)

- [ ] The top bar is one slim line: wordmark, `how it works`, `chaos results`, `docs ↗`, `github ↗`, a pill, and an orange **open console** button.
- [ ] The pill says **books balanced · drift ₹0.00** with a blinking green dot. This is read live from the ledger. (Stop the ledger with `docker compose stop ledger`, reload: it must say **status unavailable**, never a made-up zero. Start it again.)
- [ ] The drift needle swings in and settles on **0**; the receipt prints out of the slot.
- [ ] Scroll: the link of the section you are in gets an orange underline; the bar stays on top. Click `chaos results`: it glides there.
- [ ] Sections animate in as you reach them: the API call "types in", the transfer card rises, the double-tap request is stamped **ALREADY PAID**, the webhook retry dots travel, the reconciliation rows zip together. Each has a **replay** button.
- [ ] The chaos results section shows the real numbers (60,000 operations, 167 faults, 54/54 invariants) and a run table.
- [ ] Narrow the window to phone width: the bar becomes wordmark + a small status pill + a menu button; the menu opens a sheet; **Escape** or a tap closes it.

## 2. Demo shop (http://localhost:3009)

1. [ ] Click **+₹1,000.00** (wallet bar). The wallet shows ₹1,000.00.
2. [ ] Add **Assam Chai** (≈₹349) to the cart, open **Cart**, press **Pay from wallet**.
3. [ ] You see "handing off to Zerodrift…", then the **Order** page: **Paid**, "Thank you…", and a **thermal receipt printing** line by line. **Print** and **Download .txt** work.
4. [ ] The wallet dropped by the price.
5. **Insufficient funds:** add the ₹1,499 Cotton Kurta with only ₹1,000 in the wallet, pay. Expect **Payment failed**, "Your wallet balance was too low", and you were **not charged**.
6. **Double click:** add an item, double-click **Pay from wallet** quickly. Expect ONE order, not two (Orders page), charged once.
7. [ ] **Orders** lists them with a status dot (green paid, red failed).

## 3. Operator console (http://localhost:3008/app, `admin` / `zerodrift`)

- [ ] A wrong password shows an error and does not log you in. After about 5 wrong attempts you get "Too many failed logins, try again later" (HTTP 429).
- [ ] **Overview:** Money in system, Drift **₹0.00** with a tiny needle on zero and "steady: every transaction balances", payments last 24 h, success rate, and a **live recent-payments table**. Pay in the shop in another tab: a new row **slides in at the top** within 2 seconds.
- [ ] **Payments:** the list, filter by status ("settled" is the word for succeeded). Click one.
- [ ] **Payment detail:** the state line fills station by station (created, processing, settled); the **journal** rows write in like ink, a bracket is drawn, a blue **BALANCED** stamp lands; the **receipt** prints on the right (Print / Download work); the timeline lists every status change; the fee and refunds are shown.
- [ ] **Ledger:** click any row to expand its journal (debits red, credits ink, BALANCED stamp). Paste a transaction id into the lookup. **Load older** pages back.
- [ ] **Accounts:** balances; click one for its entries. The gateway clearing account is negative by exactly the money topped up.
- [ ] **Webhooks:** the delivery list and stats. Click a delivery: the **attempts drawn to scale** (dots on a line, the gaps are the real waiting times) and the attempt log; press **Replay**: a new attempt appears.
- [ ] **Reconciliation:** press **Run internal**, then **Run external**: both finish **clean**. Select a run to see its report.
- [ ] **Audit log:** who did what (merchant created, payment created, top-ups, recovery runs...). It is append-only.
- [ ] **Metrics:** needs Prometheus, which is optional and not started by default (`FULL=1 pnpm start:local` adds it, plus Grafana and Jaeger). Without it the page says "Prometheus is not reachable", which is expected.
- [ ] **Settings:** who you are, services up with latency.
- [ ] A bad address (`/app/nothing`, `/nothing`) shows "this account doesn't exist in the books." with a way back.
- [ ] Phone width: a slim top bar with a menu button that opens a two-column sheet of every page.

## 4. Things that should be safe to repeat (idempotency, refunds)

Create a merchant and a customer (the seed already printed API keys; or):

```bash
A='x-admin-token: dev-admin-token'
KEY=$(curl -s -X POST localhost:3002/admin/merchants -H "$A" -H 'content-type: application/json' -d '{"name":"My test shop"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).apiKey')
H="authorization: Bearer $KEY"
curl -s -X POST localhost:3002/v1/customers -H "$H" -H 'content-type: application/json' -d '{"customerId":"me"}'
curl -s -X POST localhost:3002/v1/customers/me/topups -H "$H" -H 'content-type: application/json' -H 'idempotency-key: tu-1' -d '{"amountMinor":"500000"}'
```

- [ ] **Same request twice, same key** gives the same payment and charges once:
  ```bash
  for i in 1 2 3; do curl -s -X POST localhost:3002/v1/payments -H "$H" -H 'content-type: application/json' -H 'idempotency-key: order-1' -d '{"customerId":"me","amountMinor":"34900"}' | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.id+" "+j.status'; done
  ```
  Three identical ids. Open that payment in the console: **"A duplicate request was absorbed"** with the ALREADY PAID animation and a counter of 2.
- [ ] **Same key, different amount** is refused: repeat with `"amountMinor":"35000"` and key `order-1`: HTTP **422**.
- [ ] **Refund:** `curl -s -X POST localhost:3002/v1/payments/<id>/refunds -H "$H" -H 'content-type: application/json' -H 'idempotency-key: rf-1' -d '{"amountMinor":"10000"}'`. The payment becomes **partially refunded** and the customer's wallet gets ₹100 back plus a proportional share of the fee. Repeat the call (same key): no second refund. Refund the rest (`-d '{}'` with a new key): **refunded**. Try to refund more than is left: refused.

## 5. When the bank misbehaves (the bank is a mock with fault knobs)

- [ ] **Declined:** `curl -X PUT localhost:3005/admin/faults -H 'content-type: application/json' -d '{"declineRate":1}'`, pay: the payment **fails** and the wallet is untouched. Reset: `curl -X POST localhost:3005/admin/faults/reset`.
- [ ] **The bank charges but its answer is lost** (the worst case): `... -d '{"lostResponseRate":1}'`, pay, then reset. The payment shows **processing** (HTTP 202) and the customer's money is **held, not lost**. Within about a minute (or press recovery: `curl -X POST localhost:3002/internal/recovery/run -H "$A" -H 'content-type: application/json' -d '{}'`) the payment becomes **settled**: recovery *asked the bank* what really happened. The wallet is debited exactly once.

## 6. Webhooks you can see arrive

The local stack has a demo receiver (http://localhost:3007/received lists everything it got).

- [ ] Register an endpoint for your test merchant, tell the receiver to trust its secret, and pay:
  ```bash
  SECRET=$(curl -s -X POST localhost:3003/v1/webhook-endpoints -H "$H" -H 'content-type: application/json' -d '{"url":"http://demo-receiver:3007/webhooks","eventTypes":["payment.succeeded"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).secret')
  curl -s -X POST localhost:3007/admin/secrets -H 'content-type: application/json' -d "{\"secrets\":[\"$SECRET\"]}"
  ```
  Pay, then open http://localhost:3007/received: a `payment.succeeded` with outcome `ok`.
- [ ] **Retry:** `curl -X POST localhost:3007/admin/behavior -H 'content-type: application/json' -d '{"failNext":1}'`, pay. The first attempt fails; the console's delivery page shows attempt 1 failing and attempt 2 succeeding after a short wait. Reset with `{"failNext":0}`.

## 7. Chaos bench (console, "Chaos bench" in the sidebar; test mode only)

- [ ] The six module tiles (payments, ledger, webhooks, gateway, kafka, network) show real status with green LEDs; the big dial shows drift **0**.
- [ ] Press **kill** on `webhooks`: the tile shakes, the status changes, the needle gets a small kick and **returns to zero**; it comes back by itself after about 8 seconds. Pay in the shop meanwhile: it still works (payments do not depend on the webhook service).
- [ ] Flip the **switch** of `ledger` off: the ledger stops (LED goes red and blinks). Try a payment: it does not fail permanently, it waits or answers 503. Flip it back on.
- [ ] Press **run chaos test** (about 1 to 2 minutes): payments flood in with duplicates while services are killed at random, then the test waits for recovery and prints a result line such as `books balanced · drift 0.00 · N faults injected · M payments for 120 requests + D duplicates · nothing left in flight · internal reconciliation clean`. Press **reset** at any time to undo every fault.

## 8. Protection

- [ ] **Rate limit:** create a merchant with `{"name":"slow","rateLimitPerMin":5}` and call `GET /v1/me` nine times: the first five give 200, then **429** with a `Retry-After` header.
- [ ] **No key / wrong key:** `curl -i localhost:3002/v1/me` gives **401**.
- [ ] **Operator routes need the admin token:** `curl -i localhost:3002/admin/merchants` gives **401**.

## If something looks wrong

| Symptom | Fix |
|---|---|
| A page shows errors, or "status unavailable" | Docker restarted and some containers did not come back: `docker compose up -d` (a few containers with mounted files can fail once right after a Docker restart; this starts them) |
| Docker itself hangs or crashes | The machine is out of memory: the core stack needs about 1.5 GB; close heavy apps, avoid `FULL=1`, restart Docker Desktop |
| `pnpm start:local` says NOT READY | `docker compose logs --tail=50 <service>`; most often a port is taken (3001 to 3009, 55432, 56379) |
| You want a clean slate | `docker compose down -v` then `pnpm start:local` (this deletes the local data) |
| The console shows old design | Rebuild the console image: `docker compose up -d --build dashboard-api` |
| A test failed in `pnpm verify:features` | Run it again once the stack has been up for a minute; if the same check fails twice it is a real bug, please keep the output |
