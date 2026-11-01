import { useCallback, useEffect, useRef, useState } from 'react'
import { listItems } from '../api/client'
import { toTemplateAdminApiError, TemplateAdminApiError } from '../api/errors'
import type { ListItemsParams, ListItemsResponse } from '../api/types'

// Keeps the previous page of data visible while the next one loads. The
// request is aborted when the params change or the component unmounts.
// poll() reloads quietly: the table is not dimmed while it runs.
export function useItems(params: ListItemsParams) {
  // Parameters are compared by value, so callers may pass a new object each render
  const key = JSON.stringify(params)
  const [version, setVersion] = useState(0)
  const [data, setData] = useState<ListItemsResponse | null>(null)
  const [error, setError] = useState<TemplateAdminApiError | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const quiet = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    if (!quiet.current) setIsLoading(true)
    quiet.current = false
    setError(null)
    listItems(JSON.parse(key) as ListItemsParams, controller.signal).then(
      result => {
        if (controller.signal.aborted) return
        setData(result)
        setIsLoading(false)
      },
      err => {
        if (controller.signal.aborted) return
        setError(toTemplateAdminApiError(err))
        setIsLoading(false)
      }
    )
    return () => controller.abort()
  }, [key, version])

  const refresh = useCallback(() => setVersion(v => v + 1), [])
  const poll = useCallback(async () => {
    quiet.current = true
    setVersion(v => v + 1)
  }, [])

  return { data, error, isLoading, refresh, poll }
}

export default useItems
