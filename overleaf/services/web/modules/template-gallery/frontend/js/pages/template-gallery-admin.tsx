import { renderInReactLayout } from '@/react'
import '@/utils/meta'
import '@/utils/webpack-public-path'
import '@/infrastructure/error-reporter'
import '@/i18n'
import TemplateGalleryAdminPage from '../components/admin/template-gallery-admin-page'

renderInReactLayout('template-gallery-admin-container', () => (
  <TemplateGalleryAdminPage />
))
