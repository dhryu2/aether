// 주요 화면 흐름. 권한·멈추기·새로고침·보내기·카드 답은 데스크톱과 폰 모두.
// 이름·첨부·검색·설정·다크 모드·브리프·옛 글·키보드는 데스크톱만.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { SLOW_MS } from '../fakeProvider'

// 멈추기 시험이 답을 기다리는 시간. SLOW 답은 SLOW_MS 뒤에 나오므로, 그보다 짧게 보면
// 답이 아직 없을 뿐인데 개수 0이 바로 통과한다.
const STOP_WATCH_MS = SLOW_MS + 1_000

async function openApp(page: Page) {
  await page.goto('/')
  await expect
    .poll(async () => {
      const loading = await page.getByLabel('세션 불러오는 중').count()
      const reconnecting = await page.getByLabel('재연결 중').count()
      return loading + reconnecting
    })
    .toBe(0)
}

async function openNewWork(page: Page) {
  // 화면 밖 요소도 Playwright는 보인다고 친다. 폭으로 폰과 넓은 화면을 가른다.
  const narrow = (page.viewportSize()?.width ?? 1280) < 760
  if (narrow) {
    const drawer = page.locator('[data-drawer-open="1"]')
    const newer = drawer.getByRole('button', { name: '새 세션' })
    // 여는 클릭이 뒷막에 닿으면 서랍이 바로 닫힌다. 새 작업 단추가 화면 안에 남을 때까지 다시 연다.
    await expect(async () => {
      if ((await drawer.count()) === 0) {
        await page.getByRole('button', { name: '세션 목록 열기' }).click({ timeout: 3_000 })
      }
      await expect(newer).toBeInViewport({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await newer.click()
  } else {
    await page.locator('aside [data-session-opt="new-work"]').click()
  }
  await expect(page.locator('[data-modal="new-session"]')).toBeVisible()
}

async function createWork(page: Page, opts: { name: string }) {
  await openApp(page)
  await openNewWork(page)
  const modal = page.locator('[data-modal="new-session"]')
  await modal.getByLabel('이름').fill(opts.name)
  await expect(modal.locator('[data-folder-browse]')).toBeEnabled()
  await modal.locator('[data-folder-browse]').click()
  await modal.locator('[data-folder-entry="notes"]').click()
  await modal.locator('[data-folder-choose]').click()
  await expect(modal.getByRole('radio', { name: 'notes' })).toHaveAttribute('aria-checked', 'true')
  const provider = modal.locator('[data-provider-id="e2e"]')
  await provider.click()
  await expect(provider).toHaveAttribute('data-provider-selected', '1')
  await modal.getByRole('button', { name: '세션 시작' }).click()
  const alert = modal.getByRole('alert')
  const composer = page.getByPlaceholder(/메시지를 입력/)
  await expect(composer.or(alert)).toBeVisible()
  if (await alert.isVisible()) throw new Error(await alert.innerText())
  await expect(modal).toBeHidden()
  // 세션을 고르면 서랍이 닫힌다. 아직 열려 있을 때만 닫기 버튼을 누른다.
  const openDrawer = page.locator('[data-drawer-open="1"]')
  if ((await openDrawer.count()) > 0) {
    await openDrawer.getByRole('button', { name: '세션 목록 닫기' }).click()
    await expect(page.locator('[data-drawer-open="0"]')).toBeVisible()
  }
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/메시지를 입력/)
  await box.fill(text)
  await page.getByRole('button', { name: '전송', exact: true }).click()
}

async function expectAssistant(page: Page, text: string) {
  await expect(page.locator('.bubble-assistant').filter({ hasText: text })).toBeVisible()
}

function desktopOnly(info: TestInfo) {
  test.skip(info.project.name !== 'desktop', '데스크톱 크기에서만')
}

function mobileOnly(info: TestInfo) {
  test.skip(info.project.name !== 'mobile', '폰 크기에서만')
}

async function openWorkMenu(page: Page, name: string) {
  const row = page.locator('[data-session-id]').filter({ hasText: name }).first()
  await row.hover()
  await row.getByRole('button', { name: '세션 메뉴' }).click()
  await expect(page.getByRole('menuitem', { name: '세션 삭제' })).toBeVisible()
}

async function focusByTab(page: Page, target: Locator) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  for (let i = 0; i < 50; i++) {
    const focused = await target.evaluate((el) => el === document.activeElement).catch(() => false)
    if (focused) return
    await page.keyboard.press('Tab')
  }
  throw new Error('키보드로 그 칸에 닿지 못했다')
}

async function expectAbsentFor(page: Page, text: string, waitMs: number) {
  const late = page.locator('.bubble-assistant').filter({ hasText: text })
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if ((await late.count()) > 0) throw new Error('멈추기 뒤에 늦은 답이 말풍선으로 남았다')
    await page.waitForTimeout(200)
  }
  await expect(late).toHaveCount(0)
}

async function pageUp(page: Page, scroller: Locator) {
  const box = await scroller.boundingBox()
  if (!box) return
  // 대화 칸의 위쪽을 짚어야 입력칸이 휠을 먹지 않는다.
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 3))
  await page.mouse.wheel(0, -700)
}

