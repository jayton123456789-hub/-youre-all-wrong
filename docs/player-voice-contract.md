# Player Voice and Reveal Contract

Status: active runtime contract.

## Player identity

Players may enter any display name on their phone. Display names are visual UI
only and are never synthesized during a live match.

Spoken host references use stable seat labels:

- Player one
- Player two
- Player three
- Player four
- Player five
- Player six
- Player seven
- Player eight

Seat number is `joinOrder + 1` and does not change when a controller disconnects
or resumes. The host must never guess how a player-entered name is pronounced.

## Pre-rendered seat callouts

Before **Start** unlocks, the voice preflight includes eight reusable seat callouts:

- `Player two.`
- `Player five.`
- `Player eight.`

These clips are content-addressed and reused across episodes after the first render.
Groups are identified visually while the answer reaction plays once, then each matching
player receives an individual spoken seat callout and score settlement. This preserves the
one-by-one television reveal without pre-rendering 255 possible seat combinations. No
player label is generated during gameplay.

## Reveal grouping

A reveal reaction belongs to an answer choice, not to each individual player.

When several players choose the same answer:

1. The answer group is identified visually and its authored reaction plays once.
2. The host calls each stable seat number as that player's score settles.
3. The same roast does not replay for every member of the group.

Default group order is:

1. Selected wrong answers, most popular first; ties use authored answer order.
2. No-answer players.
3. Correct-answer players.
4. Correct-answer explanation and optional post-question material.

The correct reaction plays exactly once. It also plays when nobody selected the
correct answer so the host can identify the actual result.

A matched conditional reaction replaces the ordinary opening answer reactions.
It plays once for the room, followed by the normal correct reaction,
explanation, and post-question material.

## Pronunciation hints

A line cue's `pronunciation` object maps written tokens or phrases to the text
the local voice should speak. Replacement is:

- case-insensitive;
- longest-entry-first;
- limited to complete tokens or phrases, not matching letters inside unrelated
  words;
- included in the voice cache key.

Example:

```json
{
  "text": "The GIF argument has entered the courtroom.",
  "pronunciation": {
    "GIF": "jiff"
  }
}
```

Changing a pronunciation hint invalidates only that spoken clip. Use hints only
for words the selected voice is likely to mispronounce.
