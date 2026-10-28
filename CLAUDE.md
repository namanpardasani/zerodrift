# Zerodrift: working rules

Full spec and phase plan: [PROJECT_BRIEF.md](PROJECT_BRIEF.md). Running state: [NOTES.md](NOTES.md).
After any session/context reset, re-read both and continue from the next unfinished task in the Progress log.

## Rules (summary of brief section 0)
- Build phase by phase (brief section 7) without asking, except: the Phase 10 design pause; anything that costs money or needs the user's accounts/credentials; anything destructive outside this repo or irreversible; a real blocker after trying reasonable alternatives (explain options, recommend one).
- Otherwise decide yourself and record the decision and reasons in NOTES.md.
- One LOCAL git commit at the end of each phase. Never push, never add a remote.
- Update the NOTES.md Progress log after every phase: done, next, known issues.
- Quality bar: one-command run, passing tests, no TODO stubs in finished phases, no fake data or invented numbers.
- Verify library versions/maintenance instead of guessing. Free tools only.
- Product name "Zerodrift" lives in ONE config constant and ONE place in the frontend. Packages use the `@zerodrift/` scope.
- Code is for a student to study: clean, well-structured, commented where logic is non-obvious.

## Money rules (non-negotiable)
Integer minor units (bigint / BIGINT) only; immutable journal entries (reverse, never UPDATE/DELETE); debits == credits per transaction; no negative balance unless allow_negative; lock accounts in id order; idempotency (same key+request -> stored response, different request -> 422, concurrent duplicates never both execute); timeouts are UNKNOWN outcomes, not failures.
