// 설정 > 서버의 「서버 정보」와 「AI 서비스」 칸. 둘 다 읽기 전용이다.
// AI 서비스 상태는 provider가 알려 준 중립 이유 낱말만 문구로 바꿔 보여 준다(provider 이름으로 나누지 않는다).
import { useEffect, useState } from 'react'
import type { ProviderAvailability, ServerInfoResponse, UpdateStatusResponse } from '@shared/http'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { actions, getState, useStore } from '../../lib/store'
import { safeHttpUrl } from '../../lib/updateNotice'
import { errMsg } from '../../lib/errors'
import { Button, Switch } from '../ui'
import { ExternalLink } from 'lucide-react'
import { C } from '../../design/tokens'
import { Group, GroupNote, GroupTitle, Sep, SkeletonRows, StackRow, TextRow, ValueRow } from './parts'
import { rowMin, useNarrow } from './settingsLayout'

type Loaded<T> = T | 'loading' | 'failed'

export function ServerInfoSection({ hideTitle }: { hideTitle?: boolean }) {
  const t = useT()
  const [info, setInfo] = useState<Loaded<ServerInfoResponse>>('loading')
  useEffect(() => {
    let alive = true
    api.systemInfo().then((r) => alive && setInfo(r), () => alive && setInfo('failed'))
    return () => { alive = false }
  }, [])
  // 새 버전 확인은 덤이다. 꺼져 있거나 실패하면 줄을 만들지 않는다.
  const [update, setUpdate] = useState<UpdateStatusResponse | null>(null)
  useEffect(() => {
    let alive = true
    api.systemUpdate().then((r) => alive && setUpdate(r), () => undefined)
    return () => { alive = false }
  }, [])
  const narrow = useNarrow()
  const [checking, setChecking] = useState(false)
  // 다른 탭에서 시작했거나 새로 고친 경우: 이미 진행 중이면 진행 화면을 자동으로 연다.
  useEffect(() => {
    const ph = update?.install?.phase
    if (update && (ph === 'checking' || ph === 'downloading' || ph === 'installing') && !getState().updateProgress) {
      actions.openUpdateProgress({ fromVersion: update.current, targetVersion: update.install && 'version' in update.install ? update.install.version : undefined, pageUrl: update.pageUrl })
    }
  }, [update])
  const installable = !!update?.canInstall && update.available && !!update.latest
  const link = update?.available && !installable ? safeHttpUrl(update.pageUrl) : null
  const checkNow = async () => {
    setChecking(true)
    try { setUpdate(await api.checkUpdateNow()) } catch (e) { actions.showError(errMsg(e)) } finally { setChecking(false) }
  }
  const requestInstall = () => {
    if (!update?.latest) return
    const version = update.latest
    const running = getState().sessions.filter((s) => s.attention === 'running').length
    actions.showConfirm({
      tone: running > 0 ? 'warn' : 'neutral',
      title: t('update.confirm.title', { version }),
      message: (running > 0 ? t('update.confirm.running', { n: running }) + '\n' : '') + t('update.confirm.body'),
      confirmLabel: t('update.confirm.action'),
      onConfirm: async () => {
        try {
          await api.installUpdate(version)
          actions.openUpdateProgress({ fromVersion: update.current, targetVersion: version, pageUrl: update.pageUrl })
        } catch (e) {
          actions.showError(errMsg(e))
          // 그 사이 새 버전이 나왔을 수 있다 — 표시를 서버 값으로 다시 맞춘다.
          api.systemUpdate().then(setUpdate, () => undefined)
        }
      },
    })
  }
  const rowButton = (label: string, onClick: () => void, opts: { primary?: boolean; disabled?: boolean } = {}) => (
    <Button type="button" tone={opts.primary ? 'primary' : 'gray'} height={narrow ? 44 : 32} paddingX={14} fontSize={14} disabled={opts.disabled} onClick={onClick}>{label}</Button>
  )
  return (
    <section>
      {!hideTitle && <GroupTitle>{t('settings.info.title')}</GroupTitle>}
      {info === 'loading' ? (
        <SkeletonRows count={5} />
      ) : info === 'failed' ? (
        <GroupNote>{t('settings.info.failed')}</GroupNote>
      ) : (
        <Group>
          <ValueRow label={t('settings.info.version')} value={info.version} copy={info.version} />
          {update?.enabled && (
            <>
              <Sep />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '4px 16px' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('update.row.new')}</span>
                <span style={{ fontSize: 15, color: C.label2 }}>{update.available ? update.latest : update.latest ? t('update.row.latest') : t('update.row.unknown')}</span>
                {installable
                  ? rowButton(t('update.row.install'), requestInstall, { primary: true })
                  : !update.available && rowButton(t('update.row.checkNow'), () => void checkNow(), { disabled: checking })}
              </div>
              {link && (
                <>
                  <Sep />
                  <StackRow label={t('update.row.download')} value={<a href={link} target="_blank" rel="noopener noreferrer" style={{ color: C.tint }}>{link}</a>} />
                </>
              )}
            </>
          )}
          <Sep />
          <ValueRow label={t('settings.info.port')} value={info.port} copy={info.port} />
          <Sep />
          <ValueRow label={t('settings.info.authMode')} value={t(`settings.info.auth.${info.authMode}`)} copy={t(`settings.info.auth.${info.authMode}`)} />
          <Sep />
          <StackRow label={t('settings.info.dataDir')} value={info.dataDir} copy={info.dataDir} />
          <Sep />
          <StackRow label={t('settings.info.projectRoot')} value={info.projectRoot} copy={info.projectRoot} />
        </Group>
      )}
      {link && info !== 'loading' && info !== 'failed' && <GroupNote>{t('update.row.note')}</GroupNote>}
      {update?.rolledBackVersion && info !== 'loading' && info !== 'failed' && <GroupNote>{t('update.row.rolledBack')}</GroupNote>}
      {info !== 'loading' && info !== 'failed' && info.termsUrl && (
        <div style={{ marginTop: 16 }}>
          <Group>
            <TextRow onClick={() => window.open(info.termsUrl, '_blank', 'noopener,noreferrer')}>
              {t('setup.terms.title')}
              <ExternalLink size={16} aria-hidden color={C.label3} />
            </TextRow>
          </Group>
        </div>
      )}
    </section>
  )
}

