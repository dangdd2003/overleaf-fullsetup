import {
  FormEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { getJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import Pagination from '@/shared/components/pagination'
import LoadingSpinner from '@/shared/components/loading-spinner'
import SearchForm from './search-form'
import SearchHit from './search-hit'
import {
  buildClearedSearchUrl,
  buildSearchUrl,
  readSearchUrlState,
} from '../util/search-url'
import type { GallerySearchHit, GallerySearchResponse } from '../types'

export const HITS_PER_PAGE = 10
const SEARCH_API_URL = '/gallery/api/search'

function ResultsStatus({
  hits,
  totalHits,
}: {
  hits: GallerySearchHit[]
  totalHits: number
}) {
  const { t } = useTranslation()
  const count = hits.length
  const status =
    totalHits > HITS_PER_PAGE
      ? t('showing_x_results_of_total', { count, total: totalHits })
      : t('showing_x_results', { count })

  return (
    <span className="visually-hidden" aria-live="polite">
      {status}
    </span>
  )
}

function GallerySearch() {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<AbortController | null>(null)

  const [hits, setHits] = useState<GallerySearchHit[]>()
  const [totalHits, setTotalHits] = useState<number>()
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<Error>()
  const [lastQuery, setLastQuery] = useState('')

  // Event handlers registered once (popstate) read the latest values here.
  const lastQueryRef = useRef(lastQuery)
  const currentPageRef = useRef(currentPage)
  useEffect(() => {
    lastQueryRef.current = lastQuery
    currentPageRef.current = currentPage
  }, [lastQuery, currentPage])

  const setInputValue = useCallback((value: string) => {
    if (inputRef.current) {
      inputRef.current.value = value
    }
  }, [])

  const resetResults = useCallback(() => {
    requestRef.current?.abort()
    setCurrentPage(1)
    setHits(undefined)
    setTotalPages(0)
    setTotalHits(undefined)
    setError(undefined)
    setIsProcessing(false)
  }, [])

  const runSearch = useCallback((query: string, page?: number) => {
    const pageNumber = page && page > 0 ? page : 1

    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setIsProcessing(true)
    setError(undefined)

    const url = buildSearchUrl(window.location.href, query, pageNumber)
    if (url) {
      window.history.pushState({}, '', url)
    }

    const params = new URLSearchParams({
      q: query,
      page: String(pageNumber - 1),
      hitsPerPage: String(HITS_PER_PAGE),
    })
    getJSON<GallerySearchResponse>(`${SEARCH_API_URL}?${params}`, {
      signal: controller.signal,
    })
      .then(data => {
        if (controller.signal.aborted) {
          return
        }
        setHits(data.hits)
        setCurrentPage(data.page + 1)
        setTotalPages(data.nbPages)
        setTotalHits(data.nbHits)
        setLastQuery(query)
        setIsProcessing(false)
      })
      .catch(err => {
        if (controller.signal.aborted) {
          return
        }
        debugConsole.error(err)
        setIsProcessing(false)
        setHits(undefined)
        setError(err)
      })
  }, [])

  useEffect(() => {
    const { query, page } = readSearchUrlState()
    if (query) {
      runSearch(query, page)
      setInputValue(query)
    }

    function handlePopState() {
      const { query, page = 1 } = readSearchUrlState()
      if (query) {
        if (
          query !== lastQueryRef.current ||
          page !== currentPageRef.current
        ) {
          runSearch(query, page)
          setInputValue(query)
        }
      } else {
        resetResults()
        setLastQuery('')
        setInputValue('')
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      requestRef.current?.abort()
    }
  }, [runSearch, resetResults, setInputValue])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const query = String(
        new FormData(event.currentTarget).get('query') ?? ''
      ).trim()
      if (query === lastQueryRef.current) {
        return
      }
      resetResults()
      if (query) {
        runSearch(query, 1)
      } else {
        setLastQuery('')
        const url = buildClearedSearchUrl(window.location.href)
        if (url) {
          window.history.pushState({}, '', url)
        }
      }
    },
    [runSearch, resetResults]
  )

  const handlePageClick = useCallback(
    (event: MouseEvent, page: number) => {
      event.preventDefault()
      if (page !== currentPageRef.current) {
        runSearch(lastQueryRef.current, page)
      }
      const form = document.getElementById('algolia-search-form')
      if (form) {
        window.scrollTo(0, form.offsetTop)
      }
    },
    [runSearch]
  )

  return (
    <div className="row">
      <div className="col-xs-12">
        <SearchForm onSubmit={handleSubmit} ref={inputRef} />
      </div>
      <div
        className={classNames('search-hits', 'col-xs-12', {
          processing: hits && isProcessing,
        })}
      >
        {hits && hits.length > 0 && totalHits ? (
          <>
            <ResultsStatus hits={hits} totalHits={totalHits} />
            {hits.map(hit => (
              <SearchHit key={hit.token} hit={hit} />
            ))}
          </>
        ) : null}
        {hits && hits.length === 0 && (
          <span className="search-hits-empty" aria-live="polite">
            {t('no_search_results')}
          </span>
        )}
        {totalPages > 1 && currentPage <= totalPages && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            handlePageClick={handlePageClick}
          />
        )}
        {!hits && isProcessing && (
          <LoadingSpinner
            className="justify-content-center search-hits-loading"
            loadingText={t('processing')}
            align="center"
          />
        )}
        {error && (
          <span aria-live="polite">{t('generic_something_went_wrong')}</span>
        )}
      </div>
    </div>
  )
}

export default GallerySearch
