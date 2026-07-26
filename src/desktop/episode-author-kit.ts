import { createHash } from 'node:crypto';

import { strToU8, zipSync } from 'fflate';
import { toJSONSchema } from 'zod';

import { demoPack } from '../content/demo-pack.js';
import { EPISODE_AI_STARTER_PROMPT } from '../domain/showpack/author-prompt.js';
import { ShowpackSchema, type Showpack } from '../domain/showpack/schema.js';
import { validateShowpack } from '../domain/showpack/validate.js';

export const EPISODE_AUTHOR_KIT_FILENAME = 'YOU-ARE-ALL-WRONG-EPISODE-AUTHOR-KIT.zip';
export const EPISODE_AUTHOR_KIT_VERSION = 1;

const START_HERE = `# YOU'RE ALL WRONG! Episode Author Kit

This ZIP is designed to be attached, unchanged, to ChatGPT, Claude, Gemini, Copilot,
or another capable AI. It teaches the AI how to write a complete episode that this
game can validate, pre-render, and play without generating content during the show.

## Fastest workflow

1. Keep this ZIP intact.
2. Attach the ZIP to your AI.
3. Open \`01-COPY-PASTE-PROMPT.txt\`, replace the bracketed topic details, and send it.
4. Ask the AI to return a downloadable \`episode.json\` without previewing spoilers.
5. In the desktop game's lobby, choose **LOAD EPISODE** and select that JSON file.
6. The game validates every branch, then cooks and quality-checks all reachable host audio.
7. **START THE SHOW** unlocks only when the complete episode is ready.

If an AI cannot inspect ZIP attachments, extract the kit and attach every file together.
The schema is authoritative. The Markdown guides explain how to use it well.

## Important file map

- \`01-COPY-PASTE-PROMPT.txt\` — the message to send after filling in your topics.
- \`02-AI-MASTER-INSTRUCTIONS.md\` — complete role and output contract for the AI.
- \`03-EPISODE-DESIGN-GUIDE.md\` — pacing, question construction, reactions, and comedy.
- \`04-VOICE-TIMING-AND-PRONUNCIATION.md\` — natural host speech and spokenText rules.
- \`05-FORMAT-REFERENCE.md\` — every major showpack object in plain language.
- \`06-VALIDATION-CHECKLIST.md\` — checks the AI must perform before returning a file.
- \`07-SOURCES-ASSETS-AND-SAFETY.md\` — citations, archive safety, and licensed assets.
- \`08-2011-TONE-AND-PACING-STUDY.md\` — three full transcript references and the
  writing mechanics to study without copying.
- \`schema/showpack-v1.schema.json\` — machine-readable authoritative structure.
- \`templates/starter-episode.json\` — a small, valid episode to transform.
- \`examples/complete-episode.json\` — a complete working episode demonstrating all major flows.
- \`examples/topic-brief.txt\` — an optional questionnaire for better personalization.

The app contains no question-writing AI and needs no AI account. The AI is only an
external author; the imported file becomes inert validated data.
`;

