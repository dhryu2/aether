// 폴더 탐색기의 데이터. 위치 목록은 한 번만 받고, 폴더 목록은 `숨김여부:경로` 열쇠로 창이 열려 있는 동안 쌓아 둔다.
// 요청한 경로와 서버가 돌려준 실제 경로(링크를 푼 것) 양쪽에 저장해, 어느 쪽으로 다시 와도 새로 묻지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { createClientErrorReporter, httpStatus } from '../../lib/errors'
import type { FsListing, FsPlaces } from '../../lib/types'

const keyOf = (path: string, hidden: boolean) => `${hidden ? 1 : 0}:${path}`

export type FolderBrowser = {
  /** 즐겨찾기와 장치. 아직 못 받았으면 undefined. */
  places: FsPlaces | undefined
  placesFailed: boolean
  loadPlaces: () => Promise<void>
  /** 받아 둔 목록. 없으면 undefined. */
  get: (path: string, hidden: boolean) => FsListing | undefined
  /** 실패한 요청의 HTTP 상태. 상태를 모르면 0, 실패한 적 없으면 undefined. */
  failedOf: (path: string, hidden: boolean) => number | undefined
  /** 폴더를 불러온다. 이미 있으면 그대로 돌려주고, 실패하면 null이다. */
  load: (path: string, hidden?: boolean, force?: boolean) => Promise<FsListing | null>
  /** 그 폴더에서 복사본을 만들 수 있는지. 아직 모르면 undefined. */
  canCopyOf: (path: string) => boolean | undefined
}

export function useFolderBrowser(): FolderBrowser {
  const [places, setPlaces] = useState<FsPlaces | undefined>()
  const [placesFailed, setPlacesFailed] = useState(false)
  // 화면을 다시 그리게 하는 사본. 읽기는 ref로 해서 load가 바뀌지 않게 한다.
  const [, bump] = useState(0)
  const cache = useRef(new Map<string, FsListing>())
  const failures = useRef(new Map<string, number>())
  const copyable = useRef(new Map<string, boolean>())
  const inflight = useRef(new Map<string, Promise<FsListing | null>>())
  const reporter = useRef(createClientErrorReporter({ component: 'folders', operation: 'web.folder_browser.load' })).current
  const placesReporter = useRef(createClientErrorReporter({ component: 'folders', operation: 'web.folder_browser.places' })).current

  const loadPlaces = useCallback(
    () =>
      api
        .fsPlaces()
        .then((r) => {
          setPlaces(r)
          setPlacesFailed(false)
          placesReporter.reset()
        })
        .catch((error: unknown) => {
          placesReporter.report(error)
          setPlacesFailed(true)
        }),
    [placesReporter],
  )

  useEffect(() => {
    // 창이 열릴 때 한 번 받는다. 실패하면 사람이 다시 시도를 누른다.
    void loadPlaces()
  }, [loadPlaces])

  const load = useCallback(
    (path: string, hidden = false, force = false): Promise<FsListing | null> => {
      const key = keyOf(path, hidden)
      if (!force) {
        const hit = cache.current.get(key)
        if (hit) return Promise.resolve(hit)
        const pending = inflight.current.get(key)
        if (pending) return pending
      }
      failures.current.delete(key)
      const task = api
        .fsList(path, hidden)
        .then((r) => {
          cache.current.set(key, r)
          cache.current.set(keyOf(r.path, hidden), r)
          copyable.current.set(path, r.canCopy)
          copyable.current.set(r.path, r.canCopy)
          reporter.reset()
          return r
        })
        .catch((error: unknown) => {
          reporter.report(error)
          failures.current.set(key, httpStatus(error) ?? 0)
          return null
        })
        .finally(() => {
          inflight.current.delete(key)
          bump((n) => n + 1)
        })
      inflight.current.set(key, task)
      bump((n) => n + 1)
      return task
    },
    [reporter],
  )

  const get = useCallback((path: string, hidden: boolean) => cache.current.get(keyOf(path, hidden)), [])
  const failedOf = useCallback((path: string, hidden: boolean) => failures.current.get(keyOf(path, hidden)), [])
  const canCopyOf = useCallback((path: string) => copyable.current.get(path), [])

  // get·failedOf·canCopyOf는 ref를 읽으므로, 값이 바뀐 렌더마다 새 객체를 돌려줘 소비자가 다시 그리게 한다.
  return { places, placesFailed, loadPlaces, get, failedOf, load, canCopyOf }
}
