# Showpack v1

A `.showpack` is an inert ZIP archive. It contains authored data and declared
media, never executable code.

MIME type planned for release:
`application/vnd.youreallwrong.showpack+zip`.

```text
manifest.json
episode/script.json
assets/...
```

## Import pipeline

1. Reject an oversized compressed archive.
2. Stream entries with total, single-file, entry-count, and compression-ratio
   limits.
3. Reject absolute paths, traversal, backslashes, NULs, drive paths,
   duplicates, and case-fold collisions.
4. Require `manifest.json` and `episode/script.json`.
5. Parse UTF-8 JSON with size limits.
6. Reject unknown schema fields.
7. Validate IDs, player limits, answer integrity, sources, reactions, and cue
   references.
8. Reject undeclared files.
9. Verify every declared asset's byte count and SHA-256.
10. Hash the canonical episode and original archive.

No content from a pack is interpreted as HTML, CSS, JavaScript, a filesystem
path outside the archive, or a network request.

## Question requirements

Every multiple-choice question contains:

- Stable ID and category
- Display prompt and performed prompt cues
- Exactly four stable answer IDs
- One correct answer ID
- A complete independent reaction for every wrong answer
- Correct-answer reaction
- Optional explanation and variable-length post-question scene
- Optional typed conditional reactions
- Explicit timing and named scoring values
- Zero or more factual source references

The engine plays all distinct wrong answers that the room selected. It orders
them by selection count, then authored answer order. A conditional variant can
replace that opening reaction only through one of the engine's typed
conditions; arbitrary expressions are not accepted.

Supported conditions in v1:

- Everyone selected one answer
- Everyone was correct
- Exactly one player was correct
- A specific answer arrived within a threshold
- A correct streak was broken
- A previously authored callback flag is set

## Performance cues

Spoken lines use renderer-neutral direction:

```json
{
  "type": "line",
  "id": "results-title-line",
  "speaker": "host",
  "text": "YOU'RE! ALL! WROOOONG!",
  "spokenText": "And after all that: you're all wrong!",
  "delivery": "finale_shout",
  "pace": 0.85,
  "energy": 1,
  "pauseBeforeMs": 0,
  "pauseAfterMs": 700,
  "pronunciation": {}
}
```

`text` is the on-screen/caption form. Optional `spokenText` is the natural
sentence sent to the voice renderer. Use it when display typography is not good
speech input: isolated category titles, acronyms, symbols, vocal stretching,
or deliberately fragmented text. The cache follows `spokenText`, so changing
only the visual title does not recook audio.

For example, display `MINECRAFT: THE HEAVY UPDATE`, but speak
`And now, Minecraft: The Heavy Update.` Proper names are more reliable inside
a natural sentence than as an isolated all-caps title.

Comedy timing is explicit. It does not depend on punctuation surviving a TTS
model's text normalization.

Available delivery styles:

- `conversational`
- `dry`
- `smug`
- `mock_sincere`
- `conspiratorial`
- `announcer`
- `excited`
- `disappointed`
- `furious`
- `finale_shout`

Stage and audio actions come from a closed registry. Packs cannot invent
commands.

## Building the bundled demonstration

```powershell
npm.cmd run pack:demo
```

The build writes `dist/showpacks/terms-and-conditions.showpack`, immediately
imports it through the hostile-input path, and prints both archive and episode
hashes. The round trip is a release check, not merely an export.
