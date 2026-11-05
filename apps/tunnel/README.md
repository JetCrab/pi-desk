# Pi Desk Tunnel

共享 iroh TCP 数据通道，供桌面端、无头提供端 CLI 和公网网关使用。普通浏览器或 TCP 程序仍可直接访问公网 `host:port`，无需安装隧道客户端。

```text
公网程序 → 公网 TCP 网关 ── iroh ──→ 提供端 → 本机 TCP 服务
本机程序 → 127.0.0.1:固定端口 ── iroh ──→ 提供端 → 本机 TCP 服务
                              直连或经独立 relay
```

## 桌面接入

在桌面控制中心进入“远程访问”：

1. 首次在“设置”保存控制服务的 `http://` 地址和 64 位十六进制控制密钥。
2. 在“本机共享”添加本机端口；需要免客户端访问时开启公网访问，并填写公网端口。共享后可复制连接信息，连接统计从该项的“连接详情”查看。
3. 在另一台设备的“远端连接”粘贴连接信息，选择固定本地端口后连接。双方须使用同一控制服务和控制密钥；业务程序访问 `127.0.0.1:<本地端口>`。

连接信息为 `pidesk-tcp://<providerId>:<remotePort>`，仅编码已有目标，不含控制密钥或授权token，也不注册系统URL协议。只有共享端口匹配已配置的本机HTTP(S)网址时，页面才提供网页链接；普通TCP端口只提供地址。

控制地址和控制密钥可以在可信设备之间共享；`providerSecretKey` 是提供端自身身份，不能让两个同时在线的提供端使用同一份私钥。迁移设备时先退出原提供端，新增设备使用各自生成的身份。

发布目标固定为提供端的 `127.0.0.1:<本机端口>`；发布配置独立于网址书签。映射只监听 IPv4 `127.0.0.1`，端口占用时报告错误，不自动换号或停止占用者。

- `auto`：允许先中继建连，再尝试直连；不能直连时继续使用中继。
- `relay-only`：关闭访问端直接 IP 传输和端口映射探测，只经 relay。
- 界面显示真实连接的 `direct / relay / unknown`，策略不等于实际路径。切换策略会中断并重建本进程的访问端通道，本地端口不变；本机提供端和其他 CLI 进程不受影响。
- 活动 TCP 数是已授权且已建立本机 TCP 转发的业务流数量，不是请求数或人数。活动接入端是至少有一条活动流的不同 iroh 对端；公网多个访问者可能共用一个 gateway 对端。
- 公网入口始终是“公网转发”，即使 gateway→提供端的内层路径为直连，也不表示公网程序绕过了网关。

隧道 owner 首次启动前保存的连接设置立即用于首次连接。owner 启动后修改控制地址或密钥，须退出并重启应用；新增端口、恢复及模式重建仍使用已捕获的设置。独立 CLI 读取各自启动时的配置。服务端更换 relay URL、准入 token 或 QUIC 地址发现端口后，现有客户端也需重启以重新建立端点；这些参数未变的普通断线仍自动恢复。

显式停止或重配的清理失败会保留错误及管理入口，不显示为已确认停止。远端清理未确认的端口在当前进程内保持失败，需退出并重启应用后重试；其他端口不受影响。普通断线仍自动重连。

提供端每 5 秒续租。注册失效、连续续租失败或本地授权截止时撤销该端口 token 并关闭其业务流；截止点不晚于最近一次成功 open/status 请求发出后 30 秒。控制服务长期失联时，即使数据链仍通也不会无限保留直连授权。

隧道仅转发 TCP 字节，不改写 HTTP Host、Cookie、WebSocket Origin 或 TLS/SNI，也不提供 UDP 转发。业务自身认证与证书仍由业务服务负责。

每个原生端点的上限为 128 条传输连接、128 个发布项、128 个映射和 512 个并发流；探测也占用流槽。桌面提供端与访问端分别持有端点，容量各自计算。

## 无头提供端 CLI

桌面程序提供以下无窗口入口；`PI_DESK_DESKTOP_CONFIG` 必须是桌面 `config.json` 的绝对路径：

