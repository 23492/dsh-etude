# Stage 6: analyse the question bank against the concept cards (one subagent per domain)

Before sealing mock exams and repairing the bank, every exam MCQ gets one careful read against the concept cards of its topic. The holdout choice and the repair stage both run on this output.

## Input

`analysis/in/DD.json` (made by `python3 <kit>/stage.py analysis-in <project>`): `{domain, topics: [{topic_file, topic, concepts: [{key, type, fields}], exams: [{key, qid, source, status, fields}]}]}`. Read all of it. cert.json gives `exam.notes` (retired features, current answers).

## Output

`analysis/out/DD.json`:

```json
{
  "questions": [
    {"id": "01-048", "topic_file": "01/01-company.json", "key": "06", "level": "apply", "multi": false,
     "concepts": "Holiday must be linked to business hours", "coverage": "partly", "coverage_note": "holiday-business-hours link not on cards",
     "quality_type": "", "quality_issue": "", "cluster": "", "cluster_kind": "", "correct_longest_unique": false}
  ],
  "gaps": {"01/01-company.json": [{"concept": "dated exchange rates", "ids": ["01-050"], "coverage": "not covered"}]}
}
```

Per question:

- `level`: `recall` (one fact), `apply` (a scenario that needs a fact applied) or `analyze` (weigh two or more options or constraints).
- `concepts`: the fact or decision the question tests, in a few words.
- `coverage`: `covered` (a concept card in the topic teaches exactly the deciding fact), `partly` (the topic is there, the deciding detail is not) or `not covered`. `coverage_note`: what is missing.
- `quality_type`: empty, or `wrong` (key is wrong), `ambiguous` (two defensible answers or a missing constraint), `outdated` (retired feature, old limit), `weak distractors` (options nobody would pick), `duplicate` (same fact as another question). `quality_issue`: one line; add "(uncertain)" when unsure.
- `cluster` and `cluster_kind`: a short label shared by questions that test the same thing. `same fact`: same right answer for the same reason (only one of them stays in practice). `same concept`: related angle (both may stay, but never one in a mock exam and the other in practice). Look across topics of the domain; note likely cross-domain pairs in `quality_issue`.
- `correct_longest_unique`: for single-answer questions, whether the correct option is strictly the longest.

`gaps`: per topic file, the concepts questions need that no card teaches, with the question ids. One entry per concept, not per question.

## Honesty

You are one reviewer without a second rater: level, coverage and quality are judgments. Say "(uncertain)" where you are. Counts and cue statistics are computed by scripts afterwards, not by you.

Validate that the JSON parses and every input qid appears once. Report per domain: counts per level, coverage, quality type, and the five biggest gaps.

## After all domains

The lead runs `python3 <kit>/stage.py holdout <project>` (picks the mock exams: blueprint quota per domain, apply/analyze only, no quality flag, status ok, one per cluster, at most about a third of a domain's quota from one topic, favouring analyze, covered, official sources and no length cue) and then `stage.py repair-in <project>`. Read the holdout output: a domain marked short has too few clean apply questions; take fewer mock questions there or write better ones first.
