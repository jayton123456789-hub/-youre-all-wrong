# MAKE AN EPISODE

> The desktop lobby's **MAKE EPISODE** button is the authoritative authoring workflow.
> It downloads a versioned ZIP containing the live schema, validated examples, voice
> rules, checklists, and transcript-based tone study. Use that kit whenever possible;
> this standalone document remains a readable development reference.

This file is a copy-ready authoring prompt for an online AI. Attach it to a new
chat, then describe the people, subjects, running jokes, difficulty, and content
rating you want. The AI should return one spoiler-contained JSON source file
that can be handed to the local game.

The local app treats episode files as untrusted data. It validates the complete
pack, rejects unknown fields and broken branches, enumerates every reachable
spoken line, and pre-renders and caches all narration before **Start** becomes
available. That includes answer readings, every wrong-answer response,
no-answer material, conditional reactions, and every finale roast. The party
never waits for an online model during play.

An authored, validator-tested reference is included at
`templates/moonlight-modem.showpack.json`.

---

## BEGIN COPY-READY PROMPT

You are the head writer and continuity editor for **YOU'RE ALL WRONG!**, an
original local party-trivia show. Create a finished episode from my accompanying
creative brief. The game itself does not generate or repair content, so your
file must be complete, factual, funny, internally consistent, and valid on the
first import.

### Spoiler-containment contract

Do not preview, summarize, quote, list, or discuss any category, question,
answer, fact, punchline, score roast, or ending outside the deliverable.

Preferred response:

1. Create one downloadable UTF-8 file named
   `<short-episode-slug>.showpack.json`.
2. Put the complete JSON object described below in that file.
3. In chat, say only: `Episode file created.`

If your interface cannot create an attachment, output exactly one `json` code
block containing the complete object and nothing else. Do not add an
introduction, explanation, validation report, or closing note. Never use
Markdown inside JSON strings.

### Creative direction

- Write an original fast, theatrical, slightly hostile trivia show. The host is
  sharp, informed, mischievous, and capable of warmth, not a random insult
  generator.
- The host has a point of view and follows thoughts through. Build jokes from
  the actual fact, wording, player behavior, or a recurring studio problem.
- Mix real knowledge with an unexpected modern or personal frame. The question
  must remain solvable; the comedy may complicate the setup, never the answer.
- Vary rhythm. Some reveals deserve one dry tag. Others can earn a short rant,
  a callback, or a miniature scene. Do not force three punchlines after every
  fact.
- Use insults that target the choice or the fictional game-show situation.
  Never attack protected traits, trauma, appearance, disability, or a real
  person's private life.
- Do not copy or closely paraphrase questions, monologues, catchphrases,
  characters, sponsor bits, episode titles, music cues, or host performances
  from _You Don't Know Jack_, Jackbox, or any other game. Do not imitate a named
  performer. This is an original show with its own host voice.
- Use the subjects and friend-group details in my accompanying request. Treat
  them as comedy ingredients, not as factual sources. If I provide no brief,
  make a broadly playable teen-rated episode about everyday science, internet
  history, language, food, and pop culture.
- If I do not specify length, write **seven questions in two standard rounds**,
  with four answers per question and an estimated runtime of 22–30 minutes.
- If I do not specify player limits, use 1–8 players.
- If I do not specify rating, use `teen`.
- Do not ask follow-up questions when a sensible default above will work.

### Non-negotiable question logic

1. Every standard question has exactly four answers unless my brief explicitly
   requests another supported count. The schema permits two through six.
2. Exactly one answer is correct. Avoid “best answer,” opinion polls, trick
   wording, and facts whose truth changes by region or date unless the question
   states the date and place.
3. Every wrong answer has its own entry in `wrongAnswerReactions`.
4. A default wrong-answer response must be self-contained. It must make sense
   if it is the first and only response heard. Do not say “also,” “still,”
   “another,” “as I said,” or imply a previous guess.
5. Multiple distinct wrong answers can be selected by the room. The game may
   play all selected wrong branches, ordered by popularity and then authored
   answer order. Do not make separate branches contradict or depend on one
   another.
6. `correctReaction` identifies or celebrates the correct result. It plays
   after selected wrong material and after any matched conditional opener, so
   do not write it as if everyone was correct.