```text
<桌面程序> --tunnel-info
<桌面程序> --tunnel-client --local 127.0.0.1:30333 --public-port 40333 [--stats]
```

`--tunnel-info` 输出一行 `{ "controlServerUrl": string | null }`，不返回密钥。隧道命令在桌面单实例、窗口及托管服务初始化之前执行。

独立 CLI 使用同一提供端核心：

```text
pi-desk-tunnel-client --config <桌面config.json路径> --local 127.0.0.1:30333 --public-port 40333 [--stats]
```

独立 CLI 的 `--client` 参数已移除，传入会报错。两种 CLI 每次运行都生成临时提供端身份，不复用桌面 `providerSecretKey`，不回写配置，控制密钥不进入命令行。

stdout 为 NDJSON；默认只输出 `opening`、`connecting`、`listening`、`recovering`、`failed`、`stopped`。`connecting/listening` 携带 `publicAddr`，错误与恢复事件携带 `detail`。显式传入 `--stats` 才增加 `connections` 完整快照事件，行包含对端、本机端口、入口、实际路径和活动 TCP 数。探测不计入统计。

插件调用此CLI不要求打开桌面页面或预先创建页面共享；CLI实例由调用方管理，页面不接管其启停。调用方保持 stdin 打开，关闭 stdin（EOF）请求停止；`stopped` 只在资源回收完成后输出。诊断写 stderr，失败以非零退出码报告。CLI 只负责临时公网发布，本地映射由桌面端管理。

## 部署网关与 relay

同一隧道镜像包含网关和 relay 两个程序，使用 Linux Docker host 网络分别启动两个服务。配置入口为 [`.env.example`](./.env.example)、[`docker-compose.yml`](./docker-compose.yml) 和 [`relay.example.toml`](./relay.example.toml)：

| 服务                    | 职责与构建入口                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `pi-desk-tunnel-server` | HTTP 控制服务、公网 TCP listener 与 iroh gateway；由 [`Dockerfile`](./Dockerfile) 构建 |
| `iroh-relay`            | 转发 iroh 端点之间的加密数据；使用同一镜像的 `iroh-relay` 入口，不提供公网业务端口     |

`Dockerfile` 多阶段构建 relay，固定 iroh `1.4.1` 发布 commit `d6c6963b9602d1b8dd2ba53b6519e7eb19cc7940` 和上游锁文件。两个程序随同一 `pi-desk-tunnel` 镜像由现有 Actions 构建发布，不需要额外发布或下载第三方 relay 镜像。

先准备私有 `.env`、relay 配置及匹配域名的 TLS 证书。从源码构建时使用本地镜像标签，执行 `docker compose --env-file .env up -d --build`。部署发行镜像时，将 `PI_DESK_TUNNEL_IMAGE` 设为包含 v2 网关和 relay 的实际发布版本，执行 `docker compose --env-file .env pull`，再执行 `docker compose --env-file .env up -d --no-build`。旧 v1 镜像不包含新中继入口，不能用于此配置。

示例占位值不能直接用于生产。容器不会自动生成控制密钥、relay token 或 `connection.txt`。

| 配置项                                | 用途                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PI_DESK_TUNNEL_IMAGE`                | 两个容器共用的镜像版本；源码构建默认 `pi-desk-tunnel:local`，发行部署填写实际 GHCR 版本                   |
| `PI_DESK_TUNNEL_BIND`                 | 控制 HTTP 监听，默认 `0.0.0.0:7001`                                                                       |
| `PI_DESK_TUNNEL_SERVER_KEY`           | 必填，严格 64 位十六进制控制密钥                                                                          |
| `PI_DESK_TUNNEL_PUBLIC_HOST`          | 公网业务主机名或 IP，不含端口；Compose 要求显式设置                                                       |
| `PI_DESK_TUNNEL_IROH_RELAY_URL`       | 必填，可信客户端可达的 relay URL；示例为 `https://relay.example.com:8443`                                 |
| `PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT` | QUIC 地址发现 UDP 端口，默认 `7842`，有效范围 `1–65535`；须与 relay TOML 的 `tls.quic_bind_addr` 端口一致 |
| `PI_DESK_TUNNEL_IROH_RELAY_TOKEN`     | 必填，relay 准入 token；Compose 同时传为 relay 的 `IROH_RELAY_ACCESS_TOKEN`                               |
| `IROH_RELAY_CONFIG_PATH`              | Compose 挂载的宿主机私有 relay TOML 文件                                                                  |
| `IROH_RELAY_CERT_DIR`                 | Compose 只读挂载的证书目录，示例内含 `fullchain.pem` 与 `privkey.pem`                                     |
| `RUST_LOG`                            | 日志过滤，Compose 默认 `info`                                                                             |

