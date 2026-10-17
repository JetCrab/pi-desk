使用 Docker Compose 在 Linux amd64 主机上运行 Pi Desk，无需在宿主机安装 Node.js 或 Pi。

镜像为 `ghcr.io/jetcrab/pi-desk`，仅支持 `linux/amd64`。`latest` 指向最新正式版；需要固定版本时，从 [GHCR 镜像页面](https://github.com/JetCrab/pi-desk/pkgs/container/pi-desk)选择已发布的正式版本标签，替换下文的 `latest`。

## 部署

在已安装 Docker Engine 和 Docker Compose 插件的主机上，创建部署目录并设置数据目录权限：

```bash
sudo mkdir -p /home/apps/pi-desk/data/home /home/apps/pi-desk/data/workspace
sudo chown "$(id -u):$(id -g)" /home/apps/pi-desk
sudo chown -R 1000:1000 /home/apps/pi-desk/data
cd /home/apps/pi-desk
```

在该目录保存以下配置为 `docker-compose.yml`：

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

启动并检查服务：

```bash
docker compose up -d
curl --fail http://127.0.0.1:6233/api/health
```

镜像包含 Pi 和常用命令行工具；项目或插件所需的额外工具链需自行提供。

## 访问

在 Docker 主机上打开 [http://127.0.0.1:6233/](http://127.0.0.1:6233/)。默认仅监听宿主机回环地址；远程访问需自行配置访问入口，使用 HTTPS 反向代理时须支持 WebSocket。

公网访问前，先在「设置 → 登录保护」设置至少 8 位密码并启用。

首次使用按[第一次对话](/docs/quickstart/)配置模型。容器使用独立的用户目录，不会自动读取宿主机已有的 Pi 配置。

## 数据

| 宿主机目录        | 容器内路径    | 保存内容                                             |
| ----------------- | ------------- | ---------------------------------------------------- |
| `data/home/`      | `/data/home/` | 会话、模型与登录信息、插件配置、已安装插件等用户数据 |
| `data/workspace/` | `/workspace/` | 项目文件和项目配置                                   |

容器以 UID/GID `1000:1000` 运行，两个数据目录及放入的项目文件须允许该用户读写。新建工作会话时选择容器内的 `/workspace/项目目录`。

需要保留的文件应放在挂载目录中，其他容器路径中的改动会在重建时丢失。

备份前结束任务并停止容器，保存 `docker-compose.yml` 和整个 `data/` 目录。迁移或恢复时，保持 `/data/home` 和 `/workspace` 的容器内路径不变，并保留数据目录权限。

## 升级

升级或重建前，先结束任务并备份；运行中的模型调用、工具命令和后台进程不会自动续跑。

在部署目录执行：

```bash
docker compose pull pi-desk
docker compose up -d pi-desk
```

使用固定版本时，先将 Compose 的 `image` 标签改为已发布的新正式版本。

镜像升级同时更新 Pi Desk、Pi 和内置工具，不在容器内用全局 npm 安装代替镜像升级。挂载目录中的插件仍按[插件更新方法](/docs/plugins/#更新与加载)管理。
