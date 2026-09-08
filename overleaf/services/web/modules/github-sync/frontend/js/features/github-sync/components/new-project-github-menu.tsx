import { DropdownItem } from '@/shared/components/dropdown/dropdown-menu'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'

type Props = { onClick: (e: React.MouseEvent) => void }

export default function NewProjectGithubMenu({ onClick }: Props) {
  if (!getMeta('ol-githubSyncEnabled')) return null
  return <NewProjectGithubMenuInner onClick={onClick} />
}

function NewProjectGithubMenuInner({ onClick }: Props) {
  const { t } = useTranslation()
  return <DropdownItem onClick={onClick}>{t('github', 'GitHub')}</DropdownItem>
}
