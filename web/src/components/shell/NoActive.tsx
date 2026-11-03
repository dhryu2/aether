// 고른 세션이 하나도 없을 때 채팅 자리에 대신 나오는 화면 — 인사하는 참딩, 안내 한 줄, "새 세션" 버튼.
//   부팅·재연결 덮개가 위에 있으면 그림 자리만 비워 둔다. 덮개 참딩과 둘이 동시에 움직이지 않게.
import { Plus } from 'lucide-react'
import { actions, showLoadMask, useStore } from '../../lib/store'
import { useT } from '../../lib/i18n'
import { Button } from '../ui'
import { C, R } from '../../design/tokens'
import { ChamdingMascot } from '../ChamdingMascot'
import { chamdingWidth } from '../chamdingWidth'

const EMPTY_H = 68

export function NoActive() {
  const t = useT()
  const masked = showLoadMask(useStore())
  return (
    <div className="flex h-full flex-col items-center justify-center" style={{ gap: 16, padding: 24 }}>
      {masked ? (
        <div style={{ width: chamdingWidth(EMPTY_H), height: EMPTY_H }} aria-hidden />
      ) : (
        <ChamdingMascot state="empty" size={EMPTY_H} playOnMount />
      )}
      <div style={{ fontSize: 15, color: C.label2 }}>{t('nav.app.noActive.desc')}</div>
      <Button
        tone="primary"
        onClick={() => actions.openModal()}
        radius={R.field}
        paddingX={16}
        className="inline-flex items-center"
        style={{ gap: 6 }}
      >
        <Plus size={16} /> {t('nav.session.new')}
      </Button>
    </div>
  )
}
