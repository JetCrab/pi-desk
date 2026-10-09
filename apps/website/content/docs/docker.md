在 Linux 服务器上用 Docker 运行 Pi Desk，项目和会话保存在宿主机目录中，通过浏览器访问。宿主机只需安装 Docker Engine 和 Docker Compose 插件，无需另外安装 Node.js 或 Pi。

镜像随支持 Docker 的正式版本发布。首次部署前，请先确认 [GHCR 镜像页面](https://github.com/JetCrab/pi-desk/pkgs/container/pi-desk)已有正式版本标签，再执行下文的拉取命令。

## 镜像与版本

- 镜像地址：`ghcr.io/jetcrab/pi-desk`，仅发布正式版，不提供 `dev` 镜像。
- 支持平台：`linux/amd64`。本文不适用于 ARM 主机。
- `latest` 指向最新正式版；固定版本标签与主程序 `package.json` 的正式版本一致。
- 镜像基于 Node.js 22 和 Debian slim，已包含 Pi、Bash、Git、SSH、curl、Python、npm、pnpm、rg 和 fd。需要浏览器、其他语言工具链或原生模块编译器的项目和插件，需另行提供相应依赖。

首次启动可以使用 `latest`。需要固定版本时，从 [GHCR 镜像页面](https://github.com/JetCrab/pi-desk/pkgs/container/pi-desk)中选择**已经发布的正式版本标签**，将下文的 `:latest` 换成该标签；不要加 `v` 前缀或填写尚未发布的版本。

## 1. 准备数据目录

以下命令在运行 Docker 的 Linux 主机上执行。确认 `docker version` 和 `docker compose version` 可用，并且当前用户有运行 Docker 的权限。

使用 `/home/apps/pi-desk/` 存放部署文件。首次部署时创建目录并设置权限：

```bash
sudo mkdir -p /home/apps/pi-desk/data/home /home/apps/pi-desk/data/workspace
sudo chown "$(id -u):$(id -g)" /home/apps/pi-desk
sudo chown -R 1000:1000 /home/apps/pi-desk/data
cd /home/apps/pi-desk
```

容器以 `node` 用户运行，UID/GID 都是 `1000`。两个数据目录必须允许该用户读写；复制已有项目到 `data/workspace/` 后，也要检查项目文件权限。

| 宿主机目录        | 容器内路径    | 保存内容                                             |
| ----------------- | ------------- | ---------------------------------------------------- |
| `data/home/`      | `/data/home/` | 会话、模型与登录信息、插件配置、已安装插件等用户数据 |
| `data/workspace/` | `/workspace/` | 项目文件和项目配置                                   |

容器的 `HOME` 是 `/data/home`，`PI_CODING_AGENT_DIR` 是 `/data/home/.pi/agent`，会话目录是 `/data/home/.pi/agent/sessions`。不要把需要保留的文件只写在这两个挂载目录以外的容器路径中；容器重建会丢弃那些文件，`/tmp` 的内容也不会保留。

## 2. 创建 Compose 文件并启动

在 `/home/apps/pi-desk/` 下保存以下完整内容为 `docker-compose.yml`：

```yaml
services:
  pi-desk:
    image: ghcr.io/jetcrab/pi-desk:latest
    platform: linux/amd64
    restart: always
    environment:
      TZ: Asia/Shanghai
    ports:
      - '127.0.0.1:6233:6233'
    volumes:
      - ./data/home:/data/home
      - ./data/workspace:/workspace
    tmpfs:
      - /tmp:rw,nosuid,size=512m
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
    stop_grace_period: 30s
```

然后执行：

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 pi-desk
curl --fail http://127.0.0.1:6233/api/health
```

容器显示运行中后，还需确认健康检查成功、浏览器能打开页面。此配置仅在 Docker 主机的 `127.0.0.1:6233` 上提供访问，不直接向公网开放 `6233`。不要默认挂载宿主机的 `docker.sock`。

## 3. 打开页面并开始使用

### Docker 就在当前电脑上

在这台电脑的浏览器打开 [http://127.0.0.1:6233/](http://127.0.0.1:6233/)。

### Docker 在远程服务器上

你自己电脑上的 `127.0.0.1` 不是远程服务器。先在**自己电脑的终端**执行 SSH 端口转发：

```bash
ssh -N -L 127.0.0.1:16233:127.0.0.1:6233 user@203.0.113.10
```

将 `user` 和示例 IP `203.0.113.10` 换成服务器的 SSH 用户和地址。保持这个终端开启，然后在自己电脑的浏览器打开 [http://127.0.0.1:16233/](http://127.0.0.1:16233/)。关闭 SSH 连接会停止转发，不会停止服务器上的 Pi Desk。

首次打开后：

1. 进入「设置 → 登录保护」，设置至少 8 位密码并启用；远程访问时保持登录保护开启。先通过本机或 SSH 转发完成这一步，再开放其他访问入口。
2. 按[开始对话](/docs/quickstart/)配置模型。容器有独立的用户目录，不会自动读取宿主机已有的 Pi 配置。
3. 将项目放进宿主机 `data/workspace/`，新建工作会话时选择容器里的 `/workspace/项目目录`，不要填写宿主机的 `/home/apps/pi-desk/data/workspace/`。
4. 在会话中发送消息并确认能收到回复。插件安装与使用见[插件文档](/docs/plugins/)。

### 使用 HTTPS 域名访问

需要不依赖 SSH 转发的访问入口时，使用带有效证书的 HTTPS 反向代理，转发到 Docker 主机的 `http://127.0.0.1:6233`，并启用 WebSocket 转发。不要将未开启登录保护的服务直接开放到公网。

下面的配置供**已在 Docker 宿主机上运行的 Nginx** 使用。先准备自己的域名和有效证书，将 `desk.example.com` 与证书路径替换为实际值：

```nginx
server {
    listen 443 ssl;
    server_name desk.example.com;

    ssl_certificate /etc/letsencrypt/live/desk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/desk.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:6233;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

在现有 Nginx 配置中启用并检查后，通过 `https://你的域名/` 访问。若反向代理本身也运行在容器里，它的 `127.0.0.1` 指向代理容器，不能直接沿用以上上游地址；需按该代理的网络配置连接 Pi Desk 服务。其他反向代理同样需要支持 WebSocket，连接后发送消息确认回复实时出现。

## 日常管理

在 `/home/apps/pi-desk/` 下执行：

```bash
# 查看状态与最近日志
docker compose ps
docker compose logs --tail=100 pi-desk

# 持续查看日志，按 Ctrl+C 退出日志查看
docker compose logs -f --tail=100 pi-desk

# 进入容器，结束后用 exit 退出
docker compose exec pi-desk bash

# 重启服务
docker compose restart pi-desk

# 停止或重新启动服务
docker compose stop pi-desk
docker compose up -d
```

**重启、升级或重建容器前，先结束正在进行的任务。** 会话历史、配置和项目文件保留在挂载目录中，但进行中的模型调用、工具命令和后台进程不会在容器重启后自动续跑。重新打开会话后，检查任务结果再继续。

## 升级

升级前先结束任务并备份。使用 `latest` 时，在部署目录执行：

```bash
docker compose pull pi-desk
docker compose up -d pi-desk
docker compose ps
docker compose logs --tail=100 pi-desk
curl --fail http://127.0.0.1:6233/api/health
```

使用固定版本时，先将 Compose 的 `image` 标签改为 GHCR 中已有的新正式版本，再执行相同命令。仅执行 `restart` 不会拉取新镜像。

升级使用新镜像中的 Pi Desk、Pi 和内置工具，不要在容器里用全局 npm 安装代替镜像升级；写入容器可写层的改动会在重建时丢失。挂载目录中的插件仍按[插件更新方法](/docs/plugins/#更新与加载)管理。

保持项目的容器内路径不变，例如始终使用 `/workspace/my-project`。会话与项目路径关联，迁移部署时只改变宿主机存放位置，不改变容器里的挂载路径。

## 备份与恢复

### 备份

结束任务并停止容器后，打包两个数据目录和 Compose 文件，以免备份过程中仍有文件写入：

```bash
cd /home/apps/pi-desk
docker compose stop pi-desk
sudo tar --numeric-owner -czvf "/home/apps/pi-desk-backup-$(date +%Y%m%d-%H%M%S).tar.gz" docker-compose.yml data
docker compose up -d pi-desk
```

确认备份成功后，再将备份文件复制到其他存储位置。备份包含会话、模型登录信息、插件配置和项目文件，应按自己的访问权限管理。

### 恢复

在已安装 Docker 与 Compose 的 Linux amd64 主机上，准备一个**新建或空的部署目录**；不要直接覆盖正在使用的数据。将备份传到该主机后执行，将示例备份路径替换为实际文件：

```bash
sudo mkdir -p /home/apps/pi-desk
sudo tar --numeric-owner -xzvf '<备份文件的绝对路径>' -C /home/apps/pi-desk
sudo chown "$(id -u):$(id -g)" /home/apps/pi-desk
sudo chown -R 1000:1000 /home/apps/pi-desk/data
cd /home/apps/pi-desk
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:6233/api/health
```

若在同一主机恢复，先停止原部署，避免端口冲突。恢复时保留 `/data/home` 和 `/workspace` 的容器内路径，并优先使用备份时记录的固定镜像版本；使用 `latest` 会获取恢复时的最新正式版。打开页面，检查模型配置、会话历史和项目文件，再开始新任务。

## 不使用 Compose 时

也可以在准备好相同数据目录后用 `docker run` 启动。此方式与 Compose **二选一**，不要同时占用 `6233` 端口：

```bash
docker run -d --name pi-desk \
  --platform linux/amd64 \
  --restart=always \
  -e TZ=Asia/Shanghai \
  -p 127.0.0.1:6233:6233 \
  -v /home/apps/pi-desk/data/home:/data/home \
  -v /home/apps/pi-desk/data/workspace:/workspace \
  --tmpfs /tmp:rw,nosuid,size=512m \
  --log-driver=json-file \
  --log-opt max-size=10m --log-opt max-file=3 \
  --stop-timeout=30 \
  ghcr.io/jetcrab/pi-desk:latest
```

访问方式和数据保留规则相同。查看日志用 `docker logs --tail=100 pi-desk`，进入容器用 `docker exec -it pi-desk bash`。升级时先备份并停止任务，执行 `docker pull ghcr.io/jetcrab/pi-desk:latest`，再用 `docker stop pi-desk`、`docker rm pi-desk` 删除旧容器，重新执行上面的启动命令；不要删除宿主机数据目录。
