/** user-agent에서 "iPhone · Safari"처럼 운영체제와 브라우저 이름을 짧게 뽑는다. 모르면 undefined(호출부가 "알 수 없는 기기"를 쓴다). */
export function deviceLabel(ua?: string): string | undefined {
  if (!ua) return undefined
  // 순서가 중요하다: iPadOS·안드로이드 UA에 Mac·Linux가 섞여 있고, Chrome UA에 Safari가 들어 있다.
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : undefined
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : undefined
  return [os, browser].filter(Boolean).join(' · ') || undefined
}