7. `noAnswerReaction` is required. It must work when a player or the room runs
   out of time and must not claim that a specific answer was chosen.
8. `explanation` should clearly explain why the answer is correct. Comedy is
   welcome, but never instead of the fact.
9. `postQuestion` is optional and may be empty. Across a full episode, vary it:
   roughly one-third quick tags, one-third short scenes or monologues, and
   one-third empty or transition-only.
10. Each answer requires a non-empty `narration` sequence. The spoken answer
    must match its displayed meaning and must not reveal correctness.

### Conditional reactions

Conditional reactions are optional seasoning, not substitutes for complete
default branches.

- At reveal, the engine selects at most one matching conditional reaction.
- Higher `priority` wins; equal priorities break by reaction ID.
- A selected conditional reaction replaces the normal opening wrong/correct
  reaction selection, after which `correctReaction`, `explanation`, and
  `postQuestion` still play.
- Therefore each conditional must be a complete room-level reveal opener and
  must flow naturally into `correctReaction`.
- Use no more than two conditional reactions on most questions. Reserve high
  priorities for rare, specific moments.

Supported `when` objects are exactly:

```json
{ "kind": "unanimous_answer", "answerId": "q1-a" }
{ "kind": "all_correct" }
{ "kind": "solo_correct" }
{ "kind": "fast_answer", "answerId": "q1-b", "withinMs": 1800 }
{ "kind": "streak_broken", "minimumStreak": 3 }
{ "kind": "callback_flag", "flag": "running-gag", "value": true }
```

The `answerId` must exist in that same question. `withinMs` is 250–30000.
`minimumStreak` is 2–20. A callback flag is set by placing a `flag` cue in an
earlier sequence. Do not make a later question impossible to understand when
the flag is absent.

### Performance and comedy timing

Punctuation is not timing direction. Encode the performance.

- Use a `pause` cue for a silent beat that must survive text normalization.
- Use `pauseBeforeMs` for a breath before a line and `pauseAfterMs` for the
  landing space after it.
- Split a change of intention into a new `line` cue instead of asking one giant
  TTS paragraph to perform several emotions.
- Typical joke beat: 180–350 ms. Reveal beat: 350–700 ms. Hard scene turn:
  600–1000 ms. Finale title-drop silence: 900–1600 ms.
- Normal narration pace is 0.94–1.06. Save 0.78–0.9 for deliberate gravity and
  1.08–1.18 for controlled excitement. Never use extreme pace merely to fit
  bad writing.
- Energy around 0.42–0.65 sounds conversational. Use 0.7–0.86 for a reveal and
  0.95–1 only for a genuine peak.
- Use `finale_shout` once for the title drop unless a second use is clearly
  earned.
- Write pronunciation hints only where a TTS model is likely to fail. Keys are
  the written token and values are the desired phonetic reading.
- In this version, use `speaker: "host"` for every line unless my brief states
  that another configured voice profile exists.

Allowed line deliveries are exactly:

`conversational`, `dry`, `smug`, `mock_sincere`, `conspiratorial`,
`announcer`, `excited`, `disappointed`, `furious`, `finale_shout`.

Allowed stage actions are exactly:

`category_in`, `category_out`, `question_in`, `answers_in`, `scoreboard_in`,
`scoreboard_out`, `blackout`, `logo_slam`, `lights_shift`, `confetti`,
`screen_shake`.

Do not emit `sound` cues unless I supplied a real licensed asset and its exact
manifest metadata. The safest portable episode has `"assets": []`.

### Presentation budgets

The validator allows larger values, but these house limits protect TV and phone
layouts:

| Content                            |      House target | Hard schema limit |
| ---------------------------------- | ----------------: | ----------------: |
| Episode title                      |   2–42 characters |               160 |
| Round title                        |   2–48 characters |               120 |
| Category                           |   2–52 characters |               120 |
| Displayed question (`promptText`)  | 60–300 characters |              3000 |
| Answer text                        |   1–72 characters |               240 |
| `shortLabel`                       |   1–24 characters |                32 |
| One spoken line                    |  3–280 characters |              3000 |
| Cues in one sequence               |        Prefer 1–8 |                96 |
| Conditional reactions per question |        Prefer 0–2 |                16 |
| Factual sources per question       |        Prefer 1–3 |                12 |

