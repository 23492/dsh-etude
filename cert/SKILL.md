---
name: etude-cert
description: Build an Etude study deck for a multiple-choice certification exam (Salesforce, AWS, Azure, Google Cloud, CompTIA, ISTQB, PMP, Scrum, ITIL, and the like) from the official exam guide, community question banks and the learner's own material, the way the Salesforce Platform Admin deck was built - concept cards that teach first and climb a ladder of forms, exam questions as practice that is released once its concepts are learned, and two sealed blueprint-weighted mock exams that decide when to book. Use whenever the user wants to prepare for, study for or pass a certification or vendor exam with flashcards or Etude, turn exam dumps, practice tests or a study guide into a deck, add questions to or repair an existing certification deck, or check readiness to book the exam - even if they only say "help me pass <exam>".
---

# Certification deck for Etude

A certification deck has three parts, each with its own job:

- **Concept cards** teach the facts and decisions the exam tests. Each is taught first (one tap) and then climbs a ladder of forms: recognise (multiple choice), then produce (fill in, type, match, order). Hints only while learning.
- **Practice questions** are the exam-style questions. They are never drilled: one clean try, released a few days after the concepts behind them are learned, mixed across topics. A miss or a guess brings those concept cards back and the question once more after 4 days.
- **Two sealed mock exams**, weighted like the blueprint, seen nowhere else. Readiness comes only from them: book at 75% or more.

Why each rule exists, with the evidence: [references/design.md](references/design.md). Read it before changing a rule.

The kit in `kit/` does the deterministic work (card types, schedulers, pack builder, stage inputs, measurements, validation, workload simulation, the planner Worker). Subagents do the judgment work, one per exam domain, from the specs in `references/`. The tested example is the Salesforce Platform Administrator deck: its `cert.json` is in `kit/example.cert.json`.

Everything below uses the `etude` tool (DSH) for the collection. `<kit>` is this skill's `kit/` folder (the skill's base directory + `/kit`); `<project>` is the learner's project folder.

## 0. Agree the plan with the learner

Ask (one round, with options):