async function scrollUntilAssistant(page: Page, text: string) {
  const scroller = page.locator('.stream-scroll')
  const target = page.locator('.bubble-assistant').filter({ hasText: text })
  const earliest = page.locator('.bubble-assistant').first()
  // 한 번에 맨 위로 뛰면 화면이 바닥으로 다시 붙고, 이미 펼친 말풍선이 사라진다.
  // 한 화면씩 올린다. 옛 글이 앞에 붙으면 스크롤 자리는 아래로 밀리므로, 맨 위 글이 바뀌는 것도 진행으로 본다.
  let stuck = 0
  for (let i = 0; i < 80; i++) {
    if ((await target.count()) > 0) {
      await target.first().scrollIntoViewIfNeeded()
      await expect(target.first()).toBeInViewport()
      return
    }
    const beforeText = (await earliest.count()) ? await earliest.innerText() : ''
    const beforeTop = await scroller.evaluate((el) => el.scrollTop)
    await pageUp(page, scroller)
    if (beforeTop > 1) {
      await scroller.evaluate((el) => {
        const step = Math.max(240, Math.floor(el.clientHeight * 0.8))
        el.scrollTop = Math.max(0, el.scrollTop - step)
      })
    }
    const progressed = await expect
      .poll(async () => {
        if ((await target.count()) > 0) return 'found'
        const nowText = (await earliest.count()) ? await earliest.innerText() : ''
        if (nowText !== beforeText) return 'grew'
        const nowTop = await scroller.evaluate((el) => el.scrollTop)
        if (nowTop < beforeTop - 1) return 'up'
        return 'same'
      }, { timeout: 1_200 })
      .not.toBe('same')
      .then(() => true)
      .catch(() => false)
    if (progressed) {
      stuck = 0
      continue
    }
    stuck += 1
    if (stuck < 4) continue
    const now = await scroller.evaluate((el) => ({ top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight }))
    throw new Error(`위로 스크롤해도 옛 글이 보이지 않는다 top=${now.top} height=${now.height} client=${now.client} first=${beforeText.slice(0, 48)}`)
  }
  throw new Error('위로 스크롤해도 옛 글이 보이지 않는다')
}

test('첫 화면에 작업 목록이 보인다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  const side = page.getByRole('complementary')
  await expect(side.getByText('Aether')).toBeVisible()
  await expect(side.getByPlaceholder('세션 검색')).toBeVisible()
  await expect(side.getByText('세션이 없어요.').or(side.locator('[data-session-id]').first())).toBeVisible()
})

test('작업 폴더를 고르고 새 세션을 만든다', async ({ page }, info) => {
  desktopOnly(info)
  const name = `e2e-new-${Date.now().toString(36)}`
  await createWork(page, { name })
  await expect(page.getByRole('complementary').getByText(name)).toBeVisible()
  await expect(page.getByPlaceholder(/메시지를 입력/)).toBeVisible()
})

