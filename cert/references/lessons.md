# Stage 3: topic lessons (one subagent per domain)

The deck teaches each card before it tests it. The first card of every topic opens with a short lesson for the whole topic. You write those lessons for one domain.

## Input

`parts/DD/NN-slug.json`: one file per topic with `topic`, `intro` and `items`. Read every topic file of the domain completely, and `notes/DD *.md` (the cheat sheet). cert.json gives the learner's language (`exam.learnerLanguage`) and `exam.notes`.

## Output

`lessons/DD.json`: topic file name without `.json` to lesson markdown, for every topic file:

```json
{ "01-company": "markdown...", "02-ui": "markdown..." }
```

## The lesson

- The learner's language, with the vendor's terms exactly as written (never translated). 150 to 280 words (cert.json `lessonWords` can change the range).
- After reading, the learner can answer the topic's cards. Explain the concepts in the order the cards come: the lesson is the map, the cards fill it in.
- Shape: one opening sentence on what this topic is and why the exam asks about it; the core ideas as short paragraphs or bullets; a small table where a comparison helps (tool vs use case, limit vs number); end with a bold line naming the exam traps (Dutch: `**Examenvallen:**`) and two or three traps the questions use.
- Only facts from the topic's cards or the cheat sheet. Nothing invented.
- No headings above level 3. No em dashes. Never hard-wrap: each paragraph is one line. No filler ("In this topic we will..."), no closing summary. No `{{` or `}}`.

Validate: `python3 <kit>/stage.py check <project> lessons`. Report the word count per lesson.
