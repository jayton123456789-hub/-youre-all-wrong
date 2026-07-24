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

## Voice models under evaluation

Model binaries are not currently distributed.

| Model      | Intended use                    | License    | Source                                                   |
| ---------- | ------------------------------- | ---------- | -------------------------------------------------------- |
| Chatterbox | Local episode speech rendering  | MIT        | [Resemble AI](https://github.com/resemble-ai/chatterbox) |
| Qwen3-TTS  | Original synthetic host casting | Apache-2.0 | [QwenLM](https://github.com/QwenLM/Qwen3-TTS)            |

Any future visible or audible asset must record creator, source URL, license,
modifications, and file hash before it can enter a release build.
