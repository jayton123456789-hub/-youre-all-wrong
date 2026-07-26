import type { CueSequence, DeliveryStyle, Question, Showpack } from '../domain/showpack/schema.js';

function line(
  id: string,
  text: string,
  delivery: DeliveryStyle = 'conversational',
  energy = 0.55,
  pauseAfterMs = 250,
  spokenText?: string,
): CueSequence[number] {
  return {
    type: 'line',
    id,
    speaker: 'host',
    text,
    ...(spokenText ? { spokenText } : {}),
    delivery,
    pace: delivery === 'mock_sincere' ? 0.9 : 1,
    energy,
    pauseBeforeMs: 0,
    pauseAfterMs,
    pronunciation: {},
  };
}

function question(
  id: string,
  category: string,
  promptText: string,
  answers: Array<[string, string]>,
  correctAnswerId: string,
  wrongLines: Record<string, string[]>,
  correctLines: string[],
  explanationLines: string[],
  postLines: string[],
  sourceId: string,
): Question {
  const wrongAnswerReactions = Object.fromEntries(
    Object.entries(wrongLines).map(([answerId, texts]) => [
      answerId,
      texts.map((text, index) =>
        line(`${id}-${answerId}-reaction-${index + 1}`, text, index === 0 ? 'dry' : 'smug'),
      ),
    ]),
  );

  return {
    id,
    category,
    categoryIntro: [
      {
        type: 'stage',
        id: `${id}-category-in`,
        action: 'category_in',
        intensity: 0.7,
        durationMs: 650,
      },
      line(
        `${id}-category-line`,
        category,
        'announcer',
        0.82,
        450,
        `And now, ${category.toLocaleLowerCase('en-US')}.`,
      ),
    ],
    prompt: [line(`${id}-prompt`, promptText, 'conversational', 0.58, 350)],
    promptText,
    answers: answers.map(([answerId, text], answerIndex) => ({
      id: answerId,
      text,
      narration: [
        line(
          `${id}-${answerId}-choice`,
          `${String.fromCharCode(65 + answerIndex)}. ${text}`,
          'conversational',
          0.54,
          120,
        ),
      ],
    })),
    correctAnswerId,
    wrongAnswerReactions,
    correctReaction: correctLines.map((text, index) =>
      line(`${id}-correct-${index + 1}`, text, index === 0 ? 'excited' : 'conversational', 0.74),
    ),
    noAnswerReaction: [
      line(
        `${id}-no-answer`,
        'No answer. A bold strategy if the goal was to leave no evidence that you were awake.',
        'disappointed',
        0.48,
      ),
    ],
    explanation: explanationLines.map((text, index) =>
      line(`${id}-explanation-${index + 1}`, text, 'conversational', 0.48),
    ),
    postQuestion: postLines.map((text, index) =>
      line(`${id}-post-${index + 1}`, text, index === postLines.length - 1 ? 'dry' : 'smug', 0.5),
    ),
    conditionalReactions: [
      {
        id: `${id}-everybody-nailed-it`,
        priority: 500,
        when: { kind: 'all_correct' },
        cues: [
          line(
            `${id}-everybody-nailed-it-line`,
            'Every player got it right. I need someone to check the carbon monoxide detector; group competence this high is usually a warning sign.',
            'mock_sincere',
            0.63,
          ),
        ],
      },
    ],
    timeLimitMs: 20_000,
    scoring: {
      correct: 1_000,
      speedBonus: 500,
      wrongPenalty: 250,
      noAnswerPenalty: 0,
    },
    sourceIds: [sourceId],
  };
}