控制密钥和 relay token 由部署者准备，两者不同。控制端通过加密 open/resolve 响应向可信原生端分发 relay 配置，token 不放在 URL 查询参数中。relay 的 shared-token 准入与逐端口的 service token 授权分别生效。

按实际配置放行并检查监听冲突：

| 流量                | 示例端口                        | 说明                                                |
| ------------------- | ------------------------------- | --------------------------------------------------- |
| 控制 HTTP           | TCP `7001`                      | 原生客户端访问，不是业务入口                        |
| relay HTTP/TLS      | TCP `8080` / `8443`             | 由 relay TOML 设置；TLS 证书须匹配 relay URL 主机名 |
| relay QUIC 地址发现 | UDP `7842`                      | 示例启用的地址发现，不是 UDP 业务转发               |
| 公网业务            | 每个发布的 TCP 端口，如 `40333` | 普通程序访问；relay 不能替代这些 listener           |

relay 以 UID 10001 运行，证书目录和私钥须对该用户可读；通过受限的用户/组权限或私有证书副本提供，不要求开放给所有用户。示例采用高端口；若改用 80/443，应先配置相应绑定权限或反向代理，并同步 relay URL。

控制端在加密 open/resolve 响应的 `relay.quic_port` 下发 QUIC 地址发现端口。该值必须与 relay TOML 的 `tls.quic_bind_addr` 端口一致，并放行对应 UDP 流量；仅修改 TOML 不会同步客户端。新客户端读取缺少该字段的旧 v2 响应时默认使用 `7842`。旧客户端会忽略新增字段、继续使用 `7842`，使用自定义端口前须升级网关和客户端。

两容器共用 host 网络，公网 listener 动态绑定发布端口；不要用少量静态 Docker `ports` 替代。gateway 为非 root 用户，低端口是否可绑定取决于宿主机权限。公网端口只限制为 `1–65535`，不预设业务端口范围；冲突或权限不足按实际 bind 错误报告。

gateway 访问同机 relay 时，应在保留正确 TLS 主机名的前提下，经本地 DNS/路由到达本机。host 网络或“部署在同机”不保证路径本地化；不能让该段经 CDN 或公网回流。自动直连还取决于端点 UDP、NAT 和防火墙条件，不保证所有网络都能直连。

`GET /api/v2/system/health` 只证明控制进程健康。部署验证还需实际检查公网 TCP/HTTP/WebSocket 转发、本地映射、强制中继路径及关闭后的端口释放，不能仅以容器 running 或 health 返回成功判断数据链可用。

## 升级与回退

控制协议使用 `/api/v2`，不兼容旧 v1/Noise 数据通道，没有运行时双栈或自动降级。升级前备份桌面配置和旧制品，在维护窗口同步切换服务端与桌面端；使用 `--stats` 的插件需要支持该参数的桌面端。

保持公网主机和公网端口时，普通程序的原访问地址可保持不变，但切换会断开现有 TCP。旧 `targets[].tunnel` 按 URL 的有效本机端口读取转换为独立发布配置，保留公网端口和启用状态；同一本机端口的设置冲突时报告具体记录并保留原文件，不静默丢弃。回退使用外部保存的旧服务端、桌面、插件制品及升级前配置，不在新源码启用旧栈。

第三方来源与授权见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
