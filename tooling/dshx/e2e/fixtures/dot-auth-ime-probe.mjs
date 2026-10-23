// Synthetic browser-only protocol calibration; no DSH, remote page, provider or real input.
import { chromium } from '@playwright/test'
const browser = await chromium.launch({ executablePath: process.env.DSHX_E2E_CHROMIUM_EXECUTABLE })
try {
  const page = await browser.newPage()
  await page.setContent('<textarea aria-label="Synthetic IME"></textarea>')
  await page.getByRole('textbox').focus()
  await page.getByRole('textbox').evaluate(element => {
    for (const name of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'])
      element.addEventListener(name, event => {
        const label = `${name}:${event.isTrusted}:${event instanceof InputEvent ? event.inputType : ''}:${event instanceof InputEvent || event instanceof CompositionEvent ? (event.data?.length ?? 0) : 0}`
        element.dataset.events = `${element.dataset.events ?? ''}|${label}`
      })
  })
  const session = await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 })
  await session.send('Input.insertText', { text: '漢' })
  console.log(JSON.stringify({ phase: 'insertText', events: await page.getByRole('textbox').getAttribute('data-events') }))
  await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  console.log(JSON.stringify({ phase: 'clearComposition', events: await page.getByRole('textbox').getAttribute('data-events') }))
} finally {
  await browser.close()
}