const MASTER_INSTRUCTIONS = `# AI Master Instructions

You are the episode writer, fact checker, continuity editor, and schema validator for
YOU'RE ALL WRONG!, an original local-first party trivia show.

## Required output

Produce one UTF-8 JSON document matching \`schema/showpack-v1.schema.json\`. The root
must contain exactly \`manifest\` and \`episode\`. Do not add comments, Markdown,
JavaScript, executable content, environment variables, or undeclared fields.

When file attachments are available, attach only \`episode.json\` and do not spoil its
contents in chat. Otherwise return one JSON code block and nothing else.

## Creative identity

Write an original quick-witted host: observant, confident, privately amused, occasionally
mock-sincere, and capable of longer thoughts. Do not imitate or name a recognizable host,
performer, character, game, transcript, catchphrase, or protected presentation package.
Inspiration may come from the broad tradition of irreverent hosted trivia, but every line
must be newly written for this episode.

Before drafting, study \`08-2011-TONE-AND-PACING-STUDY.md\`. If browsing is available,
inspect the three linked full-episode transcripts. Learn their structural variety and
comic logic, not their wording, host identity, catchphrases, or intellectual property.

The host is not a random insult generator. Jokes should arise from the fact, answer,
player behavior, category premise, or recurring studio fiction. Vary rhythm. Some
questions deserve one short tag; others deserve a two- or three-line scene. Do not force
three jokes after every fact.

## Mandatory episode behavior

- Use exactly four answers per standard question.
- Every answer has a stable unique ID.
- Every wrong answer has its own complete, independent reaction. It must make sense even
  if no other answer reaction was heard.
- The correct reaction is evidence-led: it begins with the decisive fact and lets players
  infer the result before or while it naturally identifies the answer. Never use a blunt
  "Player one, you're correct" or generic congratulations.
- The explanation accurately teaches the fact.
- A no-answer reaction always exists.
- Optional conditional reactions only use the typed conditions allowed by the schema.
- All IDs are globally unique, lowercase, stable, and human-readable.
- Question facts cite reputable sources through \`sourceIds\`.
- All cues that might play exist before the show begins.
- Do not generate player names into authored speech. Runtime seat callouts handle players.
- Do not reveal the correct answer in IDs visible to players, category text, or prompt text.

## Game flow the writing must support

1. Category bumper appears.
2. Host naturally announces the category.
3. Category clears.
4. Full question text appears while the host reads the prompt.
5. Answers appear when answer narration starts; the twenty-second clock begins.
6. A player's early lock may interrupt answer narration.
7. When everyone locks or time expires, selected answer groups are revealed.
8. Wrong branches land before their damage animation. The correct branch begins its
   evidence-led reveal while the selected answer remains pending.
9. The correct explanation lands, then the bubble turns green and its score pays out.
   Optional post-question material completes the beat.

Do not write narration that assumes answer choices are still hidden after they appear.
Do not write a reaction that depends on an earlier wrong reaction being selected.

## Final private checks

Before returning the file, parse it as JSON, compare it to the supplied schema, verify
every ID/reference/branch/source, confirm all four answers, and inspect every spoken line
using the voice guide. Correct problems silently before delivering the file.
`;

const DESIGN_GUIDE = `# Episode Design Guide

## Recommended private-party episode

- Opening: 6–12 host lines, including a concise first-game tutorial.
- Main round: 5–10 questions.
- Question time limit: normally 20,000 ms.
- Difficulty: mix immediate recognition, reasoning, and one or two hard questions.
- Finale: calm score lead-in, title drop, then winner and loser roasts.
- Estimated length: roughly 2–3 minutes per standard question after reactions.

## Strong question construction

Start with one verifiable fact. Collide it with a familiar topic, then make the player
untangle that collision. The comedy premise must not make the factual target ambiguous.

A strong question has:

1. A compact category title that establishes the comic collision.
2. A prompt that can be understood when heard once and read on a television.
3. Four answers from the same conceptual category and grammatical shape.
4. Plausible distractors based on specific misconceptions.
5. A correct answer defensible from the cited source.
6. Reactions written from why that exact choice is tempting or ridiculous.

Avoid arbitrary numerical options unless estimation is the point. Avoid trick wording
whose only purpose is hiding what is being asked. Avoid disputed claims without clearly
defining the interpretation.

## Reaction rules

Default reactions are self-contained. Never write "still too low," "also backwards," or
"as I just said" unless a typed conditional branch guarantees the necessary context.

Good reaction:
"Twenty-two seconds would be miserable for gaming and wildly optimistic for Mars."

Bad reaction:
"Still wrong. That one is also too short."

Conditional reactions are seasoning, not missing foundations. Use them sparingly for
unanimous answers, all-correct rooms, solo correct players, suspiciously fast answers,
broken streaks, or authored callbacks.

## Human pacing

Vary post-question length:

- no post scene when the explanation already lands;
- one quick tag;
- a two-line escalation;
- a short recurring-character scene;
- a callback planted earlier.

Do not make every line the same length. Do not end every sentence with a simile. Do not
repeat "apparently," "somehow," "legally," or generic technology jokes throughout an
episode. Read the whole script for repeated constructions and replace them.

## Personal topics and friend-group lore

Private jokes still need enough setup to be funny to everyone playing. Never fabricate a
harmful allegation about a real person. For sensitive facts, ask the creator for exact
approved context. Treat names and unusual words as pronunciation risks and use spokenText
or pronunciation hints without changing the on-screen spelling.
`;