test('메시지를 보내면 가짜 모델의 답이 말풍선으로 그려진다', async ({ page }, info) => {
  desktopOnly(info)
  await createWork(page, { name: `e2e-send-${Date.now().toString(36)}` })
  const text = `안녕 e2e-bubble-${Date.now().toString(36)}`
  await send(page, text)
  await expect(page.locator('.bubble-user').filter({ hasText: text })).toBeVisible()
  await expectAssistant(page, text)
})

test('권한 카드를 허락하면 서버에 전달된다', async ({ page }) => {
  await createWork(page, { name: `e2e-allow-${Date.now().toString(36)}` })
  await send(page, 'ASK:e2e-write-demo')
  await expect(page.getByText('시험 권한').first()).toBeVisible()
  await expect(page.getByText('e2e-write-demo', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '승인', exact: true }).first().click()
  await expectAssistant(page, 'allowed')
  await expect(page.getByText('승인됨').first()).toBeVisible()
})

test('권한 카드를 거부하면 서버에 전달된다', async ({ page }) => {
  await createWork(page, { name: `e2e-deny-${Date.now().toString(36)}` })
  await send(page, 'ASK:e2e-write-demo')
  await expect(page.getByText('시험 권한').first()).toBeVisible()
  await page.getByRole('button', { name: '거부', exact: true }).first().click()
  await expectAssistant(page, 'denied')
  await expect(page.getByText('거부됨')).toBeVisible()
})

test('질문 카드에서 고른 답이 전달된다', async ({ page }, info) => {
  desktopOnly(info)
  await createWork(page, { name: `e2e-ask-${Date.now().toString(36)}` })
  await send(page, 'Q:color')
  await expect(page.getByText('어떤 색을 고를까요?', { exact: true })).toBeVisible()
  await page.locator('.choice-row').filter({ hasText: '파랑' }).click()
  await page.getByRole('button', { name: '답변 보내기' }).click()
  await expectAssistant(page, 'answered:파랑')
})

test('실행 중 멈추기 단추가 답을 막는다', async ({ page }) => {
  await createWork(page, { name: `e2e-stop-${Date.now().toString(36)}` })
  await send(page, 'SLOW:should-not-appear-xyz')
  const stop = page.getByRole('button', { name: '중단' })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(page.getByText('응답을 중단했어요')).toBeVisible()
  await expect(stop).toBeHidden()
  // 개수가 지금 0인 것은 증거가 아니다. SLOW 답이 나올 시간이 지나도 없어야 막힌 것이다.
  await expectAbsentFor(page, 'should-not-appear-xyz', STOP_WATCH_MS)
})

test('새로고침 뒤 대화가 남고 이어서 보낼 수 있다', async ({ page }) => {
  await createWork(page, { name: `e2e-reload-${Date.now().toString(36)}` })
  const first = `e2e-restore-a-${Date.now().toString(36)}`
  await send(page, first)
  await expectAssistant(page, first)
  const stream = page.waitForRequest((req) => /\/api\/sessions\/[^/]+\/stream/.test(req.url()))
  await page.reload()
  await stream
  await expect
    .poll(async () => {
      const loading = await page.getByLabel('세션 불러오는 중').count()
      const reconnecting = await page.getByLabel('재연결 중').count()
      return loading + reconnecting
    })
    .toBe(0)
  await expect(page.locator('.bubble-user').filter({ hasText: first })).toBeVisible()
  await expectAssistant(page, first)
  const second = `e2e-restore-b-${Date.now().toString(36)}`
  await send(page, second)
  await expectAssistant(page, second)
})

