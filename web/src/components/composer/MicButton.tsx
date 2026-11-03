import { reportClientError } from '../../lib/errorReporting'
// 브라우저 음성 인식. 인식 기능이 없으면 버튼을 그리지 않는다.
import { useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { useStore } from '../../lib/store'
import { dictationLang, finalTranscript, findSpeechCtor, type SpeechCtor, type SpeechSession } from '../../lib/dictation'

export function MicButton({ disabled, size, onText }: { disabled: boolean; size: number; onText: (text: string) => void }) {
  const t = useT()
  const locale = useStore().locale
  const host = typeof window === 'undefined' ? {} : (window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor })
  const ctor = findSpeechCtor(host)
  const [on, setOn] = useState(false)
  const recRef = useRef<SpeechSession | null>(null)
  if (!ctor) return null
  const stop = () => {
    recRef.current?.stop()
    recRef.current = null
    setOn(false)
  }
  const start = () => {
    const rec = new ctor()
    rec.lang = dictationLang(locale)
    rec.continuous = true
    rec.interimResults = true
    let cursor = 0
    rec.onresult = (event) => {
      const spoken = finalTranscript(event.results, event.resultIndex ?? cursor)
      cursor = spoken.next
      if (spoken.text.trim()) onText(spoken.text)
    }
    rec.onerror = () => setOn(false)
    rec.onend = () => setOn(false)
    recRef.current = rec
    try {
      rec.start()
      setOn(true)
    } catch (error) {
      if (!(error instanceof DOMException && ['NotAllowedError', 'SecurityError', 'NotSupportedError', 'InvalidStateError'].includes(error.name))) {
        reportClientError(error, { component: 'composer', operation: 'web.dictation.start' })
      }
      // 브라우저가 인식 시작을 거절하거나 이미 시작했으면 꺼진 표시로 돌아간다.
      setOn(false)
    }
  }
  return (
    <button
      type="button"
      onClick={() => (on ? stop() : start())}
      disabled={disabled}
      aria-pressed={on}
      aria-label={on ? t('composer.mic.stop') : t('composer.mic.aria')}
      title={t('composer.mic.title')}
      className="attach-btn hit-44 inline-flex items-center justify-center"
      style={{ width: size, height: size, borderRadius: R.full, flexShrink: 0, color: on ? 'var(--c-ok)' : undefined }}
    >
      <Mic size={18} />
    </button>
  )
}
