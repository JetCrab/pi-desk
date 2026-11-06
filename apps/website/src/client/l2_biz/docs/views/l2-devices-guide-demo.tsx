'use client'

import { Check, Globe, Monitor, RotateCcw, Settings, ShieldCheck, Smartphone } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import styles from './l2-devices-guide.module.css'

const steps = ['设置密码', '配置连接', '共享端口', '手机访问']
const examplePassword = 'Demo-Access-2026!'

export function DevicesGuideDemo(): ReactElement {
  const [step, setStep] = useState(0)
  const [password, setPassword] = useState(examplePassword)
  const [protectedAccess, setProtectedAccess] = useState(false)
  const [server, setServer] = useState('http://tunnel.example.invalid:7001')
  const [serverHost, setServerHost] = useState('tunnel.example.invalid')
  const [controlKey, setControlKey] = useState('a'.repeat(64))
  const [configured, setConfigured] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [localPort, setLocalPort] = useState('30333')
  const [publicEnabled, setPublicEnabled] = useState(false)
  const [publicPort, setPublicPort] = useState('40333')
  const [shared, setShared] = useState(false)
  const publicShared = shared && publicEnabled
  const [phonePassword, setPhonePassword] = useState(examplePassword)
  const [signedIn, setSignedIn] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [notice, setNotice] = useState('先在工作台启用登录保护，再到桌面控制中心配置远程访问。')
  const publicUrl = `http://${serverHost}:${publicPort}/`
  const completed = [protectedAccess, configured, shared, signedIn]

  function reset(): void {
    setStep(0)
    setPassword(examplePassword)
    setProtectedAccess(false)
    setServer('http://tunnel.example.invalid:7001')
    setServerHost('tunnel.example.invalid')
    setControlKey('a'.repeat(64))
    setConfigured(false)
    setSettingsOpen(false)
    setEditorOpen(false)
    setLocalPort('30333')
    setPublicEnabled(false)
    setPublicPort('40333')
    setShared(false)
    setPhonePassword(examplePassword)
    setSignedIn(false)
    setLoginError('')
    setNotice('先在工作台启用登录保护，再到桌面控制中心配置远程访问。')
  }

  return (
    <figure className={styles.demo} aria-label="远程访问可操作教学示意">
      <div className={styles.demoHeading}>
        <strong>
          从电脑共享到手机访问 <span>· 操作示意</span>
        </strong>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={reset}
          aria-label="重置远程访问演示"
        >
          <RotateCcw aria-hidden="true" />
          重置
        </Button>
      </div>
      <p className={styles.disclaimer}>
        可点击练习；仅使用示例值，不输入真实密码或密钥。不会保存设置、启动服务或连接网络。
      </p>
      <div className={styles.steps} role="group" aria-label="教学步骤">
        {steps.map((title, index) => (
          <button
            key={title}
            type="button"
            aria-current={step === index ? 'step' : undefined}
            onClick={() => setStep(index)}
          >
            <span>{completed[index] ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
            {title}
          </button>
        ))}
      </div>
      <div className={styles.window}>
        <div className={styles.windowBar}>
          {step === 0 ? (
            <ShieldCheck size={16} aria-hidden="true" />
          ) : step === 3 ? (
            <Smartphone size={16} aria-hidden="true" />
          ) : (
            <Monitor size={16} aria-hidden="true" />
          )}
          <span>
            {step === 0
              ? '工作台 / 设置 / 登录保护'
              : step === 3
                ? '手机浏览器'
                : '桌面控制中心 / 远程访问'}
          </span>
        </div>
        <div className={styles.panel}>
          {step === 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const categories = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
                  pattern.test(password)
                ).length
                if (
                  categories < 3 ||
                  password.trim() !== password ||
                  /[\r\n\p{Cc}\p{Cf}]/u.test(password)
                ) {
                  setNotice('示例密码需要满足下方规则，也可点击「生成密码」使用示例值。')
                  return
                }
                setProtectedAccess(true)
                setPhonePassword(password)
                setSignedIn(false)
                setNotice(
                  '登录保护已启用（示意）。实际保存后，所有设备都需要重新登录。下一步配置桌面连接。'
                )
                setStep(1)
              }}
            >
              <h3>登录保护</h3>
              <div className={styles.status}>
                <ShieldCheck size={18} aria-hidden="true" />
                <span>{protectedAccess ? '已启用' : '未启用'}</span>
              </div>
              <div className={styles.labelRow}>
                <label htmlFor="devices-demo-password">密码</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPassword(examplePassword)}
                >
                  生成密码
                </Button>
              </div>
              <input
                id="devices-demo-password"
                type="password"
                autoComplete="off"
                required
                minLength={12}
                maxLength={64}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby="devices-demo-password-hint"
              />
              <p id="devices-demo-password-hint" className={styles.hint}>
                12–64 个字符，大写、小写、数字、符号至少三类；不能有首尾空白、换行或不可见控制字符。
              </p>
              <Button type="submit">{protectedAccess ? '保存并重新登录' : '启用登录保护'}</Button>
            </form>
          )}
          {step === 1 && !settingsOpen && (
            <>
              <div className={styles.titleRow}>
                <h3>远程访问</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings aria-hidden="true" />
                  设置
                </Button>
              </div>
              <p className={styles.hint}>
                {configured
                  ? '服务器已配置，可进入本机共享。'
                  : '服务器未配置。先打开「设置」，保存控制服务地址和密钥。'}
              </p>
              {configured && (
                <Button type="button" className="mt-4" onClick={() => setStep(2)}>
                  前往本机共享
                </Button>
              )}
            </>
          )}
          {step === 1 && settingsOpen && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setServerHost(new URL(server).hostname)
                setConfigured(true)
                setSettingsOpen(false)
                setNotice(
                  '服务器设置已保存（示意）。实际隧道启动后修改地址或密钥，需退出并重启桌面应用。'
                )
                setStep(2)
              }}
            >
              <h3>服务器设置</h3>
              <label htmlFor="devices-demo-server">服务器地址</label>
              <input
                id="devices-demo-server"
                type="url"
                required
                pattern="http://.+"
                autoComplete="off"
                value={server}
                onChange={(event) => setServer(event.target.value)}
              />
              <label htmlFor="devices-demo-key">控制密钥</label>
              <input
                id="devices-demo-key"
                type="password"
                required
                pattern="[a-fA-F0-9]{64}"
                autoComplete="off"
                value={controlKey}
                onChange={(event) => setControlKey(event.target.value)}
              />
              <p className={styles.hint}>
                填写部署者提供的控制地址和 64 位十六进制密钥，不是手机访问地址或登录密码。
              </p>
              <Button type="submit">保存设置</Button>
            </form>
          )}
          {step === 2 && (
            <>
              <div className={styles.titleRow}>
                <h3>本机共享</h3>
                <Button
                  type="button"
                  size="sm"
                  disabled={!configured || !protectedAccess || shared}
                  onClick={() => setEditorOpen(true)}
                >
                  共享端口
                </Button>
              </div>
              {!shared && !editorOpen ? (
                <div className={styles.empty}>
                  <Monitor size={24} aria-hidden="true" />
                  <p>还没有共享端口</p>
                  <span className={styles.hint}>
                    {!configured || !protectedAccess
                      ? '先完成设置密码和配置连接，再练习共享端口。'
                      : '点击「共享端口」，添加 Pi Desk 的本机端口。'}
                  </span>
                </div>
              ) : null}
              {shared ? (
                <div className={styles.shared}>
                  <strong>本机端口 {localPort}</strong>
                  <span>
                    <Check size={16} aria-hidden="true" />
                    共享中 · {publicShared ? `公网端口 ${publicPort}` : '仅客户端访问'}
                  </span>
                  {publicShared ? (
                    <code>{publicUrl}</code>
                  ) : (
                    <p className={styles.hint}>
                      未开启公网访问，手机浏览器没有可用的公网地址。可重新练习并开启公网访问。
                    </p>
                  )}
                  {publicShared && (
                    <Button
                      type="button"
                      onClick={() => {
                        setNotice(
                          '模拟复制：公网地址已带入手机演示，未写入剪贴板。实际使用时在手机打开复制的公网链接或地址。'
                        )
                        setStep(3)
                      }}
                    >
                      <Globe aria-hidden="true" />
                      复制公网地址
                    </Button>
                  )}
                </div>
              ) : editorOpen ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    setShared(true)
                    setEditorOpen(false)
                    setNotice(
                      publicEnabled
                        ? '共享中（示意）。实际需要等待共享就绪，再复制公网地址到手机。'
                        : '仅客户端访问（示意）。未开启公网访问，不生成公网地址。'
                    )
                  }}
                >
                  <h3>添加本机共享</h3>
                  {!configured || !protectedAccess ? (
                    <p className={styles.hint}>先完成设置密码和配置连接，再练习共享端口。</p>
                  ) : null}
                  <label htmlFor="devices-demo-local">本机端口</label>
                  <input
                    id="devices-demo-local"
                    type="number"
                    required
                    min={1}
                    max={65535}
                    value={localPort}
                    onChange={(event) => setLocalPort(event.target.value)}
                  />
                  <label className={styles.toggle} htmlFor="devices-demo-public">
                    开启公网访问
                    <input
                      id="devices-demo-public"
                      type="checkbox"
                      role="switch"
                      checked={publicEnabled}
                      onChange={(event) => setPublicEnabled(event.target.checked)}
                    />
                  </label>
                  {publicEnabled && (
                    <>
                      <label htmlFor="devices-demo-public-port">公网端口</label>
                      <input
                        id="devices-demo-public-port"
                        type="number"
                        required
                        min={1}
                        max={65535}
                        value={publicPort}
                        onChange={(event) => setPublicPort(event.target.value)}
                      />
                      <p className={styles.hint}>
                        使用服务器上可用且已放行的端口；手机无需安装隧道客户端。
                      </p>
                    </>
                  )}
                  <Button type="submit" disabled={!configured || !protectedAccess}>
                    开始共享
                  </Button>
                </form>
              ) : null}
            </>
          )}
          {step === 3 && (
            <div className={styles.phone}>
              <div className={styles.address}>
                <Globe size={14} aria-hidden="true" />
                <span>{publicShared ? publicUrl : '等待开启公网共享'}</span>
              </div>
              {!publicShared ? (
                <div className={styles.empty}>
                  <Smartphone size={24} aria-hidden="true" />
                  <p>先在本机共享中开启公网访问，获得手机可用的地址。</p>
                  <Button type="button" variant="outline" onClick={() => setStep(2)}>
                    前往本机共享
                  </Button>
                </div>
              ) : signedIn ? (
                <div className={styles.empty}>
                  <ShieldCheck size={28} aria-hidden="true" />
                  <h3>已进入工作台</h3>
                  <p>手机可继续查看消息和执行任务，项目仍在电脑上运行。</p>
                  <span className={styles.hint}>登录结果为教学示意，未连接真实 Pi Desk。</span>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (phonePassword !== password) {
                      setLoginError('密码不一致，请填写第 1 步设置的示例密码。')
                      return
                    }
                    setLoginError('')
                    setSignedIn(true)
                    setNotice(
                      '演示已完成。实际访问后发送一条消息，确认回复能实时出现，才算连接成功。'
                    )
                  }}
                >
                  <h3>登录 Pi Desk</h3>
                  <label htmlFor="devices-demo-phone-password">密码</label>
                  <input
                    id="devices-demo-phone-password"
                    type="password"
                    required
                    autoComplete="off"
                    value={phonePassword}
                    onChange={(event) => setPhonePassword(event.target.value)}
                  />
                  {loginError && (
                    <p className={styles.error} role="alert">
                      {loginError}
                    </p>
                  )}
                  <Button type="submit">登录</Button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
      <figcaption className={styles.notice} role="status">
        {notice}
      </figcaption>
    </figure>
  )
}
