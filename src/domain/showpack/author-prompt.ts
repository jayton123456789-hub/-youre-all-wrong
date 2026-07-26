export const EPISODE_AI_STARTER_PROMPT = `Read the entire attached YOU'RE ALL WRONG! Episode Author Kit before writing anything.

Create one complete, import-ready episode about these topics:
[REPLACE THIS WITH THE GAMES, MOVIES, PLACES, PEOPLE, INSIDE JOKES, OR SUBJECTS MY GROUP KNOWS]

Audience/content rating:
[everyone, teen, or mature]

Desired length:
[number of questions and approximate minutes]

Extra context the players would understand:
[optional friend-group lore, preferred difficulty, running jokes, facts to avoid, and pronunciation notes]

Follow the included JSON schema and every rule in the kit. Use an original host personality and original jokes; do not copy another trivia game's characters, catchphrases, questions, or scripts. Research factual claims, include reputable sources, make every wrong-answer reaction self-contained, and use natural spokenText for titles or typography that would sound awkward when read literally.

Before returning the file, privately validate every ID, branch, answer, source, timing value, and required field against the supplied schema and checklists.

If your interface supports file attachments, return only one downloadable UTF-8 file named episode.json and do not reveal or summarize its questions, answers, or ending in chat. If attachments are impossible, return only the complete JSON in one code block with no spoilers or commentary outside it.`;
