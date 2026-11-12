# Stage 5: remove the length cue from multiple-choice options (one subagent per domain)

Generated options give the answer away by length. Measured on the SF deck: in self-written questions the correct option is strictly the longest 57 to 64% of the time (chance is about 25%), and on average 25 to 30% longer than the wrong ones. That lets him answer by length instead of knowledge. Official and bank questions usually do not (median ratio 1.02 to 1.03); `stage.py balance-in` only selects questions that leak (pass `--all` to include every own-written one).

## Input

`balance/in/DD.json`: a list of questions `{ref, prompt, options:[{text, correct?, why}], explanation, multiple?}`. Read the whole file.

## Output

`balance/out/DD.json`: an object keyed by `ref`, for every question in the input:

```json
{ "herken|<items>.d01.company.03": { "options": [ {"text": "...", "correct": true, "why": "..."}, {"text": "...", "why": "..."} ] } }
```

Same number of options, same order, same option marked correct, every option keeps a `why`. Only `text` (and `why` where the option text changed meaning slightly) may change. Do not touch `prompt` or `explanation`.

## How to rewrite

The goal: the length, detail and style of an option no longer reveal which one is correct.

- **Shorten the correct option** to its core. Remove qualifiers, the "so that ..." tail, examples and parenthetical lists that only the correct option has. It must stay true and still be the one right answer to the prompt.
- **Lengthen or sharpen wrong options** where needed so they are as specific as the correct one: same grammatical form, a concrete feature or setting name, a plausible reason or effect. They must stay clearly wrong according to their `why`; do not make a wrong option accidentally correct, and do not invent features that do not exist.
- **Length rule:** within each question, the longest and shortest option differ by at most 40% (in characters), unless every option is very short (under 25 characters). The correct option must not be the strictly longest in more than about 30% of your questions; vary it: sometimes the correct one is shortest, sometimes in the middle.
- **No other giveaways:** the correct option must not be the only one that repeats words from the prompt, the only one with a hedge ("usually", "can"), the only one with a list, or the only precise one. Wrong options should not be absolute ("always", "never", "all") when the correct one is not.
- Keep the facts. Wrong options stay wrong, the correct option stays correct, numbers stay exact. If you cannot balance a question without changing what it tests, keep it close and note it.
- The exam's language. No em or en dashes. Do not use `{{` or `}}`.

## Validate

Run `python3 <kit>/stage.py check <project> balance` and `stage.py measure`, and report per file: every input ref present; option count, order and correct flags unchanged; every `why` non-empty; share of questions where the correct option is strictly the longest (target 30% or less; before: about 60%); median ratio of correct-option length to mean wrong-option length (target 0.9 to 1.1); count of questions violating the 40% spread rule (target 0, list exceptions). Also list the refs where you were unsure the meaning stayed intact.
