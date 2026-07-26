# Local Voice Pipeline

The host is original, expressive, reproducible, and fully local. The project does not
train on Jackbox gameplay or imitate Tom Gottlieb, Cookie Masterson, or any identifiable
performer.

## Production flow

```text
Import episode
→ validate every branch and enumerate every reachable spoken cue
→ verify Voice 2 approval, reference hash, runtime receipt, model hashes, and worker
→ render every missing cue with Qwen3-TTS Base
→ add literal 200 ms zero-sample guards
→ run offline waveform and Whisper transcript QA on every cue
→ verify complete cue coverage and build the playback manifest
→ preload host speech
→ unlock Start
→ play cached WAV files with no model work during the match
```

Qwen3-TTS 0.6B Base is the episode renderer. It creates a reusable voice-clone prompt
from the exact approved Voice 2 WAV and transcript. The 1.7B VoiceDesign model was used
only to create the audition; production players do not download it.

The approved reference is candidate `qwen-host-02`, seed `1730324455`, SHA-256
`1cd786f2cf9c15bf66e116ca46dd391d58a3d812843f290229aebbec6014efdd`. It passed
leading-word, ending-word, waveform, onset, and zero-word-error transcript checks before
human approval.

## Worker boundary

The trusted TypeScript preflight writes a bounded JSON manifest and launches one isolated
Python worker. The worker:

- operates with Hugging Face and Transformers in offline mode;
- loads only revision-pinned local Base and ASR directories;
- verifies the immutable approval document and reference hash;
- refuses duplicate cue IDs, output paths, pre-existing outputs, unsafe IDs, or oversized
  text;
- writes to temporary files and promotes clips only after the complete batch passes QA;
- emits typed completion progress only after each cue has passed QA;
- never receives player-entered display names and is never exposed to the LAN.

There is no pitch shifting, tempo stretching, normalization, amplitude trimming, model
fade, or voice-changing post-process. The only waveform addition is literal zero-sample
guard silence to protect first and final consonants.

## Runtime trust

The one-click Windows setup installs into a unique staging environment. It downloads
exact model revisions, hashes the complete required file inventory, loads both production
models without generating audio, writes a schema-versioned receipt, and atomically
promotes the verified runtime. A previous working runtime is restored if the promoted
environment fails its final-path probe.

Loose setup and worker resources are checked against hashes stored inside Electron's
integrity-protected application bundle. The persisted profile, approval, reference,
runtime contract, model inventory, and package versions must all agree before selection.

## Cache identity

Each cue cache key covers:

- engine and package versions;
- Base and ASR repositories and revisions;
- runtime contract and QA-policy revisions;
- approval and reference hashes;
- normalized spoken text;
- delivery, pace, energy, and scripted pauses;
- pronunciation substitutions and their algorithm revision;
- generation seed and generation settings;
- the explicit no-pitch/no-tempo/no-trim post-processing policy.

Changing one roast rerenders one roast. Changing Voice 2, its approval, the generation
contract, or a model revision invalidates every affected line.

## Audio QA

Every new clip must satisfy:

- valid bounded mono audio with finite samples;
- no raw sample outside the legal full-scale range;
- a low maximum full-scale sample ratio;
- detected speech with bounded onset and trailing silence;
- plausible duration for the expected word count;
- the expected first and last spoken word;
- word error rate at or below the pinned policy threshold.

If any line fails, no clip in that render batch is promoted and **Start remains locked**.
Human listening is still required to approve a new host identity because automated QA
cannot decide whether a voice is appealing or whether a joke lands.

## Distribution

The current Windows host installs its runtime once and reuses content-addressed speech
across episodes. Python and the GPU/CPU are idle while a cooked match is playing.

Embedding approved speech into exported `.showpack` files so another host PC needs no
local model installation remains a future distribution mode.
