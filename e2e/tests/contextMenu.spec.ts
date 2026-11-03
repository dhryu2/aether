// 우클릭 메뉴를 실제 브라우저로 누르는 시험. 이벤트 전파와 겹침 순서는 함수 시험으로 잡을 수 없다.
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { SLOW_MS } from '../fakeProvider'

const menu = (page: Page) => page.locator('[data-context-menu]')
const item = (page: Page, name: string | RegExp) => menu(page).getByRole('menuitem', { name })
const card = (page: Page, title: string) => page.locator('aside .session-row').filter({ hasText: title })
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

// 새 세션 창은 flows 시험의 몫이다. 여기서는 API로 만들고 카드를 눌러 연다.
async function createWork(page: Page, name: string) {
  const { workDir } = JSON.parse(readFileSync(new URL('../.runtime/state.json', import.meta.url), 'utf8'))
  const res = await page.request.post('/api/sessions', { data: { cwd: `${workDir}/notes`, provider: 'e2e', name } })
  expect(res.ok()).toBe(true)
  await page.reload()
  await expect(card(page, name)).toBeVisible()
  await card(page, name).click()
  await expect(page.getByPlaceholder(/메시지를 입력/)).toBeVisible()
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/메시지를 입력/).fill(text)
  await page.getByRole('button', { name: '전송', exact: true }).click()
}

async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.locator('aside [data-session-opt="new-work"]')).toBeVisible()
}

/** 메뉴를 띄웠을 때 브라우저 기본 메뉴를 막았는지 함께 본다. 헤드리스에서는 기본 메뉴가 그려지지 않는다. */
async function rightClickPrevented(page: Page, selector: string): Promise<boolean> {
  await page.evaluate(() => {
    const w = window as unknown as { __prevented?: boolean }
    w.__prevented = undefined
    window.addEventListener('contextmenu', (e) => { w.__prevented = e.defaultPrevented }, { once: true })
  })
  await page.locator(selector).first().click({ button: 'right' })
  return page.evaluate(() => (window as unknown as { __prevented?: boolean }).__prevented === true)
}

function desktopOnly(info: TestInfo) {
  test.skip(info.project.name !== 'desktop', '마우스 기기에서만')
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
})

test('세션 카드 우클릭은 메뉴만 열고 세션을 바꾸지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '우클릭-가')
  await createWork(page, '우클릭-나')
  const current = page.locator('aside .session-row-current')
  await expect(current).toContainText('우클릭-나')

  const box = (await card(page, '우클릭-가').boundingBox())!
  const x = box.x + 40
  const y = box.y + 20
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  const at = (await menu(page).boundingBox())!
  expect(Math.abs(at.x - x)).toBeLessThan(4)
  expect(Math.abs(at.y - y)).toBeLessThan(4)
  await expect(item(page, '이름 바꾸기')).toBeVisible()
  await expect(item(page, '폴더 경로 복사')).toBeVisible()
  await expect(current).toContainText('우클릭-나')
  await expect(card(page, '우클릭-가')).toHaveAttribute('data-menu-target', '')

  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
  await expect(card(page, '우클릭-가')).not.toHaveAttribute('data-menu-target', '')

  // 화면 가장자리에서 열어도 안에 들어온다.
  const view = page.viewportSize()!
  await page.mouse.click(box.x + 40, view.height - 4, { button: 'right' })
  if (await menu(page).isVisible()) {
    const edge = (await menu(page).boundingBox())!
    expect(edge.y + edge.height).toBeLessThanOrEqual(view.height)
    await page.keyboard.press('Escape')
  }
})

test('우클릭 메뉴와 점 메뉴 모두에서 이름을 바꾼다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '바꾸기-전')

  await card(page, '바꾸기-전').click({ button: 'right' })
  await item(page, '이름 바꾸기').click()
  const dialog = page.locator('[data-window="rename"]')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveValue('바꾸기-전')
  await dialog.getByRole('textbox').fill('바꾸기-후')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(card(page, '바꾸기-후')).toBeVisible()

  const row = card(page, '바꾸기-후')
  await row.hover()
  await row.locator('[data-session-opt="work-menu"]').click()
  await page.getByRole('menuitem', { name: '이름 바꾸기' }).click()
  await expect(dialog.getByRole('textbox')).toHaveValue('바꾸기-후')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('메뉴를 Esc로 닫아도 응답 중인 세션은 멈추지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, 'Esc-중단')
  await send(page, 'SLOW:끝까지 간다')
  await expect(page.getByRole('button', { name: /중단|멈추/ }).first()).toBeVisible()
  for (let i = 0; i < 3; i++) {
    await card(page, 'Esc-중단').click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toBeHidden()
  }
  await expect(page.locator('.bubble-assistant').filter({ hasText: '끝까지 간다' })).toBeVisible({ timeout: SLOW_MS + 5_000 })
})

