import { renderInReactLayout } from '@/react'
import getMeta from '@/utils/meta'
import '@/utils/webpack-public-path'
import '@/infrastructure/error-reporter'
import '@/i18n'
import TemplateGalleryItemPage from '../components/item/template-gallery-item-page'

// The item id is injected by app/views/item.pug. getMeta only knows the keys
// declared on Meta, so the module declares its own.
declare module '@/utils/meta' {
  interface Meta {
    'ol-target-item-id': string
  }
}

renderInReactLayout('template-gallery-item-container', () => (
  <TemplateGalleryItemPage itemId={getMeta('ol-target-item-id')} />
))