test('폰에서 메시지를 보내면 답이 말풍선으로 그려진다', async ({ page }, info) => {
  mobileOnly(info)
  await createWork(page, { name: `e2e-m-send-${Date.now().toString(36)}` })
  const text = `폰 e2e-bubble-${Date.now().toString(36)}`
  await send(page, text)
  await expect(page.locator('.bubble-user').filter({ hasText: text })).toBeVisible()
  await expectAssistant(page, text)
})

test('폰에서 질문 카드에 답하면 전달된다', async ({ page }, info) => {
  mobileOnly(info)
  await createWork(page, { name: `e2e-m-ask-${Date.now().toString(36)}` })
  await send(page, 'Q:color')
  await expect(page.getByText('어떤 색을 고를까요?', { exact: true })).toBeVisible()
  await page.locator('.choice-row').filter({ hasText: '파랑' }).click()
  await page.getByRole('button', { name: '답변 보내기' }).click()
  await expectAssistant(page, 'answered:파랑')
})

test('세션 이름을 바꾸고 지운다', async ({ page }, info) => {
  desktopOnly(info)
  const name = `e2e-name-${Date.now().toString(36)}`
  const next = `e2e-renamed-${Date.now().toString(36)}`
  await createWork(page, { name })
  const box = page.getByPlaceholder(/메시지를 입력/)
  await box.fill(`/rename ${next}`)
  await page.getByRole('button', { name: '전송', exact: true }).click()
  const side = page.getByRole('complementary')
  await expect(side.getByText(next)).toBeVisible()
  await expect(side.getByText(name)).toHaveCount(0)
  await openWorkMenu(page, next)
  await page.getByRole('menuitem', { name: '세션 삭제' }).click()
  const dialog = page.locator('[data-window="delete"]')
  await expect(dialog).toContainText(next)
  await dialog.getByRole('button', { name: '삭제', exact: true }).click()
  await expect(side.locator('[data-session-id]').filter({ hasText: next })).toHaveCount(0)
})

test('첨부 파일을 보내면 말풍선에 남는다', async ({ page }, info) => {
  desktopOnly(info)
  await createWork(page, { name: `e2e-file-${Date.now().toString(36)}` })
  const marker = `e2efile${Date.now().toString(36)}`
  await page.getByRole('button', { name: '첨부와 코드 상자' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: '파일 첨부' }).click(),
  ])
  await chooser.setFiles({
    name: 'e2e-memo.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`hello ${marker}`),
  })
  await expect(page.getByText('e2e-memo.txt').first()).toBeVisible()
  await page.getByPlaceholder(/메시지를 입력/).fill('첨부 확인')
  await page.getByRole('button', { name: '전송', exact: true }).click()
  const mine = page.locator('.bubble-user').filter({ hasText: '첨부: e2e-memo.txt' })
  await expect(mine).toBeVisible()
  await expect(mine).toContainText(marker)
  await expectAssistant(page, marker)
})

test('검색 화면에서 작업과 지난 말을 찾는다', async ({ page }, info) => {
  desktopOnly(info)
  const name = `e2e-find-${Date.now().toString(36)}`
  const marker = `e2efind${Date.now().toString(36)}`
  await createWork(page, { name })
  await send(page, marker)
  await expectAssistant(page, marker)
  const side = page.getByRole('complementary')
  await side.getByLabel('세션 검색').fill(name)
  await expect(side.locator('[data-session-id]').filter({ hasText: name })).toBeVisible()
  await side.getByLabel('세션 검색').fill(`없는작업${marker}`)
  await expect(side.getByText('검색된 세션이 없어요.')).toBeVisible()
  await side.getByLabel('세션 검색').fill('')
  await side.getByRole('button', { name: '지난 대화 검색' }).click()
  const palette = page.getByRole('dialog', { name: '지난 대화 검색' })
  await expect(palette).toBeVisible()
  await palette.getByPlaceholder('지난 대화, 명령, 실행 결과 찾기').fill(marker)
  await expect(palette.getByText(marker).first()).toBeVisible()
})

