# Host Voice Direction

The Host is an original synthetic character, not an imitation of a recognizable actor,
game-show presenter, celebrity, streamer, or existing character.

## Approved identity

The owner approved `qwen-host-02` exactly as rendered on 2026-07-25.

- Voice ID: `original-host-v1`
- Display name: `The Host`
- Casting seed: `1730324455`
- Engine: Qwen3-TTS 1.7B VoiceDesign
- Episode renderer: Qwen3-TTS 0.6B Base
- Reference SHA-256:
  `1cd786f2cf9c15bf66e116ca46dd391d58a3d812843f290229aebbec6014efdd`
- Transcript word error rate: `0`
- Detected onset: `233 ms`

The reference must remain byte-identical. Do not normalize, trim, fade, stretch, compress,
pitch-shift, denoise, remaster, or otherwise “improve” it.

## Character

He is the smartest asshole in the room and is privately delighted that everyone agreed
to prove it on camera.

- Mature American male voice in a warm, lean middle register
- Precise diction without theatrical over-enunciation
- Agile conversational timing and pitch that follows the thought
- Inviting but skeptical by default
- Momentum through a setup, then an understated punchline
- Dry studio sound without broadcast boom or commercial polish
- No resemblance to a named person

## Performance rules

The Host:

- sounds as if he knows the answer and has been waiting for the room to catch up;
- lets authored pauses land jokes;
- reads factual setup cleanly before decorating a punchline;
- shifts energy because the thought changed, not because a preset demanded random drama;
- treats each question as a scene rather than a pile of unrelated one-liners;
- roasts a decision, confidence, or situation instead of reaching for generic insults.

He never:

- begs for applause;
- sounds like corporate training narration;
- shouts every reveal;
- explains a joke after it lands;
- sacrifices answer clarity for speed;
- changes accent or identity between delivery modes;
- imitates a real performer.

## Delivery metadata

Showpacks retain these semantic delivery labels:

| Mode             | Writing and performance intent                                  |
| ---------------- | --------------------------------------------------------------- |
| `conversational` | Clean factual setup with a private smile                        |
| `dry`            | Restrained pitch movement and one exact stress                  |
| `smug`           | Lightly amused confidence with a precise landing                |
| `mock_sincere`   | Warm setup, small pivot pause, cooler reveal                    |
| `conspiratorial` | Lower energy and deliberate space                               |
| `announcer`      | Ceremonial authority without artificial bass                    |
| `excited`        | Broader movement and shorter gaps, not merely louder            |
| `disappointed`   | Restrained disbelief rather than sadness                        |
| `furious`        | Controlled theatrical outrage, used sparingly                   |
| `finale_shout`   | Calm lead-in, full breath, one title hit, immediate comic reset |

The current Base clone renderer validates these labels and includes them in cache identity,
but does not fake them with waveform pitch or tempo effects. Expressive variation comes
from the approved identity, authored punctuation, wording, and Qwen's natural generation.
Additional style references require a separate listening approval before production use.

## Replacement policy

A replacement requires a new audition directory, seed, written direction, exact model
revision, waveform QA, offline transcript QA, and human listening approval. The new
approval must update the protected resource manifest and intentionally invalidate all
cached host speech.
