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
- Same casing and style as the answers (`Object Manager`, not `object manager` when the answer is title case). Short: like the answers, usually 1 to 4 words.
- Vendor terms exactly as the vendor writes them. No em or en dashes. No made-up feature names, no jokes, no "none of the above".

Then run `python3 <kit>/stage.py check <project> decoys`.
