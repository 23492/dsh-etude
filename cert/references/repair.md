# Stage 7: repair one domain of the question bank and close the coverage gaps (one subagent per domain, strong model)

Context: the deck has concept cards (taught first, then spaced repetition) and exam-style MCQs. Exam MCQs become practice questions that arrive mixed into the daily session after their concept cards are learned; a wrong answer sends the learner back to the concept cards that teach what the question needs. About two exams' worth of questions are sealed as mock exams. The analysis (analysis.md) found which questions test something no concept card teaches, which have quality problems, and which clusters are near-duplicates.

Your job for one domain: (1) write new concept cards that close the gaps, (2) link every exam question to the concept cards it depends on, (3) repair or retire flawed questions, (4) remove the length cue from options that still have it.

## Input

`repair/in/DD.json` (made by `python3 <kit>/stage.py repair-in <project>`):

- `concepts`: the domain's existing concept cards `{topic_file, topic, key, type, fields, covers}`. Types: `basic` (front, back, extra), `cloze` (text with `{{answer}}` blanks, explanation), `typed` (prompt, answers, explanation), `match` (prompt, pairs), `order` (prompt, steps), `free` (prompt, reference, rubric).
- `exams`: every exam MCQ `{ref, qid, topic, role, drop_reason, source, level, coverage, coverage_note, quality_type, quality_issue, rebalanced, fields:{prompt, options:[{text, correct, why}], multiple, explanation}}`. `role` is `practice`, `proef1`/`proef2` (sealed mock exam) or `drop` (duplicate, already decided).
- `gaps`: per topic file, `[{concept, ids, coverage}]`: what the analysis thought is missing. Treat it as a hint and judge yourself.

Read the whole file first. Also read ladder.md (how recognition options and cloze text are written) and balance.md (how to balance option lengths): your new cards need that ladder content too.

## Output

`repair/out/DD.json`:

```json
{
  "new_concepts": [
    {
      "topic_file": "01/04-security.json",
      "key": "n01",
      "type": "basic",
      "fields": {"front": "...", "back": "...", "extra": "..."},
      "for": ["01-077", "01-081"],
      "ladder": {"recognize": {"prompt": "...", "options": [{"text": "...", "correct": true, "why": "..."}, {"text": "...", "why": "..."}, {"text": "...", "why": "..."}, {"text": "...", "why": "..."}], "explanation": "..."}, "text": "... {{term}} ..."}
    }
  ],
  "exams": {
    "01/04-security.json|07": {
      "teaches": ["01/04-security.json|03", "01/04-security.json|n01"],
      "action": "keep",
      "fields": null,
      "note": ""
    }
  }
}
```

### `new_concepts`

- One card per missing concept, not per question: several questions that need the same fact share one card. Keys `n01`, `n02`, ... unique per topic file. Put the card in the topic file the questions belong to.
- Mostly `basic` (front: a short question; back: the answer, at most about 60 words, bold the deciding term) or `cloze`. Use `typed` for a single term or number.
- The back states the fact and, where the exam tests a choice between features, one sentence on why the neighbouring feature is wrong ("Not a sharing rule: those only open access up"). That contrast is what transfers to scenario questions.
- Teach the concept, never the question: no scenario names (the fictional companies of the questions), no "which option" phrasing, nothing that lets the learner recognise the exam question from the card. The card must be useful on its own.
- Facts only when you are sure they are true for the current product release and blueprint; cert.json `exam.notes` wins. If you are unsure of a fact, do not write the card; mention it in `notes`.
- Do not duplicate an existing card. If an existing card nearly covers it, prefer linking it and say in `note` what is missing; write a new card only when the missing piece is a real fact the question needs.
- `for`: the qids this card is written for.
- `ladder`: for `basic`, `cloze`, `typed`: `recognize` per ladder.md (4 options, exactly one correct, competitive wrong options, every option a `why`, lengths balanced per balance.md: correct option not the longest by more than a few characters). For `basic` also `text` (1 to 3 blanks). For `cloze` and `typed` only `recognize`.
- Do not write cards just to cover `drop` questions. Sealed mock questions (`proef1`, `proef2`) do get gap cards, since a mock should test taught material, but the card must not give the question away.

### `exams` (every exam in the input, keyed by `ref`)

- `teaches`: refs (`topic_file|key`) of the concept cards, existing or new, that a learner needs to answer this question. 1 to 3, most important first; any topic file of the same domain, or another domain if that is where the concept lives (use that domain's topic file name, e.g. `06/03-data-quality.json|05`). Required for every exam with action `keep` or `fix`. A wrong answer will bring these cards back, so pick the ones that actually teach the deciding fact.
- `action`:
  - `keep`: fine as is (fields null).
  - `fix`: give full corrected `fields` (prompt, options with `correct` and `why` on each, multiple, explanation). Fix: a wrong or doubtful key, an ambiguous stem (add the missing constraint), two defensible answers (rewrite the weaker option to be clearly wrong), garbled text, outdated features (replace with the current equivalent or retire), weak distractors (replace with competitive ones), and the length cue (below). Keep what the question tests. Keep option count and do not invent features.
  - `retire`: unfixable, out of scope for the current exam, or testing trivia the exam never asks. Give the reason in `note`. Every `drop` role exam gets `retire` with its `drop_reason`.
- Length cue: for `practice` and mock questions with `rebalanced: false` where the correct option is clearly longer or more specific than every wrong option (single answer: more than about 25% longer than the mean wrong option and the longest), balance it per balance.md and return it as `fix`. Do not touch options that are already balanced.
- `note`: one line when you fixed or retired something, what and why.

## Rules

- Card content in the exam's language. No em or en dashes anywhere. No `{{` or `}}` except blanks in `text` / cloze.
- Do not edit any file except your output file.
- Validate with `python3 <kit>/stage.py check <project> repair`, and also check: every input exam ref present in `exams`; every keep/fix has 1 to 3 `teaches` that resolve to an existing concept (`topic_file|key` from any `parts/DD/*.json` item that is not an mcq) or a new one in your output; every `fix` has options with at least one correct and a `why` on each; option count of a `fix` equals the original; every new concept has the fields its type needs and valid ladder content; no em dash. Then report: new cards per topic, keep/fix/retire counts, questions still without a teaching card (should be 0 for keep/fix), and the facts you were unsure of.
