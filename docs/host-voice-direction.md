# Host Voice Direction

The host is an original character, not an imitation of a recognizable actor, game-show
presenter, celebrity, streamer, or voice pack.

## Character

He is the smartest asshole in the room and is privately delighted that everyone agreed
to prove it on camera.

- Mature American male voice with a warm mid-low register.
- Pompous in a playful, theatrical way—not a radio announcer or movie-trailer voice.
- Crisp diction, elastic pitch, conversational speed, and deliberate comic pauses.
- Smug and controlled by default; rarely angry.
- Capable of conspiratorial whispers, mock sympathy, sudden excitement, and one enormous
  finale reveal.
- Roasts the decision, confidence, or situation. He does not rely on generic name-calling.

## Performance rules

The host always:

- sounds like he knows the answer and has been waiting for the room to catch up;
- lets pauses land the joke;
- changes energy because the thought changed, not because a preset demanded random drama;
- reads factual setup cleanly before decorating the punchline;
- treats each question like a small scene rather than a stack of interchangeable one-liners.

The host never:

- begs for applause;
- sounds like corporate training narration;
- shouts every reveal;
- explains a joke after it lands;
- speaks so quickly that setup, answer text, or facts become unclear;
- clones or deliberately resembles a real person without an explicit written voice-cloning
  and redistribution release.

## Delivery modes

| Mode             | Direction                                                  |
| ---------------- | ---------------------------------------------------------- |
| `conversational` | Clear factual setup with a quiet smile.                    |
| `dry`            | Minimal pitch movement; the pause carries the insult.      |
| `smug`           | Lightly amused confidence with a precise punchline.        |
| `mock_sincere`   | Warm concern that slowly reveals itself as a trap.         |
| `conspiratorial` | Lower energy, closer delivery, deliberate space.           |
| `announcer`      | Ceremonial game-show authority without movie-trailer bass. |
| `excited`        | Faster and brighter, but still intelligible.               |
| `disappointed`   | Restrained disbelief rather than sadness.                  |
| `furious`        | Controlled theatrical outrage; used sparingly.             |
| `finale_shout`   | The one full title-drop explosion the episode earns.       |

## Original synthetic identity workflow

When no consenting performer is available:

1. Run `services/setup-host-foundry.ps1`.
2. Run `services/forge-host-voices.ps1 -OpenFolder`.
3. Audition every Apache-2.0 Parler-TTS candidate and reject anything that happens to
   resemble a recognizable person.
4. Pass the strongest candidate to `services/audition-chatterbox.ps1`.
5. Approve the identity only after testing long setup, short roast, whisper, excited reveal,
   and finale lines.
6. Save the chosen WAV, its manifest, exact seed, model revision, and written direction.
7. Use that WAV as Chatterbox Turbo's permanent reference; cook every reachable episode
   line before Start unlocks.

Parler-TTS is a one-time voice foundry. Chatterbox Turbo remains the production episode
renderer.