const VOICE_GUIDE = `# Voice, Timing, and Pronunciation

Every \`line\` cue has two possible text layers:

- \`text\`: what captions or diagnostics may display.
- \`spokenText\` (optional): the natural sentence sent to the host voice.

If \`spokenText\` is absent, \`text\` is spoken verbatim.

## Always use spokenText when

- a category is an isolated all-caps title;
- typography stretches a word, such as \`WROOOONG\`;
- a title starts with a proper noun that may be hard to recognize in isolation;
- the display uses symbols, abbreviations, formulas, URLs, or decorative fragments;
- the host should add natural connective language not shown on the screen.

Example:

\`\`\`json
{
  "type": "line",
  "id": "minecraft-gold-category-line",
  "speaker": "host",
  "text": "MINECRAFT: THE HEAVY UPDATE",
  "spokenText": "And now, Minecraft: The Heavy Update.",
  "delivery": "announcer",
  "pace": 1,
  "energy": 0.82,
  "pauseBeforeMs": 0,
  "pauseAfterMs": 450,
  "pronunciation": {}
}
\`\`\`

This is not permission to write two different facts. Display and speech must preserve the
same meaning. Natural framing improves pronunciation and comedy without changing the game.

## Delivery controls

- \`delivery\`: semantic performance mode, not an actor imitation.
- \`pace\`: 0.65–1.35. Keep ordinary lines near 1. Use extremes rarely.
- \`energy\`: 0–1. Energy is intensity, not volume.
- \`pauseBeforeMs\` and \`pauseAfterMs\`: explicit comedy beats.
- \`pronunciation\`: whole written tokens mapped to speakable replacements.

Supported delivery modes:
\`conversational\`, \`dry\`, \`smug\`, \`mock_sincere\`, \`conspiratorial\`,
\`announcer\`, \`excited\`, \`disappointed\`, \`furious\`, and \`finale_shout\`.

## Writing for reliable speech

- Use normal sentence casing in spokenText.
- Spell out ambiguous units or symbols.
- Put difficult proper nouns inside a natural sentence.
- Use punctuation for grammar, then explicit pauses for timing.
- Avoid phonetic spellings in display text.
- Never use markup, SSML, bracketed acting directions, emoji, or stage directions inside
  spoken text.
- Keep a single line below roughly 35 spoken words when a natural break exists.

The app renders every reachable line before Start unlocks. It preserves successful clips,
parks rough clips, and retries them with bounded alternate sampling. Better authored speech
reduces unnecessary retries without weakening quality checks.
`;

const FORMAT_REFERENCE = `# Format Reference

## Root

\`manifest\` describes the package and player constraints. \`episode\` contains the show.
Unknown properties are rejected.

## Manifest

- format: exactly \`games.youreallwrong.showpack\`
- formatVersion: exactly \`1\`
- id: same stable ID as episode.id
- title, author, language, createdAt, contentRating
- minPlayers/maxPlayers: 1–8
- estimatedMinutes
- assets: empty for JSON-only episodes; declared and hashed for archive assets

## Episode

- id/title/optional episodeNumber
- opening cue sequence
- one or more standard rounds
- finale
- sources

## Standard question

- id/category/categoryIntro
- prompt cues plus promptText for television display
- exactly four answers, each with narration
- correctAnswerId
- wrongAnswerReactions keyed by the three wrong IDs
- correctReaction and noAnswerReaction
- optional explanation/postQuestion/conditionalReactions
- timeLimitMs and scoring
- sourceIds

## Cue types

- line: host speech and performance direction
- stage: closed-list visual action
- sound: declared audio asset action
- pause: exact silent duration
- flag: typed callback state

## IDs

IDs begin with a letter and contain lowercase letters, digits, hyphens, underscores, or
dots. Keep them descriptive. Every cue, question, round, reaction, source, asset, finale,
and episode ID must be globally unique. IDs beginning with \`runtime-\` are reserved.

## Raw JSON versus .showpack

For text-only episodes, return one root JSON object and load it directly. A .showpack is a
ZIP containing \`manifest.json\`, \`episode/script.json\`, and declared licensed assets.
AI authors should prefer raw JSON unless the creator explicitly supplies media files and
requests an archive.
`;

const VALIDATION_CHECKLIST = `# Validation Checklist

The episode is not finished until every answer below is yes.

## Structure

- [ ] Root contains only manifest and episode.
- [ ] Format and formatVersion are exact.
- [ ] Manifest ID equals episode ID.
- [ ] Every required field exists and every value is within schema bounds.
- [ ] Every ID is legal, descriptive, globally unique, and not runtime-prefixed.
- [ ] There is at least one round and one question.
- [ ] Every standard question has exactly four answers.

## Branches

- [ ] correctAnswerId matches one answer.
- [ ] Exactly the three wrong answer IDs have wrong reactions.
- [ ] Every wrong reaction stands alone.
- [ ] Correct and no-answer reactions exist.
- [ ] Conditional answer IDs exist in that question.
- [ ] Every callback flag is deliberately planted.
- [ ] Winner and loser roast banks are nonempty.

## Voice and timing

- [ ] Every line sounds natural aloud.
- [ ] Isolated/stylized titles use spokenText.
- [ ] Proper nouns are naturally framed or given a pronunciation mapping.
- [ ] Category, prompt, answer narration, reveal, explanation, and post scene follow the
      intended screen flow.
- [ ] Pauses are intentional and within limits.
- [ ] No line depends on a reaction that may not have played.

## Facts and sources

- [ ] Every factual question is unambiguous and currently accurate.
- [ ] Correct answers are supported by reputable source entries.
- [ ] sourceIds resolve.
- [ ] Access dates use YYYY-MM-DD.
- [ ] URLs are direct source pages, not search results.

## Output

- [ ] JSON parses without comments or trailing commas.
- [ ] No Markdown fences exist inside the file.
- [ ] No executable code, HTML, CSS, scripts, or external instructions exist.
- [ ] The AI returns the file without exposing spoilers when attachments are supported.
`;

