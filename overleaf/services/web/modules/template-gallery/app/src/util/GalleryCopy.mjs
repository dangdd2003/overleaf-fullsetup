// Static copy of the official gallery pages, expressed as translation keys so
// the pug views can render it through translate(). Texts live in
// locales/en.json.

import { SCOPES, scopeBase, taggedHref } from './GalleryUrls.mjs'

// Icon paths are relative to /img (render them with buildImgPath).
const ICON_BASE = 'website-redesign/gallery'

// The fixed "Categories" tiles, alphabetical by slug as on overleaf.com. The
// slug is both the tag name and the icon file name.
export const CATEGORIES = Object.freeze(
  [
    ['academic-journal', 'journal_articles', 'homepage_journal_articles_description'],
    ['bibliography', 'bibliographies', 'gallery_bibliography_description'],
    ['book', 'books', 'gallery_book_description'],
    ['calendar', 'calendars', 'gallery_calendar_description'],
    ['cv', 'cvs_and_resumes', 'gallery_cv_description'],
    ['formal-letter', 'formal_letters', 'gallery_formal_letter_description'],
    ['homework', 'assignments', 'gallery_homework_description'],
    ['newsletter', 'newsletters', 'gallery_newsletter_description'],
    ['poster', 'posters', 'gallery_poster_description'],
    ['presentation', 'presentations', 'homepage_presentations_description'],
    ['thesis', 'theses', 'gallery_thesis_description'],
  ].map(([slug, titleKey, descriptionKey]) =>
    Object.freeze({
      slug,
      titleKey,
      descriptionKey,
      icon: `${ICON_BASE}/${slug}.svg`,
    })
  )
)

// Per listing scope: page <title>, h1, summary, back link noun and the label
// used in the filter strip.
const SCOPE_COPY = Object.freeze({
  templates: Object.freeze({
    pageTitleKey: 'templates_page_title',
    titleKey: 'latex_templates_sentence_case',
    summaryKey: 'latex_templates_for_journal_articles',
    itemPluralKey: 'templates_lowercase',
    filterKey: 'templates',
    hasFeatured: true,
  }),
  gallery: Object.freeze({
    pageTitleKey: 'gallery_page_title',
    titleKey: 'latex_templates_and_examples',
    summaryKey: 'discover_latex_templates_and_examples',
    itemPluralKey: 'gallery_page_items_lowercase',
    filterKey: 'all',
    hasFeatured: true,
  }),
  examples: Object.freeze({
    pageTitleKey: 'latex_examples_page_title',
    titleKey: 'latex_examples',
    summaryKey: 'examples_to_help_you_learn',
    itemPluralKey: 'examples_lowercase',
    filterKey: 'examples',
    hasFeatured: false,
  }),
  articles: Object.freeze({
    pageTitleKey: 'latex_articles_page_title',
    titleKey: 'community_articles',
    summaryKey: 'papers_presentations_reports_and_more',
    itemPluralKey: 'community_articles_lowercase',
    filterKey: 'community_articles',
    hasFeatured: false,
  }),
})

// Order of the "Filters:" strip links.
const FILTER_ORDER = Object.freeze(['gallery', 'templates', 'examples', 'articles'])

// Shared <meta name="description"> of every listing page.
export const LISTING_DESCRIPTION_KEY = 'hundreds_templates_info'

export function isScope(scope) {
  return SCOPES.includes(scope)
}

export function scopeCopy(scope) {
  return SCOPE_COPY[scope] || SCOPE_COPY.templates
}

export function categoryTiles(scope) {
  return CATEGORIES.map(category => ({
    ...category,
    href: taggedHref(scope, category.slug),
  }))
}

// Links of the "Filters:" strip. On tag pages every link keeps the tag.
export function filterLinks(scope, tagName = null) {
  return FILTER_ORDER.map(target => ({
    scope: target,
    labelKey: SCOPE_COPY[target].filterKey,
    href: tagName ? taggedHref(target, tagName) : scopeBase(target),
    active: target === scope,
  }))
}

export default {
  CATEGORIES,
  LISTING_DESCRIPTION_KEY,
  isScope,
  scopeCopy,
  categoryTiles,
  filterLinks,
}
