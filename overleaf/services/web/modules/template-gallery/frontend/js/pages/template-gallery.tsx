import '@/marketing'
import '@/i18n'
// Bootstrap tooltips for [data-bs-toggle="tooltip"] and [data-badge-tooltip]
// (Top pick / Official badges, clipped tag badges, Last Updated).
import '@/features/tooltip'
import '../../stylesheets/template-gallery.scss'
import { createRoot } from 'react-dom/client'
import GallerySearch from '../features/gallery-search/components/gallery-search'
import { rewriteLegacySearchParam } from '../features/gallery-search/util/search-url'
import { setupRelatedTags } from '../features/gallery-page/related-tags'
import { setupTimestampTooltips } from '../features/gallery-page/timestamp-tooltips'

setupTimestampTooltips()

const searchElement = document.getElementById('gallery-search')
if (searchElement) {
  rewriteLegacySearchParam()
  createRoot(searchElement).render(<GallerySearch />)
}

setupRelatedTags()