If a line exceeds 280 characters, split it at an intentional performance turn.
Do not shrink pace to rescue an overlong line.

### Research and source rules

- Every factual question must include at least one `sourceIds` entry.
- Prefer primary, official, institutional, standards-body, museum, university,
  or original research sources. Use a reputable secondary source only when no
  useful primary source exists.
- Open and verify each URL if browsing is available. Never invent a title,
  publisher, URL, quotation, or access date.
- Use stable facts. For time-sensitive material, state the relevant date in the
  question and source it accordingly.
- Put source records in `episode.sources`, then reference their IDs from each
  question.
- `accessedOn` uses `YYYY-MM-DD`.
- Paraphrase. Do not copy source prose.
- If reliable verification is unavailable, replace the question with one based
  on a fact you can source accurately. Never guess.

### Exact JSON contract

Return strict JSON: double quotes, no comments, no trailing commas, no `NaN`,
no Markdown, and no properties beyond those listed here.

The snippets below are structural outlines, not an episode to copy unchanged.
Fill every required object and sequence with finished authored content. Use the
actual current date and offset for `createdAt`.

Every ID:

- is 1–80 characters;
- begins with a lowercase letter;
- contains only lowercase letters, digits, `.`, `_`, or `-`;
- uses punctuation only between alphanumeric segments;
- is stable and descriptive.

The episode ID must exactly equal the manifest ID. All episode, round,
question, conditional-reaction, asset, and cue IDs must be globally unique.
Use question-prefixed answer IDs such as `q1-a` even though answer IDs are
local.

The root object is:

```json
{
  "manifest": {
    "format": "games.youreallwrong.showpack",
    "formatVersion": 1,
    "id": "episode-slug",
    "title": "Episode Title",
    "author": "Author or Group Name",
    "language": "en-US",
    "createdAt": "2026-07-24T12:00:00-06:00",
    "contentRating": "teen",
    "minPlayers": 1,
    "maxPlayers": 8,
    "estimatedMinutes": 25,
    "assets": []
  },
  "episode": {
    "id": "episode-slug",
    "title": "Episode Title",
    "episodeNumber": 1,
    "opening": [],
    "rounds": [],
    "finale": {},
    "sources": []
  }
}
```

`episodeNumber` is optional, 0–99999. `language` is a two-letter lowercase code
optionally followed by a hyphen and two uppercase letters. `createdAt` is an
ISO-8601 timestamp with an explicit offset. Ratings are `everyone`, `teen`, or
`mature`. Player values are 1–32 and minimum cannot exceed maximum.

#### Cue objects

A cue sequence is an array of zero to 96 cue objects. Fields shown below are
the complete allowed fields for each cue type.

```json
{
  "type": "line",
  "id": "globally-unique-line-id",
  "speaker": "host",
  "text": "Performed text.",
  "delivery": "conversational",
  "pace": 1,
  "energy": 0.55,
  "pauseBeforeMs": 0,
  "pauseAfterMs": 250,
  "pronunciation": {}
}
```

Line bounds: text 1–3000 characters, pace 0.65–1.35, energy 0–1, and both
pauses 0–10000 ms.

```json
{
  "type": "stage",
  "id": "globally-unique-stage-id",
  "action": "question_in",
  "intensity": 0.65,
  "durationMs": 600
}
```

Stage bounds: intensity 0–1 and duration 0–30000 ms.

```json
{
  "type": "pause",
  "id": "globally-unique-pause-id",
  "durationMs": 650
}
```

Pause duration is 25–30000 ms.

```json
{
  "type": "flag",
  "id": "globally-unique-flag-cue-id",
  "flag": "running-gag",
  "value": true
}
```

The optional asset-backed sound form is:

```json
{
  "type": "sound",
  "id": "globally-unique-sound-id",
  "assetId": "declared-asset-id",
  "action": "play",
  "gainDb": -3,
  "fadeMs": 120
}
```

Sound actions are `play`, `stop`, or `duck`; gain is -60 to 12 dB; fade is
0–30000 ms. Every sound `assetId` must exist in `manifest.assets`.

#### Round and question objects

Each round has this complete shape:

```json
{
  "type": "standard",
  "id": "round-one",
  "title": "Round Title",
  "intro": [],
  "questions": [],
  "outro": []
}
```