- Which exam, which version of the blueprint, and target date.
- Sources: official guide and samples, community banks (which), their own material (videos, course, book, PDF).
- Card language (the exam's) and the learner's language (lessons, intros, feedback).
- Minutes a day, so `newPerDay` fits (stage 9).
- Whether the self-hosted Sync with the planner Worker is available (see references/planner.md); without it, practice questions arrive in pack order and you release them by hand.

## 1. Project and cert.json

Make `<project>/` (a folder in the learner's notes, not in the skill) with `cert.json`, copying `kit/example.cert.json`:

- `name` (top deck), `exam` (title, questions, minutes, passMark, bookAt, cardLanguage, learnerLanguage, `notes` with retired features and current answers that every stage must respect).
- `ids`: short unique prefixes, for example `aws`/`awl`. **Item ids are built from them and must never change once the learner studies.**
- `domains`: id, name, weight (%), optional `video`. Their order is the order new cards arrive in: foundations first, or the learner's video order.
- `mocks` (count, size, seed), `preset` (Etude preset config), `practice` (againDays, maxTries, releaseDays), `text` (deck, domain and mock descriptions in the learner's language; placeholders `{weight} {expected} {questions} {video} {n} {size} {minutes} {when} {pass} {book}`), `ui` (card buttons in the learner's language: lesson, known, guess, options, pickAll, rightOrder; Dutch by default).

## 2. Sources and the question bank

Follow [references/sources.md](references/sources.md): collect the official guide, sample questions, community banks and the learner's material; verify every bank answer against current documentation (parallel subagents, strong model); dedupe; write `questions.json`. Ask the learner when a source needs a login or payment.

## 3. Topics and concept cards

One subagent per domain with [references/concepts.md](references/concepts.md) (Sonnet-class is enough). Output `parts/DD/NN-slug.json` and a cheat sheet `notes/DD <name>.md`. Then:

```
python3 <kit>/stage.py check <project> parts      # every source id covered, keys unique, no dashes
```

## 4. Lessons

One subagent per domain with [references/lessons.md](references/lessons.md). Then `stage.py check <project> lessons`.

## 5. Ladder content

```
python3 <kit>/stage.py ladder-in <project>
```

One subagent per domain with [references/ladder.md](references/ladder.md) (recognise MCQ with four competitive options and a `why` each, plus a cloze sentence for basic cards). Then `stage.py check <project> ladder`.

## 6. Length cue

```
python3 <kit>/stage.py measure <project>
python3 <kit>/stage.py balance-in <project>     # only questions that leak; --all for every own-written one
```

One subagent per domain with [references/balance.md](references/balance.md), then `check balance` and `measure` again. Targets: correct strictly longest at most 30%, median ratio 0.9 to 1.1. Read the refs a subagent flags as uncertain before accepting: a rewrite can change a fact.

## 7. Analysis, mock exams, repair

```
python3 <kit>/stage.py analysis-in <project>
```

One subagent per domain with [references/analysis.md](references/analysis.md) (level, coverage, quality, clusters, gaps). Then:

```
python3 <kit>/stage.py holdout <project>     # repair/holdout.json: blueprint-weighted mocks, one per cluster
python3 <kit>/stage.py repair-in <project>   # repair/in/DD.json and repair/drop.json
```

One subagent per domain with [references/repair.md](references/repair.md) (strong model): gap cards with ladder content, `teaches` links for every question, fix or retire flawed ones. Then `stage.py check <project> repair`. Collect the facts the subagents were unsure of: they go to the learner at the end.

## 8. Build and verify

```
python3 <kit>/build_pack.py <project>                 # pack + teaches.json, fails on gaps
node <kit>/verify_types.mjs <project>/deck.pack.json  # prepare and grade over every item, face and learner state
node <kit>/sim.cjs <project>/deck.pack.json <project>/teaches.json 42 <newPerDay> '<newPerFace JSON>' 3
```

Pick `newPerDay` and `newPerFace` from the simulation (SF: 48 a day, at most 12 practice; 47 min in week 1, 70 at the peak, every concept seen by day 30). Write them into `cert.json` `preset` and build again.

## 9. Import

1. `etude db backup`, then `["pack","check","<pack>"]`, `["pack","import","<pack>","--dry-run"]`, then import.
2. Spot-check in the collection: `study card <id>` on a first rung (teach view), a second rung (hints), a practice question (guess button, no teach), then `card bury` anything you submitted. `stats skills <deck>` lists the rungs.
3. Set the AI feedback style on the top deck (`deck instructions`): the learner's language, answer first, vendor jargon exactly as on the card, no dashes, no praise. Optionally Minimi's personality the same way (see the worked example's `etude/minimi/`).
4. Have the learner open a few cards on the phone before you call it done.

## 10. Planner

With the self-hosted Sync: deploy `kit/planner` for this deck and seed it ([references/planner.md](references/planner.md)). Check `/status`: `locked` equals the number of practice questions. Run `node <kit>/planner/test/synthetic.mjs` first if the kit or Etude changed.

## 11. Study plan

Write `<project>/Studieplan <exam>.md` (learner's language): exam facts and domain weights, what is in the deck and how it behaves (two sentences per part, no internals), a week schedule with videos per domain, mock exam 1 halfway and mock 2 a week before the date with direct links (`/app/study?deck=<deck>::<mock deck>&q=is:new&ahead=1`; set a timer for the exam's minutes), the booking rule, and the facts the subagents could not verify.

## Changing a deck in use

- Never rename slugs, renumber keys or change `ids`: an item id is its study history.
- Fix a question in `questions.json` or a part file, rebuild, import: the item keeps its id and history.
- New gap cards: add them through a repair output (`n` keys) so they get an `ord` right after their topic.
- Retire instead of delete (`archived` in the pack, or `item archive`).
- After two weeks read `stats skills`: a rung under 0.8 success is too hard (check the distractors, longer support), above 0.95 too easy.
- After an Etude update, rerun `verify_types.mjs`, the planner tests and one teach-step tap in the app (the one-tap Good uses an internal message).

## Hard rules

- Never rate cards for the learner and never show a mock question anywhere else (also strip them from any HTML practice exam).
- Vendor jargon stays exactly as the vendor writes it, in every language.
- No em or en dashes in any card, lesson or note. Never hard-wrap prose.
- Nothing invented: a fact a subagent cannot verify is left out or flagged, never guessed.
