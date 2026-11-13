# Stage: decoys for the word-bank rung (one subagent per domain)

The produce rung of a concept card is a sentence with gaps. The learner never types: they drag blocks from a word bank into the gaps. While learning, the bank holds only the right blocks. Once the card is in review, wrong blocks (decoys) join the bank, more of them as the memory gets stronger. You write those decoys.

## Input

`decoys/in/DD.json`: a list of `{id, sentence, blanks, context, topic}`. `sentence` has the gaps as `{{answer}}` (alternatives split by `|`); `blanks` lists the accepted answers per gap; `context` is the card's question or explanation. Read the whole file first: the other items of the domain are your best source of decoys.

## Output

`decoys/out/DD.json`: an object keyed by item id, one entry for every input item:

```json
{
  "sfa.d01.company.01": {"decoys": ["Organization ID", "Profile", "Permission Sets", "user licenses", "feature licenses", "Login Hours"]}
}
```

## Rules for decoys

- 6 decoys per item (at least 4 when the subject really has no more). Order them hardest first: the first two are shown on young reviews, more as the card matures.
- Every decoy must be a real term of the exam's subject (a real feature, setting, object, permission, limit, number or keyword), the same kind of thing as the gap it competes with, and grammatically fitting that gap. A decoy for a number is a nearby real-looking number; for a yes/no style word (`can`/`cannot`, `before`/`after`) its opposite.
- Tricky, never obvious: the near misses an exam uses. Siblings and confusables (`permission set licenses` for `user licenses`, `Organization-Wide Defaults` for `Role Hierarchy`, `Validation Rule` for `Duplicate Rule`, `after-save` for `before-save`), the right term in the wrong form (singular, a neighbouring setting name), and answers that belong to another gap of the same domain.
- A decoy must be clearly wrong in this sentence according to the card. Never a synonym or an accepted alternative of any gap's answer, never something that is also true there. If you are not sure it is wrong, pick another.
- Never a word or phrase that already stands as plain text in the sentence: the learner rules it out at a glance. Items with a `redo` note had such decoys; write a full new set.
- Same casing and style as the answers (`Object Manager`, not `object manager` when the answer is title case). Short: like the answers, usually 1 to 4 words.
- Vendor terms exactly as the vendor writes them. No em or en dashes. No made-up feature names, no jokes, no "none of the above".

Then run `python3 <kit>/stage.py check <project> decoys`.

## Gaps that may swap (sentences with 2 or 3 gaps)

When the right blocks of two gaps could trade places and the sentence stays true ("plus {{user licenses}} and {{permission set licenses}}"), both placements count as right. Keep every gap; do not rewrite the sentence to pin each block. The grader needs to know which gaps form such a group.

Stage: `python3 <kit>/stage.py gaps-in <project>` writes `gaps/in/DD.json`, a list of `{id, question, answer, text, decoys}` for every word-bank sentence with 2 or more gaps. One subagent per domain writes `gaps/out/DD.json`, keyed by item id, **only for sentences that have a group**:

```json
{"sfa.d01.company.19": {"swap": [[1, 2]]}}
```

Gaps are numbered from 0 in sentence order. Put gaps in one group when each one's answer, placed in the other's gap, leaves a sentence that is still true according to the card (members of one list, the parts of "X and Y", items joined by "or"). Leave gaps apart when the sentence gives them different roles (master and detail, before and after, a number and its unit). Then `stage.py check <project> gaps` and build again.