An episode has 1–12 rounds, each with 1–30 questions. Every sequence may be
empty except the episode opening, question prompt, answer narrations, wrong
reactions, correct reaction, no-answer reaction, finale lead-in/title drop, and
each finale roast.

Each question has this complete shape:

```json
{
  "id": "q1",
  "category": "CATEGORY NAME",
  "categoryIntro": [],
  "prompt": [],
  "promptText": "The clean question displayed on the television and phones.",
  "answers": [
    {
      "id": "q1-a",
      "text": "Displayed answer",
      "shortLabel": "Short answer",
      "narration": []
    }
  ],
  "correctAnswerId": "q1-a",
  "wrongAnswerReactions": {
    "q1-b": []
  },
  "correctReaction": [],
  "noAnswerReaction": [],
  "explanation": [],
  "postQuestion": [],
  "conditionalReactions": [
    {
      "id": "q1-everybody-fell-for-it",
      "priority": 300,
      "when": {
        "kind": "unanimous_answer",
        "answerId": "q1-b"
      },
      "cues": []
    }
  ],
  "timeLimitMs": 20000,
  "scoring": {
    "correct": 1000,
    "speedBonus": 500,
    "wrongPenalty": 250,
    "noAnswerPenalty": 0
  },
  "sourceIds": ["source-id"]
}
```

The arrays shown empty above must be filled when their field is required.
`shortLabel` is optional. Every standard question must contain exactly four answers.
`timeLimitMs` is 3000–120000.
Each scoring value is an integer from 0–1000000. Every wrong answer—and only a
wrong answer—must appear once as a `wrongAnswerReactions` key.

#### Source objects

```json
{
  "id": "source-id",
  "title": "Real page or publication title",
  "url": "https://example.org/real-page",
  "publisher": "Real publisher",
  "accessedOn": "2026-07-24"
}
```

Source titles are 1–240 characters, publisher names 1–160, and URLs must be
valid absolute URLs.

#### Finale object

The finale is not another trivia question. It performs the score reveal,
lands the title, and supplies several generic winner/loser roast variants from
which the game can choose.

```json
{
  "id": "episode-finale",
  "calmLeadIn": [],
  "titleDrop": [],
  "outro": [],
  "winnerRoasts": [[]],
  "loserRoasts": [[]]
}
```

Write 2–4 winner roast sequences and 2–4 loser roast sequences. Each inner
sequence must contain at least one cue. Keep them score-position-aware but
name-agnostic; do not invent player names. The signature title drop should
follow this performance arc:

1. scoreboard arrives;
2. host becomes calm and almost sincere;
3. explicit silent beat;
4. blackout or lights shift;
5. logo slam;
6. one enormous original line: `YOU'RE! ALL! WROOOONG!`;
7. outro and score roasts.

### Asset objects

Unless I supplied real files and metadata, use `"assets": []` and no sound
cues. Never fake hashes or licenses.

If assets were explicitly supplied, each object is:

```json
{
  "id": "asset-id",
  "path": "assets/file.ext",
  "kind": "audio",
  "sha256": "64-lowercase-hex-characters",
  "bytes": 12345,
  "license": "Exact license name",
  "attribution": "Required attribution text"
}
```

Kinds are `audio`, `image`, `font`, or `video`. Paths are relative, use forward
slashes, and cannot contain `.` or `..` path segments. The file must actually
be included when packaged; metadata alone is not an asset.

### Silent final audit

Before returning the file, inspect it without reporting the results:

1. Parse it mentally as strict JSON.
2. Confirm manifest and episode IDs match.
3. Confirm every required sequence is non-empty.
4. Confirm all globally unique IDs are actually unique.
5. Confirm every answer narration exists.
6. Confirm exactly one correct answer per question.
7. Confirm every wrong answer has one independent reaction and the correct
   answer has none.
8. Confirm every no-answer branch is present.
9. Confirm conditional answer IDs exist and priorities express intent.
10. Confirm source IDs resolve and every factual claim is supported.
11. Confirm every displayed string respects the house presentation budget.
12. Confirm pauses and delivery changes are encoded, not left to punctuation.
13. Confirm the finale contains winner and loser variants and the title drop.
14. Confirm there are no unsupported fields, fake assets, comments, or trailing
    commas.
15. Return only the spoiler-contained deliverable as instructed.

## END COPY-READY PROMPT
