import { StrictMode, useEffect, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { compact, credits as formatCredits, hasCredits, percent } from '@shared/format'
import type { Settings, Snapshot } from '@shared/types'
import './float.css'

/** 上下文水位圆环：颜色随水位从蓝转琥珀再转红 */
function WaterRing({ ratio }: { ratio: number }): JSX.Element {
  const radius = 13
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, ratio))
  const color = clamped >= 0.9 ? '#d15b4a' : clamped >= 0.7 ? '#ba7517' : '#378add'

  return (
    <svg className="ring" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r={radius} fill="none" stroke="#e6ecf3" strokeWidth="4" />
      <circle
        cx="16"
        cy="16"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform="rotate(-90 16 16)"
      />
    </svg>
  )
}

function Capsule(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [dragging, setDragging] = useState(false)
  const capsuleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const api = window.meter
      if (!api) return
      void api.getSnapshot().then(setSnapshot).catch(() => undefined)
      void api.getSettings().then(setSettings).catch(() => undefined)
      const offSnapshot = api.onSnapshot(setSnapshot)
      const offSettings = api.onSettings(setSettings)
      return () => {
        offSnapshot()
        offSettings()
      }
    } catch (error) {
      console.error('[capsule] 初始化失败', error)
      return
    }
  }, [])

  // 拖动与单击共用一套指针事件：
  // 位移超过阈值算拖动，否则算单击。用 CSS 的 -webkit-app-region: drag
  // 会把 click 整个吃掉，就没法「点击打开面板」了。
  useEffect(() => {
    const el = capsuleRef.current
    if (!el) return

    let pressed = false
    let moved = false
    let lastX = 0
    let lastY = 0

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      pressed = true
      moved = false
      lastX = event.screenX
      lastY = event.screenY
      try {
        el.setPointerCapture(event.pointerId)
      } catch {
        /* 某些环境不支持捕获，退化成普通事件也能用 */
      }
    }

    const onMove = (event: PointerEvent): void => {
      if (!pressed) return
      const dx = event.screenX - lastX
      const dy = event.screenY - lastY
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true
        setDragging(true)
      }
      if (!moved) return
      lastX = event.screenX
      lastY = event.screenY
      window.meter?.moveFloat(dx, dy)
    }

    const onUp = (event: PointerEvent): void => {
      if (!pressed) return
      pressed = false
      try {
        el.releasePointerCapture(event.pointerId)
      } catch {
        /* 忽略 */
      }
      if (moved) {
        moved = false
        setDragging(false)
        return
      }
      window.meter?.openPanel()
    }

    const onContextMenu = (event: MouseEvent): void => {
      // 右键出菜单，和托盘那份完全一致
      event.preventDefault()
      window.meter?.openFloatMenu()
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('contextmenu', onContextMenu)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

  const todayTokens = (snapshot?.today.inputTokens ?? 0) + (snapshot?.today.outputTokens ?? 0)
  const active = snapshot?.active
  const ratio = active && active.size > 0 ? active.used / active.size : 0
  // Kimi Code 没有积分，第二行换成今日调用次数
  const withCredits = hasCredits(snapshot?.kind ?? 'workbuddy')

  const className = [
    'capsule',
    settings?.floatSolidBackground ? 'solid' : '',
    dragging ? 'dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={capsuleRef} className={className} title="拖动移动 · 单击打开面板">
      <WaterRing ratio={ratio} />
      <div className="readout">
        <div className="tokens">
          {compact(todayTokens)}
          <em>token</em>
        </div>
        <div className={`credits${withCredits ? '' : ' plain'}`}>
          {active && active.size > 0 ? `${percent(active.used, active.size)}% · ` : ''}
          {withCredits ? `${formatCredits(snapshot?.today.credits ?? 0)} 分` : `${snapshot?.today.calls ?? 0} 次`}
        </div>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Capsule />
    </StrictMode>
  )
}
