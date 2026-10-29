export type GallerySearchTag = {
  name: string
  title: string
  href: string
}

export type GallerySearchHit = {
  token: string
  family: 'template' | 'example' | 'article'
  href: string
  title: string
  author: string
  // HTML-escaped description snippet; only <strong> highlights are markup
  snippetHtml: string
  official: boolean
  tags: GallerySearchTag[]
  thumbUrl: string
}

// Response of GET /gallery/api/search (`page` is 0-based, like Algolia)
export type GallerySearchResponse = {
  hits: GallerySearchHit[]
  nbHits: number
  page: number
  nbPages: number
  hitsPerPage: number
  query: string
}
