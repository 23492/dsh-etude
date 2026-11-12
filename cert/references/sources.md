# Stage 1: sources and the question bank

Goal: one file, `questions.json`, that is the single source for the deck. Everything else is built from it, so fix questions there and rebuild.

## What to collect (in the project's `sources/`)

- **Official exam guide:** domains, weights, number of questions, minutes, pass mark, retired topics. Write it to `sources/objectives.md` with the URL and the date read. Vendors change blueprints: note the version.
- **Official sample or practice questions** (vendor training sites, free practice tests). Source tag `official`.
- **Community question banks** (GitHub repos, published practice exams, blog quizzes). Source tag `bank:<name>`. Record repo URL and licence in `sources/banks.md`. Never use paid dumps the learner has no right to; exam NDA material is out.
- **The learner's own material:** video transcripts, a course, a book or PDF, notes. Source tag `own`. Use it to write open concept questions per objective.

Spread the collecting over parallel subagents (cheap model, one per source). Each returns raw questions in the format below plus a note of what it could not fetch.

## Format

```json
{
  "exam": "Vendor Certified Something (CODE)",
  "blueprint": "version or date",
  "questions": [
    {"id": "01-001", "domain": "01", "domain_name": "Domain name", "type": "mc",
     "question": "...", "options": ["...", "..."], "correct": [1], "answer": "", "explanation": "...",
     "priority": "core", "status": "ok", "source": "bank:repo-name", "source_id": "original id or URL", "tags": []}
  ]
}
```

- `type`: `mc` (options + zero-based `correct`, several for "choose two") or `open` (`answer`, a concept question with a free answer).
- `id`: `DD-NNN`, domain first. Stable once the deck is in use.
- `priority`: `core` or `extra` (rarely asked; goes last in its topic).
- `status`: `ok`, `disputed` (key doubtful) or `outdated` (feature retired; leave it out of the deck).

## Verify every bank question

Community banks are full of wrong keys and dead features. Per domain, a subagent (strong model) re-answers every bank question from first principles and the current documentation:

- Key wrong: correct it and say so in `explanation`. Doubtful: `status: disputed`.
- Feature retired or renamed: rewrite to the current equivalent or mark `outdated`. Put the vendor's retirements in `cert.json` `exam.notes` so every later stage knows them (SF: Workflow Rules and Process Builder are retired, Flow is the answer).
- Add an `explanation` (why the right one is right, one line per wrong option) when the bank has none.

For SF: 631 questions after dedup, 5 keys corrected, 68 marked outdated, 45 disputed.

## Dedupe and trim

Banks repeat each other. Group near-identical questions (same stem and same right answer) and keep the best-sourced one (official > bank > own). Then check coverage: every exam objective has questions, and no domain is wildly over or under its weight (the mock exams need about 2 x weight x exam length questions per domain at apply/analyse level, plus practice).

## Own concept questions

Where the banks are thin, write `open` questions from the learner's material, one fact or decision each, front a real question. These become concept cards in stage 2.
