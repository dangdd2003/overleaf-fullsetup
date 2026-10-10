/** Translate targets, A–Z. Names are what the model is told to translate into. */
export const LANGUAGES: string[] = [
  'Albanian',
  'Arabic',
  'Basque',
  'Bengali',
  'Bulgarian',
  'Catalan',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Croatian',
  'Czech',
  'Danish',
  'Dutch',
  'English',
  'Estonian',
  'Filipino',
  'Finnish',
  'French',
  'Galician',
  'German',
  'Greek',
  'Hebrew',
  'Hindi',
  'Hungarian',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Latvian',
  'Lithuanian',
  'Malay',
  'Norwegian',
  'Persian',
  'Polish',
  'Portuguese',
  'Portuguese (Brazil)',
  'Romanian',
  'Russian',
  'Serbian',
  'Slovak',
  'Slovenian',
  'Spanish',
  'Swahili',
  'Swedish',
  'Tamil',
  'Thai',
  'Turkish',
  'Ukrainian',
  'Urdu',
  'Vietnamese',
]

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

/**
 * The Translate list: recently used languages first (most recent on top),
 * then every other language A–Z, both filtered by the search text.
 */
export function orderLanguages(
  recent: string[],
  query: string
): { recent: string[]; others: string[] } {
  const needle = fold(query.trim())
  const matches = (language: string) => !needle || fold(language).includes(needle)
  const recentMatches = recent.filter(matches)
  return {
    recent: recentMatches,
    others: LANGUAGES.filter(
      language => !recent.includes(language) && matches(language)
    ),
  }
}
