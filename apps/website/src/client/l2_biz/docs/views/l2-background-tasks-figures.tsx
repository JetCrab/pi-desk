import { ArrowRight, MessageSquare, Terminal, FileText, ListTodo } from 'lucide-react'
import type { ReactElement } from 'react'
import styles from './l2-background-tasks-figures.module.css'

export function BackgroundTasksEffect(): ReactElement {
  return (
    <figure className={styles.effect} aria-label="后台任务作用示意">
      <div className={styles.figureTitle}>
        一次启动，两条工作线
        <span>以预览服务与整理说明为例 · 示意</span>
      </div>
      <div className={styles.lane}>
        <div className={styles.laneLabel}>
          <MessageSquare size={18} aria-hidden="true" />
          <strong>前台对话</strong>
        </div>
        <div className={styles.sequence}>
          <span>交代任务</span>
          <ArrowRight size={16} aria-hidden="true" />
          <span>启动后台命令</span>
          <ArrowRight size={16} aria-hidden="true" />
          <strong>继续整理说明</strong>
        </div>
      </div>
      <div className={styles.lane}>
        <div className={styles.laneLabel}>
          <Terminal size={18} aria-hidden="true" />
          <strong>后台命令</strong>
        </div>
        <div className={styles.sequence}>
          <span>启动预览服务</span>
          <ArrowRight size={16} aria-hidden="true" />
          <strong>保持运行</strong>
          <ArrowRight size={16} aria-hidden="true" />
          <span>用完后停止</span>
        </div>
      </div>
      <figcaption className={styles.note}>
        命令继续执行，前台不必等待；下一步依赖结果时，仍应等待结果。
      </figcaption>
    </figure>
  )
}

export function BackgroundTasksPrinciple(): ReactElement {
  return (
    <figure className={styles.principle} aria-label="后台任务运行原理示意">
      <div className={styles.flow}>
        <div>
          <Terminal size={20} aria-hidden="true" />
          <strong>命令</strong>
          <span>bg_run 立即返回</span>
        </div>
        <ArrowRight className={styles.flowArrow} size={18} aria-hidden="true" />
        <div>
          <span className={styles.processIcon} aria-hidden="true">
            ▶
          </span>
          <strong>运行进程</strong>
          <span>在当前项目中执行</span>
        </div>
        <ArrowRight className={styles.flowArrow} size={18} aria-hidden="true" />
        <div>
          <span className={styles.outputs} aria-hidden="true">
            <FileText size={18} />
            <ListTodo size={18} />
          </span>
          <strong>日志 / 状态</strong>
          <span>在任务中心查看</span>
        </div>
      </div>
      <figcaption className={styles.note}>前台继续独立工作，不必持续查询运行状态。</figcaption>
    </figure>
  )
}

export function BackgroundTasksConfig(): ReactElement {
  return (
    <figure className={styles.config} aria-label="后台任务配置示意">
      <div className={styles.figureTitle}>
        bg_run 的启动参数
        <span>每次调用指定 · 以下均为示例</span>
      </div>
      <dl className={styles.parameters}>
        <div>
          <dt>
            任务名 <code>name</code>
          </dt>
          <dd>
            <strong>预览服务</strong>
            <span>在任务中心辨认任务</span>
          </dd>
        </div>
        <div>
          <dt>
            命令 <code>command</code>
          </dt>
          <dd>
            <code>pnpm run preview</code>
            <span>在当前项目目录执行</span>
          </dd>
        </div>
        <div>
          <dt>
            可选超时 <code>timeoutSeconds</code>
          </dt>
          <dd>
            <strong>1800 秒</strong>
            <span>本例最多运行 30 分钟</span>
          </dd>
        </div>
      </dl>
      <figcaption className={styles.note}>
        不需要打开设置页；让助手在启动时明确这三个参数。
      </figcaption>
    </figure>
  )
}
