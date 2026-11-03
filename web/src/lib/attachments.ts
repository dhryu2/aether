// 파일 첨부 규칙 — 컴포저에서 떼어낸 순수 로직(React 비의존, 그래서 단위 테스트가 된다).
// 제약은 백엔드(routes/sessions.ts)와 정합. 이미지(vision)·PDF(document)·텍스트/코드(메시지에 인라인 주입).

export const ACCEPT_IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// 텍스트/코드: mime이 비어있는 코드파일이 많아 확장자로도 허용.
export const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|conf|csv|tsv|log|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|swift|scala|sh|bash|zsh|sql|html?|css|scss|less|xml|svg|vue|svelte|astro|env|gitignore|dockerfile|makefile)$/i
export const ACCEPT_ALL = [...ACCEPT_IMAGE, 'application/pdf', 'text/*', '.md', '.txt', '.py', '.js', '.ts', '.tsx', '.json', '.yaml', '.yml', '.go', '.rs', '.java', '.sh', '.sql', '.csv', '.html', '.css'].join(',')
export const MAX_ATTACH = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 이미지 개당 5MB
export const MAX_PDF_BYTES = 10 * 1024 * 1024 // PDF 개당 10MB
export const MAX_TEXT_BYTES = 256 * 1024 // 텍스트/코드는 프롬프트에 인라인 → 작게(256KB)

export type AttachKind = 'image' | 'pdf' | 'text'
// 통합 첨부: image/pdf는 data=base64, text는 data=원문 텍스트. url=이미지 미리보기용.
export type Attachment = { kind: AttachKind; name: string; media_type: string; data: string; url?: string }

export function classify(file: File): AttachKind | null {
  if (ACCEPT_IMAGE.includes(file.type)) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  if (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.test(file.name)) return 'text'
  return null
}

export function maxBytesFor(kind: AttachKind): number {
  return kind === 'image' ? MAX_IMAGE_BYTES : kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES
}

// File → Attachment. text는 readAsText(원문), image/pdf는 base64(prefix 분리). 실패·미지원이면 null.
export async function fileToAttachment(file: File): Promise<Attachment | null> {
  const kind = classify(file)
  if (!kind) return null
  if (kind === 'text') {
    try {
      return { kind, name: file.name, media_type: 'text/plain', data: await file.text() }
    } catch {
      // 사용자가 고른 파일을 브라우저가 읽지 못하면 첨부에서 제외한다.
      return null
    }
  }
  const dataUrl: string = await new Promise((res) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => res('')
    r.readAsDataURL(file)
  })
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!m) return null
  const media_type = kind === 'pdf' ? 'application/pdf' : m[1]
  return { kind, name: file.name, media_type, data: m[2], url: kind === 'image' ? dataUrl : undefined }
}

// 고른 파일들을 종류·크기로 거른 뒤 Attachment로 변환. 붙여넣기·드롭·파일선택 공용.
//   rejected = 형식이 맞지 않거나 용량을 넘겨 버려진 파일이 하나라도 있었는지(안내 문구 판정용).
export async function parseFiles(files: File[]): Promise<{ parsed: Attachment[]; rejected: boolean }> {
  let rejected = false
  const ok: File[] = []
  for (const f of files) {
    const kind = classify(f)
    if (!kind || f.size > maxBytesFor(kind)) { rejected = true; continue }
    ok.push(f)
  }
  const parsed = (await Promise.all(ok.map(fileToAttachment))).filter((a): a is Attachment => !!a)
  return { parsed, rejected }
}
