// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotsConversationViewport } from './bots-conversation-viewport.js'

let height = 1000
let viewportHeight = 200
let resized = (): void => {}

beforeEach(() => {
  height = 1000
  viewportHeight = 200
  // JSDOM has no layout. Supply geometry, not viewport/scroll behavior, to the real rendered component.
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('aria-label') === 'Bot conversation' ? height : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('aria-label') === 'Bot conversation' ? viewportHeight : 0
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const viewport = (): HTMLElement => screen.getByRole('region', { name: 'Bot conversation' })
const renderViewport = (version: string, followLatest = true) => (
  <BotsConversationViewport contentVersion={version} followLatest={followLatest}>
    <p>Cached conversation {version}</p>
  </BotsConversationViewport>
)

describe('Bots conversation viewport', () => {
  it('starts at the latest message and follows updates when the reader is near the bottom', () => {
    const view = render(renderViewport('one'))
    expect(viewport().scrollTop).toBe(800)
    viewport().scrollTop = 750
    fireEvent.scroll(viewport())
    height = 1200
    view.rerender(renderViewport('two'))
    expect(viewport().scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('preserves a reader scrolled up and offers an explicit jump when new messages arrive', () => {
    const view = render(renderViewport('one'))
    viewport().scrollTop = 180
    fireEvent.scroll(viewport())
    height = 1200
    view.rerender(renderViewport('two'))
    expect(viewport().scrollTop).toBe(180)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(viewport().scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    height = 1400
    view.rerender(renderViewport('three'))
    expect(viewport().scrollTop).toBe(1200)
  })

  it('does not move a reading position or announce new messages for unrelated rerenders', () => {
    const view = render(renderViewport('one'))
    viewport().scrollTop = 180
    fireEvent.scroll(viewport())
    view.rerender(renderViewport('one'))
    expect(viewport().scrollTop).toBe(180)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    viewportHeight = 150
    act(() => resized())
    expect(viewport().scrollTop).toBe(180)
  })

  it('keeps the latest message in view across pane and composer resizing', () => {
    render(renderViewport('one'))
    viewportHeight = 150
    act(() => resized())
    expect(viewport().scrollTop).toBe(850)
    height = 1300
    act(() => resized())
    expect(viewport().scrollTop).toBe(1150)
  })

  it('leaves an explicitly selected older page at its reading position', () => {
    const view = render(renderViewport('older-one', false))
    expect(viewport().scrollTop).toBe(0)
    viewport().scrollTop = 100
    fireEvent.scroll(viewport())
    height = 1200
    view.rerender(renderViewport('older-two', false))
    expect(viewport().scrollTop).toBe(100)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })
})
