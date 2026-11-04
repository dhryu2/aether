// 나뉜 칸 화면. 칸은 넘치는 것을 잘라 내고 가장 낮을 때 306px이라, 떠 있는 것이 잘리기 쉽다. 데스크톱만.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

// 4분할이 되는 가장 작은 창. 칸 하나가 420×306이다.
const SMALLEST = { width: 1146, height: 620 }

function desktopOnly(info: TestInfo) {
  test.skip(info.project.name !== 'desktop', '칸 나누기는 넓은 화면에만 있다')
}

async function openApp(page: Page) {
  await page.goto('/')
  await expect
    .poll(async () => (await page.getByLabel('세션 불러오는 중').count()) + (await page.getByLabel('재연결 중').count()))
    .toBe(0)
}

async function createWork(page: Page, name: string) {
  await page.locator('aside [data-session-opt="new-work"]').click()
  const modal = page.locator('[data-modal="new-session"]')
  await modal.getByLabel('이름').fill(name)
  await expect(modal.locator('[data-folder-browse]')).toBeEnabled()
  await modal.locator('[data-folder-browse]').click()
  await modal.locator('[data-folder-choose]').waitFor()
  // 시험 순서에 따라 이미 notes 안에서 열릴 수 있다.
  const notes = modal.locator('[data-folder-entry="notes"]')
  if (await notes.isVisible().catch(() => false)) await notes.click()
  await modal.locator('[data-folder-choose]').click()
  await modal.locator('[data-provider-id="e2e"]').click()
  await modal.getByRole('button', { name: '세션 시작' }).click()
  await expect(modal).toBeHidden()
}

/** 세션 넷을 만들어 2×2로 놓는다. 마지막 칸(오른쪽 아래)에 포커스. 답이 있어야 넘기기가 열린다. */
async function openFourPanes(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openApp(page)
  const tag = Date.now().toString(36)
  for (const n of [1, 2, 3, 4]) {
    await createWork(page, `split-${tag}-${n}`)
    await page.getByPlaceholder(/메시지를 입력/).fill(`안녕 ${n}`)
    await page.getByRole('button', { name: '전송', exact: true }).click()
    await expect(page.locator('.bubble-assistant').last()).toBeVisible()
  }
  const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('aside [data-session-id]')].map((e) => e.getAttribute('data-session-id')))])
  const panes = ids.slice(0, 4).reverse()
  await page.evaluate((v) => localStorage.setItem('aether.panes.v1', JSON.stringify({ ids: v, focusedId: v[3] })), panes)
  await page.setViewportSize(SMALLEST)
  await openApp(page)
  await expect(page.locator('[data-split-pane]')).toHaveCount(4)
}

/** 요소가 칸 안에 들어오는가. 등장 움직임이 끝난 크기로 잰다. */
async function expectInside(el: Locator, host: Locator) {
  await expect
    .poll(async () => {
      const [a, b] = [await el.boundingBox(), await host.boundingBox()]
      if (!a || !b) return 'no box'
      const out = a.x < b.x - 1 || a.y < b.y - 1 || a.x + a.width > b.x + b.width + 1 || a.y + a.height > b.y + b.height + 1
      return out ? `밖으로 나감 ${JSON.stringify(a)} / ${JSON.stringify(b)}` : 'ok'
    })
    .toBe('ok')
}

test('칸이 나뉘면 상단바가 없고, 윗줄과 아랫줄의 읽는 자리가 같다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  await expect(page.locator('.top-bar')).toHaveCount(0)
  const heads = await page.locator('[data-split-pane] .stream-scroll').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  expect(new Set(heads).size).toBe(1)
})

test('칸 메뉴와 칩 목록이 어느 칸에서도 잘리지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  for (const i of [0, 3]) {
    const pane = page.locator(`[data-split-pane="${i}"]`)
    await pane.locator('[data-pane-menu-btn]').click()
    await expectInside(pane.locator('.popover-surface').first(), pane)
    // 낮은 칸에서는 메뉴가 스크롤된다. 맨 아래 항목에 닿아야 한다.
    await pane.getByRole('menuitem', { name: '닫기' }).scrollIntoViewIfNeeded()
    await expect(pane.getByRole('menuitem', { name: '닫기' })).toBeVisible()
    await page.keyboard.press('Escape')
    const chips = pane.locator('.composer-box .chip-ghost')
    await expect(chips.last()).toBeVisible()
    for (let c = 0; c < (await chips.count()); c++) {
      await chips.nth(c).click()
      await expectInside(pane.locator('.composer-box .popover-surface').first(), pane)
      await page.keyboard.press('Escape')
      await expect(pane.locator('.composer-box .popover-surface:not(.popover-ghost)')).toHaveCount(0)
    }
  }
})

test('넘기기 창이 아래 칸에서도 화면 안에 다 보인다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  for (const i of [0, 3]) {
    await page.locator(`[data-split-pane="${i}"] [data-pane-menu-btn]`).click()
    await page.locator(`[data-split-pane="${i}"] [data-session-opt="handoff"]`).click()
    const card = page.locator('[data-modal="handoff"]')
    await expect(card).toBeVisible()
    await expectInside(card, page.locator('.modal-scrim'))
    await expect(card.getByRole('button', { name: '넘기기', exact: true })).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(card).toBeHidden()
  }
})

