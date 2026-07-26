# Reference pacing model

This project studies the pacing grammar of several _You Don't Know Jack (2011)_
gameplay captures without copying its script, art, trademarks, or recordings.
Reference media and machine transcripts remain local and are never distributed.

## Standard question timeline

| Beat                   |                               Measured target |
| ---------------------- | --------------------------------------------: |
| Number transition      |                    3.5–6.0 s, allowed to vary |
| Category card          |                                at least 1.8 s |
| Prompt board           |                 enters with the spoken prompt |
| Answer board + clock   |             enters at the first spoken answer |
| Answer list narration  |       normally 4–7 s for four concise choices |
| Answer window          |               20 s from answer-board entrance |
| Neutral selection hold |               about 0.5 s before the reaction |
| Verdict/roast          | selection remains staged until its line lands |
| Score projectile       |                                     0.8–1.0 s |
| Settled-score hold     |              about 0.6 s before the next beat |

## Frame-measured samples

Times below are offsets within locally held reference captures. They are retained as
timing evidence only; the captures and machine transcripts are excluded from Git.

| Sample                     | Category | Prompt board | Answers + clock | Reveal starts | Correct color | Score settles | Next number |
| -------------------------- | -------: | -----------: | --------------: | ------------: | ------------: | ------------: | ----------: |
| Wii, episode 1, question 1 |  248.5 s |      251.0 s |         256.5 s |       262.0 s |       270.0 s |       273.0 s |     274.0 s |
| PC, episode 1, question 1  |   90.0 s |       92.5 s |          97.5 s |       101.5 s |       108.0 s |       109.5 s |     112.0 s |
| Wii, episode 1, question 2 |  280.0 s |      285.0 s |         292.0 s |      319.0 s¹ |       341.0 s |       346.0 s |     349.0 s |

¹ This sample includes an activated five-second sabotage mechanic. It is not used as the
normal reveal delay, but it demonstrates that the board remains spatially stable through
an interrupt and multiple verdict groups.

The category duration is intentionally elastic because the category name and transition
gag vary. Prompt and answer timing are driven by speech boundaries, not hard-coded video
lengths. The clearest invariant is that the correct marker does not turn green at lock-in:
the host's evidence-led explanation creates suspense before color and score resolve.

## Behavioral rules

- Reading the prompt never consumes answer time.
- A player can lock as soon as the answer board appears.
- The first accepted answer interrupts remaining answer narration.
- Reveal begins when every eligible player has locked or the clock expires.
- Group reactions must not reveal correctness before the host's line lands.
- Correct responses should reveal through the decisive fact, not generic congratulations.
- Correct score transfers wait until the evidence-led explanation has landed.
- Scores remain visually unchanged until their corresponding result animation arrives.
- Long explanations and post-question scenes are authored beats, not a fixed delay.
