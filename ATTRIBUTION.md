# Attribution and Asset Provenance

No Jackbox art, audio, transcripts, music, characters, logos, or voice
recordings are included.

## Packaged visual dependencies

| Asset          | Use                  | License                   | Source                                                           |
| -------------- | -------------------- | ------------------------- | ---------------------------------------------------------------- |
| Bebas Neue     | Display typography   | SIL Open Font License 1.1 | [Fontsource package](https://fontsource.org/fonts/bebas-neue)    |
| Space Grotesk  | Interface typography | SIL Open Font License 1.1 | [Fontsource package](https://fontsource.org/fonts/space-grotesk) |
| Phosphor Icons | Interface symbols    | MIT                       | [Phosphor Icons](https://phosphoricons.com/)                     |

The current interface background, logo treatment, transitions, particles,
timer, meters, and UI sounds are original procedural CSS/Web Audio work in this
repository. They are not temporary image or sound placeholders.

The application icon in `assets/branding` was generated for this project with
OpenAI's built-in image-generation tool on 2026-07-24, then locally
chroma-keyed and converted into the Windows icon size set. Its prompt and
unaltered chroma source are retained in the project history. No existing logo
or game artwork was used as a reference.

## Original host voice

The packaged `original-host-v1` reference is an original synthetic identity
created from written traits. It is not a recording of, or an attempt to
imitate, a recognizable person. Its immutable seed, prompts, model revisions,
and file hashes are recorded beside the asset in
`assets/voice/original-host-v1/provenance.json`.

Model binaries download to the creator PC during local voice setup; they are
not committed to this repository or bundled inside the application.

| Model                           | Intended use                                   | License    | Source                                                              |
| ------------------------------- | ---------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| Qwen3-TTS 12Hz 1.7B VoiceDesign | One-time original Voice 2 casting              | Apache-2.0 | [Qwen](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) |
| Qwen3-TTS 12Hz 0.6B Base        | Local episode speech in the approved identity  | Apache-2.0 | [Qwen](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base)        |
| Whisper small.en                | Offline generated-line transcript QA           | Apache-2.0 | [OpenAI](https://huggingface.co/openai/whisper-small.en)            |
| PyTorch and Torchaudio          | Local model execution and audio tensor support | BSD-style  | [PyTorch](https://pytorch.org/)                                     |

Any future visible or audible asset must record creator, source URL, license,
modifications, and file hash before it can enter a release build.
