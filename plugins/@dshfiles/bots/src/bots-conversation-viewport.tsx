import { Button } from '@dshfiles/plugin-ui/components/ui/button'
import { ArrowDownIcon } from '@dshfiles/plugin-ui/icons'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const nearBottom = (element: HTMLElement): boolean => element.scrollHeight - element.clientHeight - element.scrollTop <= 64
const scrollToBottom = (element: HTMLElement): void => {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
}

/** DOM-only ownership: Query keeps the transcript; these refs only track the reader's viewport intent. */
export const BotsConversationViewport = (props: {
  readonly children: ReactNode
  readonly contentVersion: string
  readonly followLatest: boolean
}): JSX.Element => {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(props.followLatest)
  const [updatesBelow, setUpdatesBelow] = useState(false)

  useLayoutEffect(() => {
    const element = viewport.current
    if (element === null || !props.followLatest) return
    if (following.current) {
      scrollToBottom(element)
      setUpdatesBelow(false)
    } else if (!nearBottom(element)) setUpdatesBelow(true)
  }, [props.contentVersion, props.followLatest])

  useLayoutEffect(() => {
    const element = viewport.current
    const body = content.current
    if (element === null || body === null || !props.followLatest) return
    const observer = new ResizeObserver(() => {
      // Width changes, composer resizing and text wrapping do not take a reader away from older messages.
      if (following.current) scrollToBottom(element)
    })
    observer.observe(element)
    observer.observe(body)
    return () => observer.disconnect()
  }, [props.followLatest])

  const jumpToLatest = (): void => {
    const element = viewport.current
    if (element === null) return
    following.current = true
    scrollToBottom(element)
    setUpdatesBelow(false)
  }

  return (
    <div className="dshx:relative dshx:min-h-0 dshx:flex-1">
      <div
        aria-label="Bot conversation"
        className="dshx:h-full dshx:min-h-0 dshx:overflow-y-auto dshx:overscroll-contain"
        onScroll={event => {
          following.current = nearBottom(event.currentTarget)
          if (following.current) setUpdatesBelow(false)
        }}
        ref={viewport}
        role="region"
        tabIndex={0}
      >
        <div className="dshx:px-5 dshx:py-6 dshx:@max-pane-narrow:px-3" ref={content}>
          {props.children}
        </div>
      </div>
      {props.followLatest && updatesBelow && (
        <div className="dshx:pointer-events-none dshx:absolute dshx:inset-x-0 dshx:bottom-3 dshx:flex dshx:justify-center">
          <Button
            className="dshx:pointer-events-auto dshx:shadow-md"
            onClick={jumpToLatest}
            size="sm"
            title="New messages are below your reading position"
            variant="secondary"
          >
            <ArrowDownIcon aria-hidden />
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  )
}
