# Stage 2: topics and concept cards (one subagent per domain)

Give this file to a subagent together with: the project path, its domain number DD, `cert.json` (exam, domain names, `exam.notes`, card and learner language) and the domain's objectives from `sources/objectives.md`.

Goal: the learner passes the exam with minimal effort and no coverage gaps. You rebuild one exam domain from a flat question list into a well-ordered Etude deck: topics in a learning order, each topic starting with short concept cards and ending with exam-style questions, using the card type that fits each fact best.

## Input

`questions.json` (cert.json `paths.questions`), only the questions with `domain` DD and `status` not `outdated`.

## Output

One JSON file per topic: `parts/DD/NN-slug.json` (NN = two-digit topic order, slug = lowercase-dashes). Create the directory.

```json
{
  "topic": "Users and licenses",
  "slug": "users",
  "intro": "One or two sentences in the learner's language: what this topic is about and what the exam asks about it.",
  "items": [
    {"key": "01", "type": "match", "fields": {"prompt": "...", "pairs": [["left", "right"]], "explanation": "..."},
     "covers": ["01-004", "01-017"], "extra": false, "disputed": false, "check": ""}
  ]
}
```

- `key`: two-digit order within the topic, unique in the file. Never renumber once the deck is in use (item ids are built from it).
- `covers`: the source ids this item replaces. Every source id of the domain must appear in `covers` of at least one item. Check with `python3 <kit>/stage.py check <project> parts`.
- `extra`: true when every covered source has priority `extra`. `disputed`: true when a covered source is disputed.
- `check`: empty, or a short note if you believe a source answer is wrong or outdated. Keep the source's answer anyway; never silently change a key.

## Card types (Etude built-ins; the builder turns them into ladder types)

| type | use for | fields |
| --- | --- | --- |
| `mcq` | every source `mc` question | `prompt`, `options: [{"text", "correct": true?, "why"}]`, `multiple`, `shuffle` (false for "all of the above"), `explanation` |
| `match` | 3 to 6 parallel facts: feature to purpose, limit to number | `prompt`, `pairs: [[left, right], ...]`, `explanation` |
| `order` | real sequences (order of execution, setup steps) | `prompt`, `steps` (correct order, 3 to 7), `explanation` |
| `cloze` | numbers, limits, exact names inside a sentence | `text` with `{{answer}}`, alternatives `{{20|twenty}}`, hint `{{answer::hint}}`; 1 to 3 blanks; `explanation` |
| `typed` | one exact name the learner should produce | `prompt`, `answers` (accepted spellings), `explanation` |
| `basic` | definitions, "what is / when do you use" | `front` (a question), `back`, `extra` (optional) |
| `free` | "explain why" where the reasoning is the thing tested; AI-graded | `prompt`, `reference`, `rubric` (markdown string), `input: "text"` |

## Rules

1. **Exam questions stay.** Every source `mc` question becomes its own `mcq` item with stem, options and key unchanged (typos and grammar only). Merge two own-written ones only when they test the exact same decision, and list both ids in `covers`. The first id in `covers` is the question id the deck uses.
2. **mcq `why`:** every option gets one sentence: why it is right, or why it is wrong. `explanation` keeps the overall reasoning in one or two sentences.
3. **Open questions get transformed.** Group 3 to 6 related ones into a `match` when they are parallel facts. Numbers become `cloze`. Sequences become `order`. `free` for at most about 10% of items, only where reasoning is tested. `basic` for the rest, with a real question on the front. One idea per item; split long multi-part answers.
4. **Nothing invented.** Only facts present in the sources, and cert.json `exam.notes` wins over an older source.
5. **Topics:** 4 to 9 per domain, matching the official objectives, in learning order (foundations first). Inside a topic: concept cards first (basic, cloze, match, typed, order), then `mcq` and `free`. `extra` items last.
6. **Language:** card content in the exam's language (cert.json `exam.cardLanguage`); `intro` in the learner's language. Domain jargon exactly as the vendor writes it, never translated. No em or en dashes.
7. **match pairs:** at least 3, unambiguous (each left fits exactly one right), all left sides and all right sides distinct (Etude rejects repeated right sides). Each side under about 12 words.
8. Markdown is allowed in all text fields. No `{{` or `}}` outside cloze blanks.

## Cheat sheet

Also write `notes/DD <Domain name>.md`: one page (300 to 600 words) of the facts and decision rules the exam tests in this domain, from the sources only. Learner's language with the vendor's terms, headings per topic, short lists and a small table where it helps. Each paragraph on one line. No em dashes, no filler.
