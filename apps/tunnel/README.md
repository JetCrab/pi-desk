# Pi Desk Tunnel

通过 iroh 共享 TCP 端口，供桌面端、无头提供端 CLI 和公网网关使用。公网浏览器或 TCP 程序直接访问服务器的业务端口，无需隧道客户端；原生访问端可映射到固定本地端口，直连失败时经 relay 转发。

## 部署网关与 relay

### 单容器启动（推荐）

前提是已安装 Docker。Docker Desktop 需先在设置中启用[主机网络](https://docs.docker.com/engine/network/drivers/host/)。

```bash
docker run -d --name pi-desk-tunnel --pull=always --network host --restart=always --log-opt max-size=10m --log-opt max-file=3 -v pi-desk-tunnel-data:/data ghcr.io/jetcrab/pi-desk-tunnel:latest
```

控制服务和 HTTP 中继共用一个服务入口。

未传 `PI_DESK_TUNNEL_SERVER_KEY` 时，首次自动生成 64 位十六进制控制密钥（32 个随机字节），保存到 `/data/server-key`。读取密钥：

```bash
docker exec pi-desk-tunnel cat /data/server-key
```

重启或重建容器时复用命名卷 `pi-desk-tunnel-data`。需要指定密钥时，在启动命令中额外加入 `-e PI_DESK_TUNNEL_SERVER_KEY='<64位十六进制密钥>'`；显式值优先，并更新卷中的控制密钥。

独立 relay token 自动生成到 `/data/relay-token`，由控制服务分发给可信原生端；控制密钥与 relay token 都不要发给普通网页访问者。

### 源码运行

使用仓库中的单容器 [Compose](./docker-compose.yml)，入口与上述 `docker run` 相同：

```bash
cp .env.example .env
docker compose --env-file .env up -d --build
```

[`.env.example`](./.env.example) 中的 `PI_DESK_TUNNEL_IMAGE` 默认为本地构建标签，`PI_DESK_TUNNEL_SERVER_KEY` 可选。使用发行镜像时，将镜像设为 `ghcr.io/jetcrab/pi-desk-tunnel:latest`，先执行 `docker compose --env-file .env pull`，再执行 `docker compose --env-file .env up -d --no-build`。保留 host 网络和数据卷，以支持动态业务端口并复用密钥。

## 桌面接入

在桌面控制中心进入“远程访问”：

1. 在“设置”保存服务端地址 `http://服务器IP:7001` 和上述控制密钥。客户端使用该 URL 的同一入口连接控制服务和中继，不另填中继地址。
2. 在“本机共享”添加本机端口；需要免客户端访问时开启公网访问，并填写公网端口。共享后可复制地址或连接信息，从“连接详情”查看状态。
3. 原生访问端在另一台桌面的“设置”填写相同控制地址和密钥，再到“远端连接”粘贴连接信息、选择固定本地端口。业务程序访问 `127.0.0.1:<本地端口>`。

连接信息 `pidesk-tcp://<providerId>:<remotePort>` 仅用于复制目标，不含控制密钥或授权 token，不注册系统 URL 协议。只有共享端口匹配已配置的本机 HTTP(S) 网址时才提供网页链接，普通 TCP 端口只提供地址。

- 公网地址由客户端填写的服务端 URL 主机和业务端口生成；开启公网访问时，网关仍会监听填写的业务端口。
- “自动”尝试直连，不能直连时经中继；“仅中继”始终经中继。切换模式会重建当前访问端连接，本地端口不变。
- 提供端应用和本机业务服务需持续运行；业务认证由业务服务负责。隧道数据端到端加密，HTTP 中继准入令牌和浏览器 HTTP 访问本身不加密。
- 修改服务端地址或密钥后，退出并重启客户端；普通断线自动恢复。

## 无头提供端 CLI

桌面程序提供无窗口入口，`PI_DESK_DESKTOP_CONFIG` 须设为桌面 `config.json` 的绝对路径：

```text
<桌面程序> --tunnel-info
<桌面程序> --tunnel-client --local 127.0.0.1:30333 --public-port 40333 [--stats]
```

`--tunnel-info` 输出一行 `{ "controlServerUrl": string | null }`，不返回密钥。独立 CLI 使用：

```text
pi-desk-tunnel-client --config <桌面config.json路径> --local 127.0.0.1:30333 --public-port 40333 [--stats]
```

两种 CLI 每次运行生成临时提供端身份，不复用桌面 `providerSecretKey`，不回写配置，控制密钥不进入命令行。独立 CLI 不接受旧 `--client` 参数。CLI 只负责临时公网发布，本地映射由桌面端管理。

stdout 为 NDJSON，默认事件为 `opening`、`connecting`、`listening`、`recovering`、`failed`、`stopped`；`connecting/listening` 携带 `publicAddr`，错误与恢复事件携带 `detail`。`--stats` 增加 `connections` 完整快照，包含对端、本机端口、入口、实际路径和活动 TCP 数；活动 TCP 按业务流而非人数计数，不含探测。

调用方管理 CLI 生命周期，无需打开桌面页面或预建共享。保持 stdin 打开，关闭 stdin（EOF）请求停止；`stopped` 只在资源回收后输出。诊断写 stderr，失败以非零退出码报告。

## 升级与回退

控制协议为 `/api/v2`，不兼容旧 v1/Noise；升级前备份配置和旧制品，同步切换服务端与桌面端，现有 TCP 会断开。使用 `--stats` 需要配套桌面支持，回退需恢复旧制品与升级前配置；旧配置转换冲突时保留原文件并报告错误。

第三方来源与授权见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
