'use client'

import { memo, useContext, useRef, type ReactElement, type ReactNode } from 'react'
import { DemoActivity, DemoStep } from '../hooks/l2-demo-activity'
import { useDemoViewport } from '../hooks/l2-use-demo-viewport'
import { Phone } from './l2-demo-ui'
import styles from './l2-demo-devices.module.css'

export function DesktopWindow({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className={styles.desktop} aria-label="PC 演示">
      <div className={styles.desktopChrome} aria-hidden="true">
        <div className={styles.windowControls}>
          <span />
          <span />
          <span />
        </div>
        <span>Pi Desk</span>
      </div>
      <div className={styles.surface} aria-label="PC 演示内容">
        {children}
      </div>
    </div>
  )
}

const RetainedContent = memo(
  function RetainedContent({
    children
  }: {
    visible: boolean
    step: number
    children: () => ReactNode
  }): ReactElement {
    return <>{children()}</>
  },
  (previous, next) => !previous.visible && !next.visible && previous.step === next.step
)

export function DemoDeviceContent({
  visible,
  children
}: {
  visible: boolean
  children: () => ReactNode
}): ReactElement {
  const active = useContext(DemoActivity) && visible
  const step = useContext(DemoStep)
  return (
    <DemoActivity.Provider value={active}>
      <div
        className={
          active
            ? 'h-full w-full min-w-0'
            : 'h-full w-full min-w-0 [&_*]:[animation-play-state:paused]'
        }
      >
        <RetainedContent visible={visible} step={step}>
          {children}
        </RetainedContent>
      </div>
    </DemoActivity.Provider>
  )
}

export function DemoDevices({
  children
}: {
  children: (mobile: boolean, primaryDevice: boolean) => ReactNode
}): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const width = useDemoViewport(root)
  return (
    <div ref={root} className={styles.frame}>
      <div className={styles.scene}>
        <DesktopWindow>
          <DemoDeviceContent visible={width === null || width >= 640}>
            {() => children(false, true)}
          </DemoDeviceContent>
        </DesktopWindow>
        <div className={styles.mobile} aria-label="手机演示">
          <Phone>
            <div className={styles.surface}>
              <DemoDeviceContent visible={width === null || width < 640 || width >= 960}>
                {() => children(true, width === null || width < 640)}
              </DemoDeviceContent>
            </div>
          </Phone>
        </div>
      </div>
    </div>
  )
}
