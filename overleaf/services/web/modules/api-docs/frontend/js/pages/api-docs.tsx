import { renderInReactLayout } from '@/react'
import '@/utils/meta'
import '@/utils/webpack-public-path'
import '@/infrastructure/error-reporter'
import '@/i18n'
import ApiDocsPageRoot from '../components/root'

renderInReactLayout('api-docs-page-root', () => <ApiDocsPageRoot />)
