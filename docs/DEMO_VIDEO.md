# Demo video script (90 seconds)

**Goal:** in 90 seconds a recruiter or interviewer sees that this is a real payments system that stays correct when things break, and that you can explain why.
**Format:** screen recording, 1440 x 900, browser zoom 100%, no bookmarks bar, voice-over (about 210 words at an easy pace) or the captions in the right column if you prefer silent. Keep each shot to its time box; cut dead air.

## Before you record (5 minutes)

Record on the **development** stack, not the production one: the chaos bench only exists in test mode.

```bash
docker compose up -d --build                       # development stack (or `pnpm chaos` brings up kind; either works)
ADMIN_TOKEN=dev-admin-token LEDGER_URL=http://localhost:3001 RECON_URL=http://localhost:3004 GATEWAY_URL=http://localhost:3005 node scripts/seed-demo.mjs   # 2 merchants, 12 customers, 80 payments, duplicates, refunds, a recovered payment
```

- Sign in to the console once (`admin` / `zerodrift`) so the recording does not show a password. Open four tabs: **landing** (`/`), **shop**, **a payment detail page** whose payment has an absorbed duplicate (the seed makes several; open Payments and pick one with the "A duplicate request was absorbed" section), **chaos bench** (`/app/chaos`).
- Empty the shop cart. Top up the wallet once so checkout works first time.
- Turn on "Do not disturb". Close everything else (the stack uses about 1.2 GiB; recording needs headroom).
- Do one dry run: the chaos test takes about 25 seconds, so you will speed it up or cut it.

## Shot list

| Time | On screen | Say (voice-over) | Caption (if silent) |
|---|---|---|---|
| 0:00 to 0:08 | **Landing page** hero. The needle swings in and settles on zero, the receipt prints out of the ZD-1. Slow scroll just until the headline is readable | "This is Zerodrift: a payments ledger I built to keep the books right, even when the system is being broken on purpose." | money that never drifts. |
| 0:08 to 0:24 | **Shop** (Café Aman). Add Assam Chai, open the cart, press **Pay from wallet**. Show the "handing off to Zerodrift" line, then the order page with the receipt printing | "A customer pays a merchant. Zerodrift holds the money, asks the bank, then posts balanced ledger entries and tells the merchant with a signed webhook. If anything fails in the middle, the money is released, never lost." | a payment, end to end |
| 0:24 to 0:40 | **Payment detail** in the console. The state line fills station by station, the journal rows write in like ink, the bracket draws, the **BALANCED** stamp lands | "Every payment is a journal entry: debits equal credits, written once, never edited. The stamp is computed from the entries, so an unbalanced transaction can never say balanced." | double-entry, always balanced |
| 0:40 to 0:52 | Scroll to **"A duplicate request was absorbed"**: the second request gets stamped **ALREADY PAID** and folds into a chip, the counter stays at 1 | "Clients retry. Same idempotency key, same request: the second one gets the first one's answer. Ten taps, one charge." | retry-safe: ten taps, one charge |
| 0:52 to 1:12 | **Chaos bench.** Press **run chaos test**. Modules shake and their LEDs blink red as pods are killed and the bank misbehaves; the needle wobbles and **always returns to zero**. Cut to the result line when it lights up | "Now I break it. Kill the payments service, kill the ledger, pause Kafka, make the bank lie. Payments flood in, duplicates included. The needle is the real drift in the books, and it comes back to zero. When it stops, the checker asks the database directly." | I break it on purpose. |
| 1:12 to 1:24 | **Landing, chaos results section** (scroll to "tested with violence."): 60,000 operations, 167 faults, 54 of 54 invariants. Pause on the run table | "The full test: sixty thousand payments, a hundred and sixty-seven faults, six runs. Every invariant held every time: money conserved to the paisa, no duplicate charge, nothing stuck, every webhook delivered once. It found two real bugs, and I say so on the page." | 60,000 payments · 167 faults · 54/54 invariants |
| 1:24 to 1:30 | The wordmark and the GitHub link in the footer | "Zerodrift. Built with care, tested with violence. The code and the write-up are on GitHub." | github.com/namanpardasani/zerodrift |

## Rules for the recording

- **Only say numbers you can point at on the screen.** Every figure above is on the landing page and in `docs/CHAOS_RESULTS.md` (a test ties the page to that document). Do not add throughput or latency claims unless you show the table: they are laptop numbers (42.6 to 52.2 operations per second on one shared node) and the video should not imply more.
- If the chaos test does not finish in time on the day, cut to the result line from a previous take; do not fake it, and do not claim "all invariants held" unless the line on screen says so.
- Keep the one honest caveat available for the Q&A: one Kubernetes node, so node failure was not tested.

## Variants

- **30-second cut** for LinkedIn: 0:00 to 0:08 (landing), 0:52 to 1:12 (chaos), 1:12 to 1:24 (results).
- **Interview screen-share:** skip the shop; start at the console payment page, go to the chaos bench, end on the results table and the two bugs the chaos test caught (the ledger pool deadlock and the Kafka volume), which is where the best questions come from.
