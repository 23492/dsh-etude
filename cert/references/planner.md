# The planner (release and miss follow-up)

Etude cannot release a card when other cards are learned, and a custom scheduler only sees its own card. So a planner runs on the self-hosted Etude Sync server ([etude-cloudflare](https://github.com/23492/etude-cloudflare)), inside the Sync Worker's own cron, for every account and every certification deck on that server. Code: `kit/planner/src/planner.js`; etude-cloudflare takes it from this repo at every deploy, so there is one copy. Nothing has to be configured per deck or per person.

It needs a Sync server that keeps the vault key (Sync without a password, the etude-cloudflare default). On etude.study's own Sync there is no server-side place to run it; then practice questions arrive in pack order, or you release them by hand (`etude card due <card> --date <day>` once `stats` shows the concepts in review).

## What it does

- Every 10 minutes the cron picks the account that waited longest among those with unread sync events or a plan due, decrypts that account's new events with the server-kept vault key, and keeps only what it needs.
- A practice question is any item with a private `teaches` field (a list of concept item ids; `build_pack.py` writes it for `<types>-oefen` items). It waits on a far due date until every concept item in `teaches` has a card in review, then becomes due `releaseDays` after the last of them was first studied (start of that study day, like `etude card due --date`).
- A practice question answered wrong, or right after the guess button, brings the linked concept cards in review back now. Each answer is handled once; answers older than two days when the planner first sees them are only marked as handled.
- It writes only `/sync_due` and `/sync_due_at` on cards, as ordinary encrypted sync events with its own device id; devices pick them up at their next sync. It never rates, and never touches mock exams, other cards or other decks. Blocked accounts are skipped.

## Settings come from the collection

| setting | where it is read | default |
| --- | --- | --- |
| learning steps, relearning steps (count) | `learningSteps` / `relearningSteps` of the deck's preset and the deck's own config, root deck first, like Etude resolves them | 2 and 1 (Etude's defaults) |
| days from "concepts learned" to release | `schedulerOptions.releaseDays` on the deck or preset, else the `releaseDays` option default of the question's scheduler (`<schedulers>-oefen`, set from cert.json `practice.releaseDays`) | 3 |
| start of the study day | the collection's `dayStartHour` setting | 4 |
| time zone | Worker var `PLANNER_TZ` (Etude does not sync a device time zone) | Europe/Amsterdam |

Changing a deck's learning steps or release days in the app works without a redeploy. `PLANNER=off` on the Sync Worker switches the planner off.

## Free-plan limits

10 ms CPU per invocation, so one invocation works on one account: it decrypts at most a few dozen KB of new events, or it plans (only in a run that read nothing new). A run killed by the CPU limit leaves `inflight` set and the next run on that account reads half as much. A pack import makes thousands of events; the planner then needs some hours to catch up by itself, unless you seed the account.

## Seeding an account (optional)

After a big import: `etude sync now`, then `node kit/planner/seed.mjs <etude.db> <sync-url> <admin-token> <email>` (`etude db path` gives the database path). It loads that account's planner state from the synced collection through the Sync Worker's `/admin/planner/seed` route. Answers already in the collection count as handled. `--dry` shows what it would send.

## Operate

- Status of every account: `GET /admin/planner` with the admin token (cursor, head, last run, counts: locked, waiting, released, answered, misses).
- Run once now: `POST /admin/planner/run` (optionally `{"email": "..."}`).
- State lives in `plan_meta`, `plan_rows`, `plan_cards`, `plan_handled` in the Sync server's D1, per account.

## Tests

`node kit/planner/test/planner.test.mjs` (Node 22.5+, `node:sqlite`): two accounts with decks of different prefixes and settings; hold, release after the deck's own learning steps and release days, the scheduler-option fallback, miss and guess bring the right cards back, a right answer, mock exams and other cards are left alone, accounts without a server-kept key and blocked accounts are skipped. etude-cloudflare's CI runs it before every deploy. Re-run after every Etude update: the sync event format and `etude card due` semantics are Etude internals.