test('창 위의 메뉴는 Esc와 막 누르기에 메뉴만 닫힌다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '창-위')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const dialog = page.locator('[data-window="settings"]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: '서버 정보' }).click()
  const version = dialog.getByText('버전', { exact: true }).first()
  await expect(version).toBeVisible()

  await version.click({ button: 'right' })
  await expect(item(page, '값 복사')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
  await expect(dialog).toBeVisible()

  await version.click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.mouse.click(3, 3)
  await expect(menu(page)).toBeHidden()
  await expect(dialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('답변, 코드 블록, 복사 단추의 메뉴와 복사', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '답변-메뉴')
  await send(page, '답변 **굵게** 글\n\n```js\nconsole.log(1)\n```')
  const answer = page.locator('.bubble-assistant').filter({ hasText: '답변' }).last()
  await expect(answer.locator('.code-block')).toBeVisible()

  // 코드 블록 메뉴가 바깥 답변 메뉴를 이긴다.
  await answer.locator('.code-block').click({ button: 'right' })
  await expect(item(page, '파일로 저장')).toBeVisible()
  await expect(item(page, '답변 복사')).toBeHidden()
  await item(page, '코드 복사').click()
  await expect(menu(page)).toBeHidden()
  await expect.poll(() => clipboard(page)).toContain('console.log(1)')
  const toast = page.getByText('복사했어요').first()
  await expect(toast).toBeVisible()

  // 답변 본문.
  await answer.locator('strong').click({ button: 'right' })
  await item(page, '보통 글로 복사').click()
  await expect.poll(() => clipboard(page)).not.toContain('**')

  // 복사 단추는 바로 복사하지 않고 메뉴를 연다.
  await page.evaluate(() => navigator.clipboard.writeText('그대로'))
  const copyBtn = page.locator('.response-copy-btn').last()
  await copyBtn.scrollIntoViewIfNeeded()
  await copyBtn.click({ button: 'right' })
  await expect(item(page, '답변 복사')).toBeVisible()
  expect(await clipboard(page)).toBe('그대로')
  await page.keyboard.press('Escape')
})

test('토스트 메뉴는 토스트에 가리지 않고 눌린다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '토스트')
  await send(page, '답변')
  const answer = page.locator('.bubble-assistant').filter({ hasText: '답변' }).last()
  await expect(answer).toBeVisible()
  await answer.click({ button: 'right' })
  await item(page, '답변 복사').click()
  const toast = page.getByText('복사했어요').first()
  await expect(toast).toBeVisible()

  const box = (await toast.boundingBox())!
  await page.mouse.click(box.x + 2, box.y + box.height / 2, { button: 'right' })
  const entry = item(page, '문구 복사')
  await expect(entry).toBeVisible()
  const b = (await entry.boundingBox())!
  const onTop = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-context-menu]'),
    [b.x + b.width / 2, b.y + b.height / 2],
  )
  expect(onTop).toBe(true)
  // 메뉴가 떠 있는 동안 토스트가 사라지지 않는다.
  await page.waitForTimeout(4_000)
  await expect(toast).toBeVisible()
  await entry.click()
  await expect.poll(() => clipboard(page)).toContain('복사했어요')
})

test('글자 선택과 링크 위에서는 브라우저 메뉴를 막지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '기본-메뉴')
  await send(page, '[바깥 링크](https://example.invalid/x) 뒤의 글')
  const answer = page.locator('.bubble-assistant').filter({ hasText: '뒤의 글' }).last()
  await expect(answer.locator('a')).toBeVisible()
  await answer.locator('a').evaluate((a) => a.setAttribute('data-t', 'link'))
  expect(await rightClickPrevented(page, '[data-t="link"]')).toBe(false)
  await expect(menu(page)).toBeHidden()

  // 입력칸.
  expect(await rightClickPrevented(page, 'textarea')).toBe(false)
  await expect(menu(page)).toBeHidden()

  // 답변 글자를 고른 뒤.
  await answer.locator('p').selectText()
  await answer.locator('p').evaluate((p) => p.setAttribute('data-t', 'para'))
  expect(await rightClickPrevented(page, '[data-t="para"]')).toBe(false)
  await expect(menu(page)).toBeHidden()

  // 일반 단추.
  expect(await rightClickPrevented(page, 'aside [data-session-opt="new-work"]')).toBe(false)
  await expect(menu(page)).toBeHidden()
})

test('화살표로 움직이고 메뉴 키로 열면 첫 항목에 초점이 간다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, '키보드')
  await card(page, '키보드').click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('ArrowDown')
  const first = await page.evaluate(() => document.activeElement?.textContent)
  await page.keyboard.press('ArrowDown')
  const second = await page.evaluate(() => document.activeElement?.textContent)
  expect(first).toBeTruthy()
  expect(second).not.toBe(first)
  await page.keyboard.press('Escape')

  await card(page, '키보드').focus()
  await card(page, '키보드').dispatchEvent('contextmenu', { button: 0, clientX: 0, clientY: 0, bubbles: true, cancelable: true })
  await expect(menu(page)).toBeVisible()
  const pos = (await menu(page).boundingBox())!
  const row = (await card(page, '키보드').boundingBox())!
  expect(Math.abs(pos.y - row.y)).toBeLessThan(row.height)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('session-row'))).toBe(true)
})

test('칸 머리는 칸 메뉴를 연다', async ({ page }, info) => {
  desktopOnly(info)
  await page.setViewportSize({ width: 1500, height: 900 })
  await openApp(page)
  await createWork(page, '칸-왼쪽')
  await createWork(page, '칸-오른쪽')
  await card(page, '칸-왼쪽').click({ button: 'right' })
  await item(page, '옆에 열기').click()
  const head = page.locator('[data-pane-menu-btn]').first()
  await expect(head).toBeVisible()
  const box = (await head.boundingBox())!
  await page.mouse.click(box.x - 120, box.y + box.height / 2, { button: 'right' })
  await expect(item(page, '패널 닫기')).toBeVisible()
  await item(page, /세션 바꾸기|다른 세션/).click()
  // 목록만 바뀌고 메뉴는 그대로 있다.
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
})

test('터치 기기에서는 앱 메뉴가 뜨지 않는다', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', '터치 기기에서만')
  await page.goto('/')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.locator('body').dispatchEvent('contextmenu', { bubbles: true, cancelable: true })
  const row = page.locator('.session-row').first()
  if (await row.count()) await row.dispatchEvent('contextmenu', { bubbles: true, cancelable: true })
  await expect(menu(page)).toHaveCount(0)
})
