import { forwardRef, FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'

type SearchFormProps = {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const SearchForm = forwardRef<HTMLInputElement, SearchFormProps>(
  ({ onSubmit }, inputRef) => {
    const { t } = useTranslation()

    return (
      <OLForm id="algolia-search-form" onSubmit={onSubmit} role="search">
        <OLFormLabel className="visually-hidden" htmlFor="algolia-search">
          {t('search')}
        </OLFormLabel>
        <OLFormControl
          prepend={<MaterialIcon type="search" />}
          type="text"
          id="algolia-search"
          name="query"
          ref={inputRef}
        />
        <OLButton size="lg" variant="primary" type="submit">
          {t('search')}
        </OLButton>
      </OLForm>
    )
  }
)
SearchForm.displayName = 'SearchForm'

export default SearchForm