test('넘기기는 답변이 아니라 사용량 표시에 있고 사용률과 상관없이 모습이 같다', async ({ page }, info) => {
  desktopOnly(info)
  await openApp(page)
  await createWork(page, `usage-${Date.now().toString(36)}`)
  const composer = page.getByPlaceholder(/메시지를 입력/)
  const usage = page.locator('.top-bar [data-usage-menu-btn]')
  await composer.fill('낮음')
  await page.getByRole('button', { name: '전송', exact: true }).click()
  await expect(page.locator('.bubble-assistant').last()).toBeVisible()
  await expect(page.locator('.bubble-assistant').getByRole('button', { name: /넘기기/ })).toHaveCount(0)
  await expect(usage).toHaveAccessibleName(/컨텍스트 사용률 1%, .*넘기기/)
  await expect(usage.locator('svg')).toBeVisible()

  await composer.fill('CTX:높음')
  await page.getByRole('button', { name: '전송', exact: true }).click()
  await expect(usage).toHaveAccessibleName(/컨텍스트 사용률 80%/)
  await expect(usage.locator('svg')).toBeVisible()
  await expect(page.locator('.top-bar').getByRole('button', { name: '넘기기', exact: true })).toHaveCount(0)

  await usage.click()
  const item = page.locator('[data-usage-menu-btn] ~ .popover-surface [data-session-opt="handoff"]')
  await expect(item).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(item).toBeHidden()
  await expect(usage).toBeFocused()

  await usage.click()
  await item.click()
  const card = page.locator('[data-modal="handoff"]')
  await expect(card).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()

  await page.setViewportSize({ width: 375, height: 800 })
  await expect(usage).toBeInViewport({ ratio: 1 })
})

test('좁은 칸에서도 사용량 메뉴가 잘리지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  const pane = page.locator('[data-split-pane="3"]')
  await pane.getByPlaceholder(/메시지를 입력/).fill('CTX:높음')
  await pane.getByRole('button', { name: '전송', exact: true }).click()
  const usage = pane.locator('[data-usage-menu-btn]')
  await expect(usage).toHaveAccessibleName(/컨텍스트 사용률 80%/)
  await pane.locator('.composer-box textarea').first().fill('글')
  await expectInside(pane.getByRole('button', { name: '전송', exact: true }), pane)
  await pane.locator('.composer-box textarea').first().fill('')
  await usage.click()
  await expectInside(pane.locator('[data-usage-menu-btn] ~ .popover-surface'), pane)
})

test('좁은 칸의 입력창은 글을 지워도 높아지지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  const pane = page.locator('[data-split-pane="0"]')
  const box = pane.locator('.composer-box')
  const before = (await box.boundingBox())?.height
  const area = pane.locator('.composer-box textarea').first()
  await area.fill('글자')
  await area.fill('')
  await expect.poll(async () => (await box.boundingBox())?.height).toBe(before)
})

test('긴 글을 써도 낮은 칸의 대화가 남는다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  const pane = page.locator('[data-split-pane="3"]')
  await pane.locator('.composer-box textarea').first().fill(Array.from({ length: 14 }, (_, i) => `줄 ${i}`).join('\n'))
  const left = await pane.evaluate((p) => p.querySelector('.aether-composer')!.getBoundingClientRect().top - p.querySelector('.stream-scroll')!.getBoundingClientRect().top)
  expect(left).toBeGreaterThanOrEqual(100)
})

test('키보드로 옮겨도 포커스 칸이 따라오고 찾기 막대는 그 칸에 뜬다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  const pane = page.locator('[data-split-pane="1"]')
  await pane.locator('[data-pane-menu-btn]').focus()
  await expect(pane).toHaveAttribute('data-split-focused', '1')
  await page.keyboard.press('Enter')
  await pane.getByRole('menuitem', { name: '이 세션에서 찾기' }).click()
  await expectInside(pane.locator('.find-bar'), pane)
  await page.keyboard.press('Escape')
})

test('확대하면 그 칸만 보이고 칸 메뉴가 잘리지 않는다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  const pane = page.locator('[data-split-pane="3"]')
  await pane.locator('[data-split-zoom]').click()
  await expect(page.locator('[data-split-pane]:visible')).toHaveCount(1)
  await pane.locator('[data-pane-menu-btn]').click()
  await expectInside(pane.locator('.popover-surface').first(), pane)
  await page.keyboard.press('Escape')
  await pane.locator('[data-split-zoom]').click()
  await expect(page.locator('[data-split-pane]:visible')).toHaveCount(4)
})

test('창이 낮아져 숨은 칸은 포커스 칸 머리에서 불러온다', async ({ page }, info) => {
  desktopOnly(info)
  await openFourPanes(page)
  // 세로 2줄이 안 들어가는 높이 — 칸 둘만 보이고 둘은 숨는다.
  await page.setViewportSize({ width: 1146, height: 500 })
  await expect(page.locator('[data-split-pane]:visible')).toHaveCount(2)
  await expect(page.locator('.top-bar')).toHaveCount(0)
  const chip = page.locator('[data-split-focused="1"] [data-hidden-panes]')
  await expect(chip).toBeVisible()
  const before = await page.locator('[data-split-focused="1"]').getAttribute('data-split-session')
  await chip.click()
  await expect.poll(() => page.locator('[data-split-focused="1"]').getAttribute('data-split-session')).not.toBe(before)
})
