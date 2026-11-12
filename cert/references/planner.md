# The planner Worker (release and miss follow-up)

Etude cannot release a card when other cards are learned, and a custom scheduler only sees its own card. So a small Cloudflare Worker does it, next to the self-hosted Etude Sync Worker ([etude-cloudflare](https://github.com/23492/etude-cloudflare)), on the same D1 database, every 10 minutes. Code: `kit/planner/`. One Worker per deck.

It needs a self-hosted Sync server that keeps the vault key (Sync without a password). On etude.study's own Sync there is no server-side place to run it; then release by hand instead (`etude card due <card> --date <day>` after `stats` shows the concepts in review) or skip the release rule and let practice questions arrive by item order.

## What it does

- Reads the account's sync events from D1 and decrypts them with the server-kept vault key.
- A practice question (`<types>-oefen`, item id `<items>.oefen.*`) waits on a far due date until every concept item in its private `teaches` field has a card in review, then becomes due `RELEASE_DAYS` after the last of them was first studied (start of that study day, like `etude card due --date`).
- A practice question answered wrong, or right after the guess button, brings the linked concept cards in review back now. Each answer is handled once.
- It writes only `/sync_due` and `/sync_due_at` on cards, as ordinary encrypted sync events with its own device id; devices pick them up at their next sync. It never rates and never touches mock exams or other decks.

## Configure (wrangler vars)

| var | meaning | SF value |
| --- | --- | --- |
| `ACCOUNT_EMAIL` | the learner's Sync account | required |
| `ITEM_PREFIX` | cert.json `ids.items` | `sfa` |
| `TYPE_PREFIX` | cert.json `ids.types` | `sfl` |
| `RELEASE_DAYS` | cert.json `practice.releaseDays` | `3` |
| `LEARNING_STEPS`, `RELEARNING_STEPS` | count of the preset's learning and relearning steps | `2`, `1` |
| `TZ`, `DAY_START_HOUR` | the learner's time zone and Etude's day start | `Europe/Amsterdam`, `4` |
| `RUN_TOKEN` (secret) | bearer token for `/run`, `/seed`, `/status` | |

Bindings: `DB` = the etude-sync D1 database. Cron `*/10 * * * *`. `kit/planner/wrangler.example.jsonc` has the shape.

## Free-plan limits

10 ms CPU per invocation. Each run decrypts at most 24 KB of new events (about 4 ms); a run that hits the limit leaves `inflight` set and the next one halves its budget. Planning happens only in a run that read nothing new. Measured: idle run 3 to 5 ms, planning run 4 to 10 ms. A backlog is worked off over several runs, so after a study session it can take 20 to 30 minutes before everything is handled.

## Start and operate

1. Import the pack, study nothing yet, `etude sync now`.
2. Deploy the Worker (Cloudflare API or `wrangler deploy`), set the secret.
3. Seed it from the synced collection instead of replaying the whole log: `node kit/planner/seed.mjs <etude.db> <worker-url> <token> --items <items> --types <types>` (`etude db path` gives the database path).
4. `curl -H "authorization: Bearer $TOKEN" <worker-url>/status`: `last.counts.locked` should equal the number of practice questions. `POST /run` runs once now.

State lives in `planner_meta`, `planner_rows`, `planner_cards`, `planner_handled` in the same D1; seeding again resets it. Changing the preset's learning steps means changing the vars too.

## Tests

- `node kit/planner/test/synthetic.mjs`: self-contained (made-up deck with other prefixes): hold, release after the last concept, miss and guess bring the right cards back, a right answer and another deck's cards are left alone, learning-step counting, token guard.
- `node --max-old-space-size=96 kit/planner/test/scenario-real.mjs <etude.db>`: the same on a copy of a real SF Platform Admin collection.

Both need Node 22.5+ (`node:sqlite`). Re-run after every Etude update: the sync event format and the `etude card due` semantics are Etude internals.