/** 검색 결과 요약 스위치. 불러오는 동안과 실패(검색이 꺼진 서버는 404) 때는 비활성이고, 저장은 서버 응답 뒤에 화면에 반영한다. */
function SearchSummaryRow() {
  const t = useT()
  const narrow = useNarrow()
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined) // undefined=불러오는 중이거나 실패
  useEffect(() => {
    let alive = true
    api.getSearchSummary().then((r) => alive && setEnabled(r.enabled), () => {})
    return () => { alive = false }
  }, [])
  const usable = enabled !== undefined
  return (
    <div style={{ marginTop: 24 }}>
      <Group>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px', cursor: usable ? 'pointer' : 'default' }}>
          <span aria-hidden style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.searchSummary.title')}</span>
          <Switch
            className={narrow ? 'hit-44' : undefined}
            on={!!enabled}
            disabled={!usable}
            label={t('settings.searchSummary.title')}
            onChange={() => usable && void api.putSearchSummary(!enabled).then((r) => setEnabled(r.enabled), (e) => actions.showError(errMsg(e)))}
          />
        </label>
      </Group>
      <GroupNote>{t('settings.searchSummary.note')}</GroupNote>
    </div>
  )
}

/** 세션 제목 자동 요약 스위치. 불러오는 동안과 실패 때는 비활성이고, 저장은 서버 응답 뒤에 화면에 반영한다. */
function TitleSummaryRow() {
  const t = useT()
  const narrow = useNarrow()
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined) // undefined=불러오는 중이거나 실패
  useEffect(() => {
    let alive = true
    api.getTitleSummary().then((r) => alive && setEnabled(r.enabled), () => {})
    return () => { alive = false }
  }, [])
  const usable = enabled !== undefined
  return (
    <div style={{ marginTop: 24 }}>
      <Group>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px', cursor: usable ? 'pointer' : 'default' }}>
          <span aria-hidden style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.titleSummary.title')}</span>
          <Switch
            className={narrow ? 'hit-44' : undefined}
            on={!!enabled}
            disabled={!usable}
            label={t('settings.titleSummary.title')}
            onChange={() => usable && void api.putTitleSummary(!enabled).then((r) => setEnabled(r.enabled), (e) => actions.showError(errMsg(e)))}
          />
        </label>
      </Group>
      <GroupNote>{t('settings.titleSummary.note')}</GroupNote>
    </div>
  )
}

export function LlmSection({ hideTitle }: { hideTitle?: boolean }) {
  const t = useT()
  const providers = useStore().providers ?? []
  const [availability, setAvailability] = useState<Loaded<Record<string, ProviderAvailability>>>('loading')
  useEffect(() => {
    let alive = true
    api.providerAvailability().then((r) => alive && setAvailability(r.availability), () => alive && setAvailability('failed'))
    return () => { alive = false }
  }, [])
  if (providers.length === 0) return null
  return (
    <section>
      {!hideTitle && <GroupTitle>{t('settings.llm.title')}</GroupTitle>}
      {availability === 'failed' ? (
        <GroupNote>{t('settings.llm.failed')}</GroupNote>
      ) : (
        <Group>
          {providers.map((p, i) => {
            const a = availability === 'loading' ? undefined : availability[p.id]
            const bad = a && !a.available ? a : undefined
            const text = !a
              ? t('settings.llm.checking')
              : bad
                ? bad.requires
                  ? t('session.newSession.providerUnavailable.requires', { requires: bad.requires })
                  : t(`session.newSession.providerUnavailable.${bad.reason}`)
                : t('settings.llm.ready')
            return (
              <div key={p.id}>
                {i > 0 && <Sep />}
                <ValueRow label={p.displayName} value={text} color={bad ? C.attn : undefined} />
              </div>
            )
          })}
        </Group>
      )}
      <SearchSummaryRow />
      <TitleSummaryRow />
    </section>
  )
}