export const demoPack: Showpack = {
  manifest: {
    format: 'games.youreallwrong.showpack',
    formatVersion: 1,
    id: 'terms-and-conditions',
    title: 'Terms, Conditions & Other Threats',
    author: "YOU'RE ALL WRONG! Studio",
    language: 'en-US',
    createdAt: '2026-07-24T18:00:00.000Z',
    contentRating: 'teen',
    minPlayers: 1,
    maxPlayers: 8,
    estimatedMinutes: 18,
    assets: [],
  },
  episode: {
    id: 'terms-and-conditions',
    title: 'Terms, Conditions & Other Threats',
    episodeNumber: 0,
    opening: [
      { type: 'stage', id: 'opening-blackout', action: 'blackout', intensity: 1, durationMs: 500 },
      line(
        'opening-welcome',
        "Welcome to YOU'RE ALL WRONG, the only trivia show legally classified as an avoidable consequence.",
        'announcer',
        0.78,
        450,
      ),
      line(
        'opening-sponsor-one',
        "Tonight's episode is sponsored by Terms and Conditions Funeral Home.",
        'mock_sincere',
        0.4,
        500,
      ),
      line('opening-sponsor-two', "You've already agreed to be buried there.", 'dry', 0.36, 650),
      line(
        'opening-sponsor-three',
        'No, you may not inspect the agreement. According to our records, you clicked Continue sometime in 2018, and legally speaking that was basically a blood oath.',
        'smug',
        0.62,
        650,
      ),
      line(
        'opening-rules-one',
        'Quick survival briefing. Your phone has four arrows. They point to the four answers on the big screen, because reading an entire trivia question on a phone is how neck problems become a game mechanic.',
        'conversational',
        0.58,
        450,
      ),
      line(
        'opening-rules-two',
        'First I reveal the category, then I read the question. The moment the answers hit the screen, your twenty seconds begin and every arrow becomes dangerous.',
        'announcer',
        0.64,
        450,
      ),
      line(
        'opening-rules-three',
        'Lock in while I am reading the choices and I stop talking immediately. Rude? Yes. Faster answers are worth more, so for once your impatience has a retirement plan.',
        'smug',
        0.67,
        450,
      ),
      line(
        'opening-rules-four',
        'Your first tap is final. Correct answers put points in your account. Wrong answers make a withdrawal with the confidence of a landlord.',
        'dry',
        0.55,
        550,
      ),
      line('opening-start', "Let's make your education feel temporary.", 'excited', 0.8, 500),
    ],
    rounds: [
      {
        type: 'standard',
        id: 'main-round',
        title: 'The Main Injury',
        intro: [
          line(
            'main-round-intro',
            'Five questions. Four answers each. And just enough confidence to make the mistakes hurt.',
            'conversational',
            0.62,
          ),
        ],
        questions: [
          question(
            'shakespearean-prompt',
            "A MIDSUMMER NIGHT'S PROMPT",
            'You ask a chatbot to rewrite its terms of service as a traditional Shakespearean sonnet. Assuming it actually follows directions for once, what should it give you?',
            [
              ['haiku', 'Three lines containing five, seven, and five syllables'],
              ['sonnet', 'Fourteen lines using an ABAB CDCD EFEF GG rhyme scheme'],
              ['villanelle', 'Nineteen lines built around two repeated refrains'],
              ['free-verse', 'Any number of lines with no required meter or rhyme'],
            ],
            'sonnet',
            {
              haiku: [
                "That's a haiku: three lines, seventeen syllables, and usually a frog discovering seasonal depression.",
                'Beautiful form. Wrong structure, wrong continent, wrong dead writer.',
              ],
              villanelle: [
                "That's a villanelle: nineteen lines, two refrains, and the growing suspicion that you've heard the same thing several times already.",
                'It would be excellent for a cookie-consent popup. It is not a Shakespearean sonnet.',
              ],
              'free-verse': [
                "That's free verse. No fixed rhyme, no fixed meter, barely any supervision.",
                'Our legal department would never approve a literary form that gives the reader that much freedom.',
              ],
            },
            [
              'A Shakespearean sonnet uses fourteen lines, arranged as three quatrains and a final couplet.',
            ],
            [
              'Its usual rhyme scheme is A B A B, C D C D, E F E F, then G G. Even Shakespeare knew when to stop scrolling.',
            ],
            [
              'I asked Legal to write a sonnet about informed consent.',
              'They sent fourteen pages instead of fourteen lines, and the final couplet was an arbitration clause.',
              'Apparently it rhymes if you pronounce liable as your problem.',
            ],
            'folger-sonnet',
          ),
          question(
            'no-build-no-quartering',
            'NO BUILD, NO QUARTERING',
            'You are halfway through a Fortnite match when three actual United States soldiers demand to spend peacetime sleeping in your living room. Which amendment gives you the strongest basis for telling them to find another spawn point?',
            [
              ['first-amendment', 'The First Amendment'],
              ['second-amendment', 'The Second Amendment'],
              ['third-amendment', 'The Third Amendment'],
              ['fourth-amendment', 'The Fourth Amendment'],
            ],
            'third-amendment',
            {
              'first-amendment': [
                'The First Amendment protects your speech, so you may stand in the doorway and yell, Get off my couch!',
                'It does not require the soldiers to respect the couch-related portion of that speech.',
              ],
              'second-amendment': [
                'The Second Amendment concerns the right to keep and bear arms.',
                'The problem is not the soldiers bearing arms. It is the soldiers bearing sleeping bags, phone chargers, and a duffel that will absolutely destroy your coffee table.',
              ],
              'fourth-amendment': [
                'The Fourth Amendment protects against unreasonable searches and seizures.',
                "These soldiers are not searching your house. They've found it, connected to the Wi-Fi, and changed the television input. Different emergency.",
              ],
            },
            [
              'The Third Amendment says soldiers cannot be quartered in your private home during peacetime without your consent.',
            ],
            [
              'That suspiciously specific protection gives the constitutional benchwarmer tonight’s save, just before somebody unfolds a government-issued sleeping bag on your couch.',
            ],
            [
              'The Third Amendment rarely gets invited anywhere.',
              'It sits between the famous gun amendment and the famous search-warrant amendment, quietly waiting for a soldier to ask where you keep the clean towels.',
              'But tonight it got an entire question. Big night for Three. Somebody call its parents.',
            ],
            'constitution-third',
          ),
          question(
            'mars-ping',
            'MARS HAS TERRIBLE PING',
            'Your friend moves to Mars but insists on Friday game night. When Earth and Mars are positioned for maximum communication delay, approximately how long could one controller input take just to reach them?',
            [
              ['milliseconds-22', '22 milliseconds'],
              ['seconds-22', '22 seconds'],
              ['minutes-22', '22 minutes'],
              ['hours-22', '22 hours'],
            ],
            'minutes-22',
            {
              'milliseconds-22': [
                'Twenty-two milliseconds is excellent Earth internet.',
                'If you have that connection to Mars, stop gaming and call every physicist. You broke light speed or invited an alien into party chat.',
              ],
              'seconds-22': [
                'Twenty-two seconds would be miserable for gaming and wildly optimistic for Mars.',
                'At that delay your friend could blame the planet. Unfortunately, the planet has a much better alibi.',
              ],
              'hours-22': [
                'Twenty-two hours is far too long for the radio signal itself.',
                'If your friend takes that long to respond, Mars is innocent. They saw your message and chose peace.',
              ],
            },
            [
              'At their widest separation, a radio signal can spend about twenty-two minutes traveling from Earth to Mars—one way.',
            ],
            [
              'The exact delay changes with the planets, from roughly three to twenty-two minutes. Every rage quit becomes a carefully considered resignation.',
            ],
            [
              'Imagine trash talk with a forty-four-minute round trip.',
              'You send, Nice aim. Forty-five minutes later the television says, Your mom.',
              "By then you've eaten dinner, taken a shower, and emotionally matured beyond the conflict. Mars may be the healthiest gaming server ever built.",
            ],
            'esa-mars-delay',
          ),
          question(
            'darwins-feed',
            "DARWIN'S FOR YOU PAGE",
            'Suppose nature had a For You page. Which heritable trait would natural selection be most likely to keep recommending into later generations?',
            [
              ['practiced', 'A trait the organism practiced hardest during its life'],
              ['offspring', 'A trait that helped its bearers produce more surviving offspring'],
              ['noticeable', 'The most noticeable trait in the population'],
              ['needed', 'A trait the species desperately needed'],
            ],
            'offspring',
            {
              practiced: [
                'Practice can improve an individual. It does not automatically rewrite the instructions passed to its children.',
                'A giraffe stretching every morning does not give birth to a baby wearing a neck brace and whispering, The gains are genetic.',
              ],
              noticeable: [
                'Being noticeable is not automatically useful.',
                'Sometimes it attracts a mate. Sometimes it attracts a predator. Sometimes a documentary crew names you Kevin and films your death in slow motion.',
              ],
              needed: [
                'Species do not receive traits merely because they need them.',
                'I have urgently needed upper-body strength since middle school. Nature has declined every request without explanation.',
              ],
            },
            [
              'Natural selection keeps the heritable traits whose bearers leave more surviving offspring.',
            ],
            [
              'Those traits become more common in later generations. Nature tracks engagement with a deeply unsettling definition of engagement.',
            ],
            [
              'Our intern stands beside the copier six hours a day because he believes his children will come out collated.',
              "I would explain genetics, but he's the only person here who can clear a paper jam.",
              'Sometimes ignorance is load-bearing.',
            ],
            'berkeley-selection',
          ),
          question(
            'minecraft-gold',
            'MINECRAFT: THE HEAVY UPDATE',
            'Steve mines a solid gold block exactly one meter on every side. About how much does his newly developed back problem weigh?',
            [
              ['kg-19', '19.3 kilograms'],
              ['kg-193', '193 kilograms'],
              ['tons-1', '1.93 metric tons'],
              ['tons-19', '19.3 metric tons'],
            ],
            'tons-19',
            {
              'kg-19': [
                'That is not a cubic meter of gold. That is a kettlebell with excellent credit.',
                "You're short by a factor of one thousand, which is also how far Steve's spine just moved.",
              ],
              'kg-193': [
                'One hundred ninety-three kilograms could ruin a moving day. A cubic meter of gold could ruin the moving company.',
                'Add two zeroes and call your insurance agent.',
              ],
              'tons-1': [
                'One point nine three tons is enough to flatten a car and still ten times too light.',
                'Partial destruction does not earn partial credit.',
              ],
            },
            ['Gold packs about nineteen thousand three hundred kilograms into every cubic meter.'],
            [
              "So Steve's one-meter block comes to roughly nineteen point three metric tons. He is not strong; his inventory is committing workers compensation fraud.",
            ],
            [
              "A Minecraft gold block should weigh roughly as much as three adult elephants, assuming the elephants haven't been compressed into convenient crafting materials.",
              'Please do not test this. The studio floor is rented.',
            ],
            'rsc-gold',
          ),
        ],
        outro: [
          line(
            'main-round-outro',
            'That concludes the questions and several promising friendships.',
            'mock_sincere',
            0.52,
          ),
        ],
      },
    ],
    finale: {
      id: 'results-title-drop',
      calmLeadIn: [
        {
          type: 'stage',
          id: 'results-scoreboard-in',
          action: 'scoreboard_in',
          intensity: 0.55,
          durationMs: 900,
        },
        line(
          'results-calm-line',
          'And after all that, the final results show something genuinely remarkable…',
          'mock_sincere',
          0.22,
          1_200,
        ),
      ],
      titleDrop: [
        {
          type: 'stage',
          id: 'results-blackout',
          action: 'blackout',
          intensity: 1,
          durationMs: 300,
        },
        line('results-title-line', "YOU'RE! ALL! WROOOONG!", 'finale_shout', 1, 700),
        {
          type: 'stage',
          id: 'results-logo-slam',
          action: 'logo_slam',
          intensity: 1,
          durationMs: 850,
        },
      ],
      outro: [
        line(
          'results-outro-one',
          'The winner may celebrate after completing a brief humility inspection.',
          'smug',
          0.61,
        ),
        line(
          'results-outro-two',
          'Everyone else: go read something with page numbers. Good night.',
          'dry',
          0.48,
          700,
        ),
      ],
      winnerRoasts: [
        [
          line(
            'winner-roast-demo',
            'You won—the intellectual equivalent of being the least damp towel in the hamper.',
            'smug',
            0.57,
          ),
        ],
      ],
      loserRoasts: [
        [
          line(
            'loser-roast-demo',
            'Your score has requested witness protection and a new identity.',
            'dry',
            0.5,
          ),
        ],
      ],
    },
    sources: [
      {
        id: 'folger-sonnet',
        title: 'How to Write a Sonnet',
        url: 'https://www.folger.edu/explore/shakespeares-works/shakespeares-sonnets/how-to-write-a-sonnet/',
        publisher: 'Folger Shakespeare Library',
        accessedOn: '2026-07-24',
      },
      {
        id: 'constitution-third',
        title: 'Third Amendment',
        url: 'https://constitution.congress.gov/constitution/amendment-3/',
        publisher: 'Congress.gov Constitution Annotated',
        accessedOn: '2026-07-24',
      },
      {
        id: 'esa-mars-delay',
        title: 'Time Delay Between Mars and Earth',
        url: 'https://blogs.esa.int/mex/2012/08/05/time-delay-between-mars-and-earth/',
        publisher: 'European Space Agency',
        accessedOn: '2026-07-24',
      },
      {
        id: 'berkeley-selection',
        title: 'Natural Selection',
        url: 'https://evolution.berkeley.edu/evolution-101/mechanisms-the-processes-of-evolution/natural-selection/',
        publisher: 'University of California Museum of Paleontology',
        accessedOn: '2026-07-24',
      },
      {
        id: 'rsc-gold',
        title: 'Gold',
        url: 'https://www.rsc.org/periodic-table/element/79/gold',
        publisher: 'Royal Society of Chemistry',
        accessedOn: '2026-07-24',
      },
    ],
  },
};