const SAFETY_GUIDE = `# Sources, Assets, and Safety

## Research

Prefer primary and authoritative sources: official agencies, standards bodies, museums,
universities, original research, official game documentation, and direct publisher pages.
Use multiple sources when a claim is contextual or contested. Do not invent citations.

Each source requires a stable ID, title, direct HTTPS URL, publisher, and accessedOn date.
Question sourceIds must point to declared sources.

## Assets

Raw episode JSON cannot carry media. A .showpack archive may contain only declared,
license-cleared files whose exact path, byte size, and SHA-256 are listed in the manifest.
Never scrape or package copyrighted game music, voice recordings, logos, videos, fonts,
screenshots, or sound effects without a license permitting redistribution.

The importer rejects traversal, absolute paths, backslashes, duplicate/case-colliding
entries, undeclared files, suspicious compression, oversized data, and hash mismatches.
Episode data is never executed as code.

## Privacy and real people

Do not include secrets, addresses, phone numbers, private messages, medical details, or
nonconsensual sensitive claims. Friend-group jokes should be supplied and approved by the
creator. Do not generate defamatory allegations.

## Originality

Do not clone a recognizable voice or imitate a living performer. Do not copy another
trivia game's transcript, host, catchphrase, category, question, music, or visual identity.
Use the supplied original game format and host direction.
`;

const TONE_AND_PACING_STUDY = `# 2011 Tone and Pacing Study

## Why these references are here

The target is not generic "snarky AI trivia." Study how a professionally written
irreverent trivia episode behaves as a complete show: factual collision, escalating
premise, answer-specific logic, sudden short reactions, occasional longer scenes,
recurring studio fiction, fake sponsorship, specialty rounds, and an ending that feels
authored rather than templated.

These community pages present full fan transcriptions of three different 2011 episodes:

1. **Buoyant Baby Water Cribs (Episode 3)**
   https://you-dont-know-jack-2011-2015.fandom.com/wiki/Buoyant_Baby_Water_Cribs

   Study: how a mundane knowledge target is fused with a pop-culture premise; how
   distractors create their own joke opportunities; the deliberate variation from a
   one-word rejection to a full acted scene; special-round score responses; sponsor
   setup/payoff; and a complete rapid finale.

2. **BloodCo. (Episode 10)**
   https://you-dont-know-jack-2011-2015.fandom.com/wiki/BloodCo.

   Study: self-contained choice-specific responses; jokes that use the exact language of
   the selected misconception; a secondary studio character; sound-effect beats; category
   titles that establish a separate comic lens; and post-question material that sometimes
   stops quickly and sometimes becomes a miniature scene.

3. **Magic Pudding (Episode 21)**
   https://you-dont-know-jack-2011-2015.fandom.com/wiki/Magic_Pudding

   Study: the difference between written display text and spoken narration; unusual round
   framing; escalating fake-product fiction; abrupt changes in host energy; correct-answer
   explanations that remain clear inside the joke; and callbacks that make the episode
   feel like one authored object.

Links verified 2026-07-26. If browsing is unavailable, use the analysis below and the
complete original example supplied in this kit. Do not claim to have read a page you
could not access.

## Extract the mechanics, never the material

After studying the transcripts, privately write down patterns, not lines:

- The factual question and comic premise are usually inseparable.
- Category names often create a second joke before the question begins.
- Wrong reactions respond to why that exact answer is wrong; they are not interchangeable
  insults.
- Correct explanations teach the answer plainly before or while adding a tag.
- Post-question length is uneven by design.
- The host has opinions, petty history, coworkers, and moment-to-moment reactions.
- Performance directions, interruptions, sound beats, and small scenes break up the
  cadence.
- Fake sponsors and callbacks reward attention across the whole episode.
- Not every line needs a punchline; contrast gives the real punchlines room.

Then create an entirely original episode for YOU'RE ALL WRONG! Do not copy or closely
paraphrase any transcript line, question, category, fake sponsor, special-round list,
catchphrase, character, ending, or joke construction with merely swapped nouns. Do not
name or impersonate the original host. The goal is comparable density, responsiveness,
rhythm, and human specificity inside this project's own host and rules.

## Anti-generic writing pass

Reject and rewrite a draft when:

- several reactions could be moved to another question without changing meaning;
- jokes repeatedly use "apparently," "somehow," "legally," or random comparisons;
- every post-question beat is exactly one sentence;
- every answer explanation uses the same sentence shape;
- the host has no consistent attitude beyond insulting players;
- category titles merely summarize the topic;
- the pop-culture half can be deleted without changing the knowledge test;
- a roast targets intelligence generally instead of the selected answer specifically;
- the episode contains references but no observations.

Perform this pass privately before schema validation and delivery.
`;