test('설정 화면에서 언어를 바꿀 수 있다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.locator('[data-window="settings"]')
  await expect(dialog.getByRole('heading', { name: '설정' })).toBeVisible()
  await expect(dialog.getByText('일반', { exact: true })).toBeVisible()
  await expect(dialog.getByText('언어', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'English' }).click()
  await expect(dialog.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(dialog.getByText('General', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('다크 모드로 바꾸면 글자 색이 바뀐다', async ({ page }, info) => {
  desktopOnly(info)
  await page.emulateMedia({ colorScheme: 'light' })
  await openApp(page)
  const title = page.getByRole('complementary').getByText('Aether', { exact: true })
  await expect.poll(async () => title.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(29, 29, 31)')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(async () => title.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(245, 245, 247)')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(async () => title.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(29, 29, 31)')
})

test('전송 단추를 우클릭하면 브리프로 보낼 수 있다', async ({ page }, info) => {
  desktopOnly(info)
  await createWork(page, { name: `e2e-brief-${Date.now().toString(36)}` })
  const text = `e2ebrief${Date.now().toString(36)}`
  await page.getByPlaceholder(/메시지를 입력/).fill(text)
  await page.getByRole('button', { name: '전송', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '브리프로 보내기' }).click()
  await expect(page.locator('.bubble-user').filter({ hasText: text })).toBeVisible()
  await expectAssistant(page, `brief:${text}`)
})

test('긴 대화에서 위로 올리면 옛 글이 나타난다', async ({ page }, info) => {
  desktopOnly(info)
  test.setTimeout(120_000)
  const token = `e2ehist${Date.now().toString(36)}`
  await createWork(page, { name: `e2e-hist-${Date.now().toString(36)}` })
  await send(page, `HISTORY:${token}`)
  await expect(page.locator('.bubble-assistant').filter({ hasText: `new-${token}` })).toBeVisible({ timeout: 90_000 })
  const stream = page.waitForRequest((req) => /\/api\/sessions\/[^/]+\/stream/.test(req.url()))
  await page.reload()
  await stream
  await expect
    .poll(async () => {
      const loading = await page.getByLabel('세션 불러오는 중').count()
      const reconnecting = await page.getByLabel('재연결 중').count()
      return loading + reconnecting
    })
    .toBe(0)
  await expect(page.locator('.bubble-assistant').filter({ hasText: `new-${token}` })).toBeVisible()
  await expect(page.locator('.bubble-assistant').filter({ hasText: `old-${token}` })).toHaveCount(0)
  await scrollUntilAssistant(page, `old-${token}`)
})

test('키보드만으로 메시지를 보낼 수 있다', async ({ page }, info) => {
  desktopOnly(info)
  await createWork(page, { name: `e2e-key-${Date.now().toString(36)}` })
  const text = `e2ekey${Date.now().toString(36)}`
  const box = page.getByPlaceholder(/메시지를 입력/)
  await focusByTab(page, box)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await expect(page.locator('.bubble-user').filter({ hasText: text })).toBeVisible()
  await expectAssistant(page, text)
})

test('키보드만으로 질문 카드에 답할 수 있다', async ({ page }, info) => {
  desktopOnly(info)
  await createWork(page, { name: `e2e-keyq-${Date.now().toString(36)}` })
  await send(page, 'Q:color')
  await expect(page.getByText('어떤 색을 고를까요?', { exact: true })).toBeVisible()
  const choice = page.locator('.choice-row').filter({ hasText: '파랑' })
  await focusByTab(page, choice)
  await page.keyboard.press('Enter')
  await expect(choice).toHaveAttribute('aria-pressed', 'true')
  const submit = page.getByRole('button', { name: '답변 보내기' })
  for (let i = 0; i < 15; i++) {
    const onSubmit = await submit.evaluate((el) => el === document.activeElement).catch(() => false)
    if (onSubmit) break
    await page.keyboard.press('Tab')
    if (i === 14) throw new Error('키보드로 답변 보내기에 닿지 못했다')
  }
  await page.keyboard.press('Enter')
  await expectAssistant(page, 'answered:파랑')
})
