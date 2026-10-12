import type { ReactElement } from 'react'
import styles from './l2-usage-guide-figures.module.css'

export function UsageGuideChart({
  values,
  labels,
  unit
}: {
  values: readonly number[]
  labels: readonly string[]
  unit: string
}): ReactElement {
  const maximum = Math.ceil(Math.max(...values) / 10) * 10
  const points = values.map((value, index) => ({
    x: 8 + (index * 464) / (values.length - 1),
    y: 122 - (value / maximum) * 110
  }))
  const line = points.map(({ x, y }) => `${x},${y}`).join(' ')
  return (
    <div className={styles.chart}>
      <div className={styles.chartScale}>
        <span>{unit}</span>
        <span>0–{maximum}</span>
      </div>
      <svg
        className={styles.chartSvg}
        viewBox="0 0 480 130"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${unit}示例趋势：${values.join('、')}`}
      >
        {[12, 67, 122].map((y) => (
          <line key={y} className={styles.chartGrid} x1="0" y1={y} x2="480" y2={y} />
        ))}
        <polygon className={styles.chartArea} points={`8,122 ${line} 472,122`} />
        <polyline className={styles.chartLine} points={line} />
        {points.map(({ x, y }, index) => (
          <circle key={index} className={styles.chartPoint} cx={x} cy={y} r="3" />
        ))}
      </svg>
      <div className={styles.chartLabels}>
        {labels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  )
}
