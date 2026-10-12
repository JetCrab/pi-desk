import { ArrowDown, ArrowRight, Bot, Check, ChevronDown, MessageSquare } from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-subagents-figures.module.css'

export function SubagentsEffect(): ReactElement {
  return (
    <figure className={styles.effect} aria-label="子代理作用示意">
      <div className={styles.title}>
        主代理把独立子任务交出去<span>轻舟项目 · 示意</span>
      </div>
      <div className={styles.delegation}>
        <div className={styles.owner}>
          <MessageSquare size={22} aria-hidden="true" />
          <strong>主代理</strong>
          <span>派发调查，继续整理清单</span>
        </div>
        <ArrowRight className={styles.outward} size={20} aria-hidden="true" />
        <div className={styles.child}>
          <Bot size={22} aria-hidden="true" />
          <strong>explore 子代理</strong>
          <span>只读调查 CSV 导出入口</span>
        </div>
        <div className={styles.returning}>
          <ArrowDown size={18} aria-hidden="true" />
          <span>关键文件与结论回来</span>
        </div>
        <div className={styles.conclusion}>
          <Check size={18} aria-hidden="true" />
          <strong>主代理复核、继续</strong>
          <span>不必把全部调查过程重新做一遍</span>
        </div>
      </div>
      <figcaption className={styles.note}>独立范围分别执行，最终判断仍由主代理负责。</figcaption>
    </figure>
  )
}

export function SubagentsPrinciple(): ReactElement {
  return (
    <figure className={styles.principle} aria-label="子代理运行原理示意">
      <div>
        <strong>自包含任务说明</strong>
        <span>目标 · 范围 · 返回要求</span>
      </div>
      <ArrowRight size={18} aria-hidden="true" />
      <div>
        <strong>独立子会话</strong>
        <span>自己的对话与工具过程</span>
      </div>
      <ArrowRight size={18} aria-hidden="true" />
      <div>
        <strong>结果通知</strong>
        <span>回主会话，唤醒主代理</span>
      </div>
    </figure>
  )
}

export function SubagentsConfig(): ReactElement {
  return (
    <figure className={styles.config} aria-label="子代理配置示意">
      <div className={styles.settingsHeader}>
        <div>
          <strong>子代理</strong>
          <span>全局默认配置，项目设置优先。</span>
        </div>
        <span className={styles.save}>保存设置</span>
      </div>
      <div className={styles.columns} aria-hidden="true">
        <span>子代理</span>
        <span>模型</span>
        <span>思考等级</span>
      </div>
      {['dev', 'explore', 'research'].map((name) => (
        <div className={styles.settingRow} key={name}>
          <div className={styles.enabled}>
            <span aria-hidden="true">
              <Check size={12} />
            </span>
            <strong>{name}</strong>
            <small>已启用</small>
          </div>
          <div className={styles.field}>
            <span>模型</span>
            <div>
              {name === 'explore' ? '示例服务 / 探索模型' : '角色默认模型'}
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
          <div className={styles.field} data-disabled={name !== 'explore'}>
            <span>思考等级</span>
            <div>
              {name === 'explore' ? '中' : '角色默认'}
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
        </div>
      ))}
      <figcaption className={styles.note}>
        配置示意：explore 选定示例模型后可调整思考等级。保存后下次启动或恢复生效。
      </figcaption>
    </figure>
  )
}
