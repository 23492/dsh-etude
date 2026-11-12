# Design: why a certification deck looks like this

This is the reasoning behind every rule in the skill, built and measured on the Salesforce Platform Administrator deck (November 2026: 962 concept cards, 352 practice questions, 2 sealed mock exams of 60). Change a rule only with a reason at least as strong as the one given here.

## The goal

Pass a multiple-choice exam with as little study time as possible and no blind spots. Everything is judged against that: a card form the exam never asks for is cost without benefit.

## Concept cards: teach first, then a ladder of forms

- **Teach before test.** A new card first shows the material (the teach step, `learner.goal = teach`). The big button counts as Good in one tap; a small "already knew this" button counts as Easy. Gizmo-style "memorise" done properly.
- **Each form is its own card (face).** Recognise (MC) then produce (cloze, typed, match, order). FSRS stability and difficulty are defined through recall probability for one question as asked; making one card harder in place collapses stability after the first harder review and inflates difficulty for good (FSRS-6 mean reversion is 0.001). So each rung has its own memory state.
- **Support only while learning.** Hints (first letter, one pair placed, first step placed) appear in learning and relearning and while no card of the item is in review yet. In review the card is unaided, so FSRS sees comparable evidence (diminishing cues, Finley et al. 2011).
- **MC stays.** For an MC exam, recognition with competitive lures and per-option feedback is not a rung to outgrow (Little et al. 2012; Butler & Roediger 2008). A free-recall rung for every concept was simulated and dropped: it nearly doubled week-6 load (42 to 78 min/day) for a skill the exam does not test.
- **No hard gate.** Etude has no per-face unlock. The ladder comes from face order (new cards arrive by item order, then face order), `burySiblings` (next rung not the same day), and the support fallback: a one-entry `variants` list whose `requires` is the item itself, so Etude annotates `_known`.
- **Topic lessons.** The first concept card of each topic carries a 150 to 280 word lesson in the learner's language, ending with the traps the exam uses. The lesson is the map, the cards fill it in.

## Exam questions: practice with feedback, plus sealed mock exams

- **Never drill exam questions.** A repeated question gets easier and then measures recognition of that question, not the skill (Hausknecht et al. 2007). But never practising with them loses transfer: practice in the exam's own form is what carries over to new scenario questions (Agarwal 2019; Pan & Rickard 2018, transfer d = 0.40).
- **Split the bank.** About two exams' worth (2 x the real exam length) is sealed as mock exams weighted like the blueprint, apply and analyse level only, no quality flags, at most one question per near-duplicate cluster; questions in the same cluster as a mock question leave the practice pool. Readiness comes only from the mocks.
- **The rest are practice questions:** no teach step, no hints, plain MC with a small "I'm guessing" button. Right the first time: done. Wrong, or right after "I'm guessing": the concept cards behind it come back now, and the question comes back once after 4 days, then done. Rating-free (custom scheduler), so there are no rating buttons.
- **Released by the concepts, not by a topic gate.** A practice question waits until every concept card it depends on is in review, then arrives 3 days after the last of those was first studied, mixed with every other released topic (interleaving, as Math Academy quizzes). A topic gate on 2 to 23 questions is mostly chance: with 4 questions someone who truly knows 65% passes a 75% gate 56% of the time.
- **Link every question to its concepts.** `teaches` (1 to 3 concept items) per question. In the SF bank 35% of the questions tested something no card taught; the repair stage writes those cards. A miss then sends the learner to exactly the cards that teach the deciding fact (AMBOSS, AnKing, Math Academy all do this).
- **Book at 75% on unseen mocks.** With 75% true mastery, the chance to pass at a 68% cut-off with 60 questions is about 91%; at 70% it is 67% (binomial). Adjust for the exam's own length and pass mark.
- **Less support:** pretests (lab effect, little in a real course, Carpenter 2018), confidence ratings beyond one optional guess button (an extra tap), error-reason tagging, AI-generated question variants (wrong keys).

## Option-length cue

Generated MC options show a classic cue: the correct option was strictly the longest about 60% of the time (chance about 25%) and 1.25 to 1.30 times as long as the wrong ones. Learners notice within a few cards. Official and real-bank questions do not have it (median ratio 1.02). Measure after every generation stage and rebalance (balance.md). Targets: correct strictly longest at most 30%, median correct/wrong length ratio 0.9 to 1.1, longest option at most 1.4 times the shortest.

## Card UI rules (from a UI review with the learner)

- Only the material on the card: no badges, rung labels, rating tips, instructional placeholders or help lines. The form speaks for itself; hints look like hints.
- Teach step: one tap = Good (the card script posts the runtime's key message `parent.postMessage({etude:1,type:"key",key:"3"})` after the result; the "known" button posts "4"). Internal protocol, not a documented API: re-test after Etude updates.
- Lesson is a collapsible `<details>`, remembered in prefs. Exam explanations list each option on its own line, the correct one marked with a border, no glyphs (fonts on phones miss them).
- Phone: `hyphens: manual`, no card-in-card frame, one font family, `kbd` hidden on touch. The card script re-applies the theme variables (Etude's browser build puts the frame's base CSS after the theme).

## Workload

`kit/sim.js` and `kit/sim2.js` run Etude's own ts-fsrs over the pack. For SF (962 concept cards + 352 practice, 48 new/day, at most 12 of them practice): about 47 min/day in week 1, 70 at the peak (weeks 3 to 4), 23 in week 6; every concept seen by day 30. Choose `newPerDay` so the peak fits the learner's day and every concept is seen two weeks before the exam.

## What was measured, what was judged

Measured (scripts): length-cue statistics, workload, the planner's behaviour on a copy of the collection, the binomial pass chances. Judged by one model pass without a second rater: question level, coverage, quality flags, clusters. Treat the judgments as good guesses: the learner reports a wrong card, it gets fixed.
