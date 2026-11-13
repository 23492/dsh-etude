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

## One block, one gap (sentences with 2 or 3 gaps)

A word bank only tests something when each right block fits exactly one gap. "plus {{user licenses}} and {{permission set licenses}}" fails: the two blocks are the same kind of thing in a list, so they swap freely and the card tests dragging, not knowledge. The same goes for any gap a decoy could fill without the sentence becoming false while a right block sits elsewhere.

Stage: `python3 <kit>/stage.py gaps-in <project>` writes `gaps/in/DD.json`, a list of `{id, question, answer, text, decoys}` for every word-bank sentence with 2 or more gaps. One subagent per domain reads each and writes `gaps/out/DD.json`, keyed by item id, **only for the sentences that fail**:

```json
{"sfa.d01.company.19": {"text": "Company Information shows the {{Organization ID}}, edition and default time zone; its {{User Licenses}} related list shows used and remaining seats per license type.", "decoys": ["Profile", "Role", "Feature Licenses", "Login History", "Permission Set Licenses", "Company Profile"]}}
```

Test each gap: take every other right block and every decoy and put it in this gap. If the sentence could still be true, or a reader cannot tell from the words around the gap which block goes there, the sentence fails. Fixes, in order of preference:

- Give each gap its own anchor in the sentence: a role, a place, a cause ("the {{Organization ID}} identifies the org; the {{User Licenses}} list counts seats").
- Fill in all but one member of a list and keep one gap for it, or keep the gaps that are not interchangeable.
- Keep 1 to 3 gaps; one good gap beats three swappable ones.

Keep the facts of the card exactly; never add a fact the `answer` does not hold. Write `decoys` for the new text by the rules above (a decoy must not fit any gap). Then `stage.py check <project> gaps` and build again.
