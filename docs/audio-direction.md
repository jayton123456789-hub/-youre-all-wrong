# Audio Direction

Status: active production brief for the private alpha.

## Copyright boundary

A private reference ZIP supplied during development contains nine MP3 files from
_the You Don't Know Jack 2011_ soundtrack. Those files are **reference only**.
They must not be committed, bundled, redistributed, sampled, remixed, traced,
or used as temporary shipping assets.

The useful lesson is structural rather than musical: a hosted trivia show needs
many short, state-specific musical identities instead of one background loop.
All final music and sound effects for **YOU'RE ALL WRONG!** must be original or
properly licensed for redistribution.

## Reference inventory reviewed

The private ZIP was inspected without adding it to the repository:

| Reference role | Approximate duration |
| --- | ---: |
| Title screen | 83.0 s |
| Main theme | 90.5 s |
| Special-round theme | 128.1 s |
| Waiting/lobby cue | 67.9 s |
| Question-in-session jingle collection | 492.2 s |
| Question-answered jingle collection | 276.8 s |
| Intermission | 110.3 s |
| High-danger sting | 30.4 s |
| Ending tune collection | 61.0 s |

Durations are recorded only to estimate how much original material the game
will eventually need.

## Original music package to build

The first shippable audio package should include:

1. **Boot ident** — 2–4 seconds; original studio/logo hit.
2. **Title loop** — 45–90 seconds; seamless and low-fatigue.
3. **Lobby loop** — 60–120 seconds; playful waiting energy with clean loop
   points and room for host speech.
4. **Episode opening bed** — 30–60 seconds; duckable under narration.
5. **Category bumpers** — at least 8 short variations.
6. **Question beds** — at least 12 variations split across calm, tense, absurd,
   and high-energy families.
7. **Answer-board clock bed** — loopable 20-second structure with a final-five
   escalation layer rather than a copied countdown melody.
8. **Correct stings** — at least 8 variations.
9. **Wrong stings** — at least 8 variations.
10. **No-answer sting** — distinct from an ordinary wrong answer.
11. **Reveal bed** — supports grouped verdicts and ducks cleanly under the host.
12. **Intermission/round transition** — 30–60 seconds.
13. **Finale build** — calm lead-in, silence pocket, original title-drop impact,
    and score-roast bed.
14. **Credits/end loop** — 45–90 seconds.

## Runtime behavior

- Music is state-driven by the authoritative show timeline.
- Host speech has priority. Beds must duck automatically while a line plays and
  recover over an authored fade.
- Short stings may interrupt a bed; long tracks should not restart on unrelated
  state revisions.
- Every loop requires tested sample-accurate or perceptually clean loop points.
- Loudness must be normalized across the package before release.
- The game needs independent controls for host voice, music, and sound effects.
- Muting the host must never mute gameplay feedback required to understand a
  lock, timeout, or verdict.

## Asset intake rule

Do not place arbitrary downloaded music in `assets/`. A track may enter the
project only with:

- a clear redistribution license or original ownership;
- source/provenance information;
- creator attribution when required;
- intended game state and loop behavior;
- normalized master and encoded delivery files;
- checksum and manifest entry.