const TOPIC_BRIEF = `OPTIONAL TOPIC BRIEF

Topics everyone knows:

Games/media:

Places/schools/jobs:

Friend-group lore that is safe to use:

Inside jokes and the context needed to understand them:

Topics or people to avoid:

Difficulty (casual / mixed / brutal):

Content rating (everyone / teen / mature):

Question count:

Desired running callbacks:

Unusual names and how they are pronounced:

Anything the AI must fact-check especially carefully:
`;

function starterEpisode(): Showpack {
  const starter = structuredClone(demoPack);
  starter.manifest.id = 'author-kit-starter';
  starter.manifest.title = 'Author Kit Starter Episode';
  starter.manifest.author = 'Replace with your author name';
  starter.manifest.estimatedMinutes = 8;
  starter.episode.id = starter.manifest.id;
  starter.episode.title = starter.manifest.title;
  starter.episode.episodeNumber = 1;
  const firstQuestion = starter.episode.rounds[0]!.questions[0]!;
  starter.episode.rounds[0]!.questions = [firstQuestion];
  const usedSources = new Set(firstQuestion.sourceIds);
  starter.episode.sources = starter.episode.sources.filter((source) => usedSources.has(source.id));
  return starter;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildEpisodeAuthorKitFiles(): Readonly<Record<string, string>> {
  const starter = starterEpisode();
  const starterValidation = validateShowpack(starter);
  const demoValidation = validateShowpack(demoPack);
  if (!starterValidation.ok || !demoValidation.ok) {
    throw new Error('The bundled episode author kit contains an invalid example.');
  }

  const files: Record<string, string> = {
    '00-START-HERE.md': START_HERE,
    '01-COPY-PASTE-PROMPT.txt': `${EPISODE_AI_STARTER_PROMPT}\n`,
    '02-AI-MASTER-INSTRUCTIONS.md': MASTER_INSTRUCTIONS,
    '03-EPISODE-DESIGN-GUIDE.md': DESIGN_GUIDE,
    '04-VOICE-TIMING-AND-PRONUNCIATION.md': VOICE_GUIDE,
    '05-FORMAT-REFERENCE.md': FORMAT_REFERENCE,
    '06-VALIDATION-CHECKLIST.md': VALIDATION_CHECKLIST,
    '07-SOURCES-ASSETS-AND-SAFETY.md': SAFETY_GUIDE,
    '08-2011-TONE-AND-PACING-STUDY.md': TONE_AND_PACING_STUDY,
    'schema/showpack-v1.schema.json': json(
      toJSONSchema(ShowpackSchema, {
        target: 'draft-2020-12',
        unrepresentable: 'any',
      }),
    ),
    'templates/starter-episode.json': json(starterValidation.pack),
    'examples/complete-episode.json': json(demoValidation.pack),
    'examples/topic-brief.txt': TOPIC_BRIEF,
  };

  const manifestEntries = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contents]) => ({
      path,
      bytes: Buffer.byteLength(contents, 'utf8'),
      sha256: createHash('sha256').update(contents, 'utf8').digest('hex'),
    }));
  files['KIT-MANIFEST.json'] = json({
    schemaVersion: 1,
    kitVersion: EPISODE_AUTHOR_KIT_VERSION,
    generatedBy: "YOU'RE ALL WRONG!",
    files: manifestEntries,
  });
  return files;
}

export function buildEpisodeAuthorKitArchive(): Uint8Array {
  const entries = Object.fromEntries(
    Object.entries(buildEpisodeAuthorKitFiles())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, contents]) => [path, strToU8(contents)]),
  );
  return zipSync(entries, { level: 6 });
}
