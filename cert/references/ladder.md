# Stage 4: ladder content (one subagent per domain)

The deck gives each concept card a ladder of forms: first **recognize** (multiple choice), then **produce** (fill in the key terms yourself). You write the content the new rungs need, for the items in your domains.

## Input

`ladder/in/DD.json` (made by `python3 <kit>/stage.py ladder-in <project>`): a list of items `{id, kind, fields}` where `kind` is `basic` (fields front, back, extra), `cloze` (text with `{{answer}}` blanks, explanation), `typed` (prompt, answers, explanation), `match` (prompt, pairs), `order` (prompt, steps) or `free` (prompt, reference, rubric). Read the whole file first: the other items of the domain are your source of plausible wrong options.

## Output

`ladder/out/DD.json`: an object keyed by item id. Include every item of kind `basic`, `cloze`, `typed` and `free` (skip `match` and `order`):

```json
{
  "<items>.d01.ui.01": {
    "recognize": {
      "prompt": "What are the two kinds of quick action?",
      "options": [
        {"text": "Object-specific and global", "correct": true, "why": "Object-specific actions relate the new record to the current one; global actions can be used anywhere."},
        {"text": "Standard and custom", "why": "Standard and custom describe objects and fields, not quick action kinds."},
        {"text": "Screen and autolaunched", "why": "Those are flow types, not kinds of quick action."},
        {"text": "Public and private", "why": "Public and private describe list views and groups, not quick actions."}
      ],
      "explanation": "Quick actions are either object-specific or global; global actions cannot use Update a Record."
    },
    "text": "Quick actions are either {{object-specific}} or {{global}}; the {{Update|Update a Record}} action type is not available as a global action."
  }
}
```

### `recognize` (all four kinds)

- `prompt`: the card's question, asked so that one short option answers it. For `basic` use the front (shorten if it asks two things; ask the core one). For `typed` and `free` use the prompt. For `cloze`, take the sentence, replace its most important blank with `___` and keep the other blanks filled in, then ask "Which term fills the blank?" or a direct question.
- Exactly 4 options, exactly one with `"correct": true`. The correct option states the card's answer concisely (under 20 words), true to the card.
- Wrong options must be **competitive**: real features, settings, objects, limits or numbers of the exam's subject from the same topic or domain (look in the other items of the input), plausible for this stem, and clearly wrong according to the card content. Same length and style as the correct option. Never "all of the above", "none of the above", jokes or made-up feature names. For numbers use nearby real-looking numbers.
- Every option has `why`: one sentence. For the correct one, why it is right. For a wrong one, what that option actually is or does, or why it does not fit; only facts present in the input or plainly true. If you are unsure what a distractor does, pick another distractor.
- `explanation`: one sentence that states the fact, from the card.

### `text` (only for kind `basic`)

- The card's back (not the extra) as one or two English sentences with 1 to 3 blanks `{{term}}` on the terms the exam tests: feature names, setting names, numbers, the deciding word. Alternatives with `|` (`{{50000|50,000}}`).
- Must be answerable from the front plus the sentence. Keep every fact exact; do not add facts. At most 45 words. No `{{` or `}}` outside blanks.
- If the back is a long list, keep the 2 or 3 items that matter most for the exam.

## Rules

- Card content in the exam's language (cert.json `exam.cardLanguage`). No em or en dashes.
- Facts only from the input; cert.json `exam.notes` wins over older facts.
- Validate with `python3 <kit>/stage.py check <project> ladder`, and also check: every basic/cloze/typed/free id of your input is present; each `recognize` has 4 options with exactly one correct, every option has a non-empty `why`, option texts are distinct; each `text` has 1 to 3 `{{...}}` blanks and no unmatched braces; no em dash anywhere. Report counts and any item you found hard.

Afterwards the lead measures the length cue (`stage.py measure`) and runs balance.md on what still leaks.
