#!/usr/bin/env python3
"""初始化 Linux amd64 上的 Pi Desk tunnel；只使用 Python 标准库和已有 Docker Compose。"""

import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time


REPOSITORY = "ghcr.io/jetcrab/pi-desk-tunnel"
IMAGE_PATTERN = re.compile(
    re.escape(REPOSITORY)
    + r"(?::[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?|@sha256:[0-9a-f]{64})"
)
ENV_CONTROL = "PI_DESK_TUNNEL_SERVER_KEY"
ENV_RELAY = "PI_DESK_TUNNEL_IROH_RELAY_TOKEN"


class DeploymentError(Exception):
    pass


def docker(*arguments: str) -> str:
    environment = os.environ.copy()
    # 持久 .env 是密钥 owner，不能被调用 shell 的同名变量替换。
    for key in (ENV_CONTROL, ENV_RELAY):
        environment.pop(key, None)
    result = subprocess.run(
        ["docker", *arguments],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    if result.returncode:
        # Compose 的错误可能带插值后的配置；不将它或容器日志自动打印到终端。
        raise DeploymentError(
            f"Docker 命令失败（exit={result.returncode}）：docker "
            + shlex.join(arguments)
        )
    return result.stdout.strip()


def validate_domain(domain: str) -> None:
    if (
        len(domain) > 253
        or "." not in domain
        or not all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in domain.split(".")
        )
    ):
        raise DeploymentError(
            "域名必须是小写 ASCII 完整域名（国际化域名先转换为 punycode）"
        )
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        return
    raise DeploymentError("必须使用真实域名，不能使用 IP 地址")


def check_dns(domain: str) -> None:
    addresses = {
        ipaddress.ip_address(row[4][0])
        for row in socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)
    }
    if not addresses or any(not address.is_global for address in addresses):
        raise DeploymentError("域名必须解析到公网 IPv4 地址；先配置 DNS A 记录")
    if any(address.version == 6 for address in addresses):
        raise DeploymentError(
            "此入口仅部署 IPv4；域名存在 AAAA 记录，须先由管理员处理 IPv6 路由"
        )


def check_environment() -> None:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        raise DeploymentError("仅支持 Linux x86_64")
    if os.geteuid() != 0:
        raise DeploymentError(
            "使用 sudo/root 执行，以创建权限受控的配置和 UID 10001 的 ACME 缓存"
        )
    if not shutil.which("docker"):
        raise DeploymentError(
            "先自行安装并启动 Docker 和 Docker Compose v2；脚本不会自动安装"
        )
    if not os.environ.get("DOCKER_HOST", "unix://").startswith("unix://"):
        raise DeploymentError("仅支持本机 Unix socket Docker daemon，不操作远程 Docker")
    context = json.loads(docker("context", "inspect"))[0]
    if not context["Endpoints"]["docker"]["Host"].startswith("unix://"):
        raise DeploymentError("仅支持本机 Unix socket Docker context")
    info = json.loads(docker("info", "--format", "{{json .}}"))
    if info["OSType"] != "linux" or info["Architecture"] not in ("x86_64", "amd64"):
        raise DeploymentError("Docker daemon 必须是 Linux amd64")
    if any("rootless" in option for option in info.get("SecurityOptions", [])):
        raise DeploymentError("此入口不支持 rootless Docker 的低端口和 host 网络限制")
    docker("compose", "version")


def check_ports() -> None:
    # Docker 关闭 userland-proxy 时发布端口未必对应宿主机监听 socket。
    containers = docker("ps", "--quiet").split()
    if containers:
        for container in json.loads(docker("inspect", *containers)):
            for protocol, bindings in (
                container["NetworkSettings"].get("Ports", {}).items()
            ):
                for binding in bindings or []:
                    port = binding["HostPort"]
                    if (port, protocol.rsplit("/", 1)[1]) in {
                        ("443", "tcp"),
                        ("7001", "tcp"),
                        ("7842", "udp"),
                    }:
                        raise DeploymentError(
                            f"Docker 已发布端口 {port}；不会接管现有容器"
                        )
    for port, kind in [
        (443, socket.SOCK_STREAM),
        (7001, socket.SOCK_STREAM),
        (7842, socket.SOCK_DGRAM),
    ]:
        with socket.socket(socket.AF_INET, kind) as listener:
            try:
                listener.bind(("0.0.0.0", port))
            except OSError as error:
                raise DeploymentError(
                    f"端口 {port} 已占用或不能绑定；不会停止现有服务"
                ) from error


def pin_image(requested: str) -> str:
    print("拉取显式指定的镜像，并核对 linux/amd64 和 iroh-relay 1.4.1…", flush=True)
    subprocess.run(
        ["docker", "pull", "--platform", "linux/amd64", requested], check=True
    )
    image = json.loads(docker("image", "inspect", requested))[0]
    if image["Os"] != "linux" or image["Architecture"] != "amd64":
        raise DeploymentError("镜像不是 Linux amd64")
    pinned = next(
        (
            digest
            for digest in image.get("RepoDigests", [])
            if digest.startswith(REPOSITORY + "@sha256:")
        ),
        None,
    )
    if pinned is None:
        raise DeploymentError("镜像缺少可持久固定的仓库 digest")
    version = docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "iroh-relay",
        pinned,
        "--version",
    )
    if version != "iroh-relay 1.4.1":
        raise DeploymentError("镜像中的 iroh-relay 不是已核对配置合同的 1.4.1")
    return pinned


def compose_config(settings: dict) -> dict:
    common = {
        "image": settings["image"],
        "platform": "linux/amd64",
        "user": "10001:10001",
        "userns_mode": "host",
        "restart": "always",
        "stop_grace_period": "30s",
        "logging": {
            "driver": "json-file",
            "options": {"max-size": "10m", "max-file": "3"},
        },
    }
    domain = settings["domain"]
    return {
        "services": {
            "iroh-relay": {
                **common,
                "entrypoint": ["iroh-relay"],
                "command": ["--config-path", "/etc/iroh-relay/relay.toml"],
                # 公开 TCP 443 原样转发 TLS-ALPN；容器无需特权端口或额外 capability。
                "ports": ["0.0.0.0:443:8443/tcp", "0.0.0.0:7842:7842/udp"],
                "environment": {
                    "RUST_LOG": "info",
                    "IROH_RELAY_ACCESS_TOKEN": "${"
                    + ENV_RELAY
                    + ":?必须保留 relay token}",
                },
                "volumes": [
                    {
                        "type": "bind",
                        "source": "./relay.toml",
                        "target": "/etc/iroh-relay/relay.toml",
                        "read_only": True,
                        "bind": {"create_host_path": False},
                    },
                    {
                        "type": "bind",
                        "source": "./data/acme",
                        "target": "/var/lib/iroh-relay/acme",
                        "bind": {"create_host_path": False},
                    },
                ],
            },
            "gateway": {
                **common,
                "entrypoint": ["pi-desk-tunnel-server"],
                "network_mode": "host",
                "extra_hosts": [domain + "=127.0.0.1"],
                "environment": {
                    "RUST_LOG": "info",
                    "PI_DESK_TUNNEL_BIND": "0.0.0.0:7001",
                    ENV_CONTROL: "${" + ENV_CONTROL + ":?必须保留控制密钥}",
                    "PI_DESK_TUNNEL_PUBLIC_HOST": domain,
                    "PI_DESK_TUNNEL_IROH_RELAY_URL": "https://" + domain,
                    "PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT": "7842",
                    ENV_RELAY: "${" + ENV_RELAY + ":?必须保留 relay token}",
                },
            },
        }
    }


def relay_config(settings: dict) -> str:
    return f"""enable_relay = true
http_bind_addr = "127.0.0.1:8080"
enable_quic_addr_discovery = true
enable_metrics = false
access.shared_token = []

[tls]
https_bind_addr = "0.0.0.0:8443"
quic_bind_addr = "0.0.0.0:7842"
hostname = {json.dumps(settings["domain"])}
cert_mode = "LetsEncrypt"
cert_dir = "/var/lib/iroh-relay/acme"
prod_tls = true
contact = {json.dumps(settings["email"])}
"""


def save_installation(directory: Path, settings: dict) -> None:
    stage = Path(tempfile.mkdtemp(prefix=".pi-desk-tunnel-init-", dir=directory.parent))
    try:
        (stage / "data/acme").mkdir(parents=True, mode=0o700)
        os.chown(stage / "data/acme", 10001, 10001)
        control, relay = secrets.token_hex(32), secrets.token_hex(32)
        (stage / ".env").write_text(
            f"{ENV_CONTROL}={control}\n{ENV_RELAY}={relay}\n", encoding="utf-8"
        )
        (stage / "deployment.json").write_text(
            json.dumps(settings, indent=2) + "\n", encoding="utf-8"
        )
        # JSON 是 YAML 的子集；Compose 可直接读取，也避免增加 YAML/Python 依赖。
        (stage / "compose.yaml").write_text(
            json.dumps(compose_config(settings), indent=2) + "\n", encoding="utf-8"
        )
        (stage / "relay.toml").write_text(relay_config(settings), encoding="utf-8")
        for name in (".env", "deployment.json", "compose.yaml"):
            (stage / name).chmod(0o600)
        (stage / "relay.toml").chmod(0o644)
        # 暂存目录由 root 独占；relay 的单文件挂载仍可被容器 UID 10001 读取。
        if directory.exists():
            raise DeploymentError("目标目录已存在，不覆盖或接管现有文件")
        stage.rename(directory)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def load_installation(directory: Path, args: argparse.Namespace) -> dict:
    settings = json.loads((directory / "deployment.json").read_text(encoding="utf-8"))
    for argument, field in [
        (args.domain, "domain"),
        (args.email, "email"),
        (args.image, "requested_image"),
    ]:
        if argument is not None and argument != settings[field]:
            raise DeploymentError(
                "输入与持久配置不同；初始化入口不会覆盖配置或执行升级"
            )
    for name in (".env", "compose.yaml", "relay.toml", "data/acme"):
        if not (directory / name).exists():
            raise DeploymentError(f"已管理目录缺少 {name}；不会自动重建或更换密钥")
    return settings


def local_json(host: str, port: int, path: str, tls: bool = False) -> dict:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.connect()
        if tls:
            connection.sock = ssl.create_default_context().wrap_socket(
                connection.sock, server_hostname=host
            )
        connection.request("GET", path, headers={"Host": host})
        response = connection.getresponse()
        if response.status != 200:
            raise DeploymentError(f"本机 {path} 返回 HTTP {response.status}")
        return json.loads(response.read(4096))
    finally:
        connection.close()


def wait_ready(label: str, probe, timeout: int) -> None:
    print(label + "…", flush=True)
    deadline = time.monotonic() + timeout
    next_progress = time.monotonic() + 30
    last_error = "响应字段不匹配"
    while True:
        try:
            if probe():
                return
            last_error = "响应字段不匹配"
        except (
            OSError,
            http.client.HTTPException,
            ValueError,
            DeploymentError,
        ) as error:
            last_error = f"{type(error).__name__}: {error}"
        if time.monotonic() >= deadline:
            raise DeploymentError(
                label
                + "超时；最近探测："
                + last_error
                + "。保留服务与配置供重试，检查 DNS、公网 443 和 Compose 日志"
            )
        if time.monotonic() >= next_progress:
            print(label + "：仍在等待", flush=True)
            next_progress = time.monotonic() + 30
        time.sleep(2)


def start_and_check(directory: Path, settings: dict, timeout: int) -> None:
    project = (
        "pi-desk-tunnel-" + hashlib.sha256(str(directory).encode()).hexdigest()[:12]
    )

    def compose(*arguments: str) -> str:
        return docker(
            "compose",
            "--project-name",
            project,
            "--project-directory",
            str(directory),
            "--env-file",
            str(directory / ".env"),
            "-f",
            str(directory / "compose.yaml"),
            *arguments,
        )

    def relay_ready() -> bool:
        value = local_json(settings["domain"], 443, "/healthz", tls=True)
        return value.get("status") == "ok" and value.get("version") == "1.4.1"

    compose("config", "--quiet")
    compose("up", "-d", "--no-recreate", "--pull", "never", "--no-build", "iroh-relay")
    wait_ready(
        "等待本机 relay 域名证书（校验 CA、主机名）和 1.4.1 HTTPS 响应",
        relay_ready,
        timeout,
    )
    cache = directory / "data/acme"
    for prefix in ("cached_account_", "cached_cert_"):
        if not any(
            file.is_file() and file.stat().st_size > 0
            for file in cache.glob(prefix + "*")
        ):
            raise DeploymentError("ACME 账号或证书缓存未持久保存；不会报告初始化完成")
    compose("up", "-d", "--no-recreate", "--pull", "never", "--no-build", "gateway")
    wait_ready(
        "等待本机控制 HTTP 健康响应",
        lambda: (
            local_json(settings["domain"], 7001, "/api/v2/system/health")
            == {"status": "ok"}
        ),
        timeout,
    )


def parse_arguments(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="初始化双容器 tunnel；首次运行联系 Let's Encrypt 并接受其服务条款。需要已有本机 rootful Docker Compose v2、Python 3 和公网 IPv4 域名。",
        epilog="首次示例：sudo python3 init.py --domain tunnel.your-domain.com --email admin@your-domain.com --image ghcr.io/jetcrab/pi-desk-tunnel@sha256:<已核实摘要>。重复运行只需同一 --directory。不会配置时区、防火墙或安装 Docker。需自行放通 TCP 443/7001、UDP 7842 以及实际业务 TCP 端口（非 root gateway 默认使用 >=1024）。公网 443 必须直达本机，不能经过 TLS 终止代理。此 IPv4 入口要求域名无 AAAA 记录。",
    )
    parser.add_argument("--domain")
    parser.add_argument("--email")
    parser.add_argument(
        "--image",
        help="必须显式指定版本标签或 sha256 digest；不使用 latest，不假定本地版本已发布",
    )
    parser.add_argument(
        "--directory", type=Path, default=Path("/home/apps/pi-desk-tunnel")
    )
    parser.add_argument(
        "--timeout", type=int, default=600, help="每阶段就绪等待秒数，默认 600"
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_arguments(argv)
    if args.timeout <= 0:
        raise DeploymentError("timeout 必须大于 0")
    directory = args.directory.expanduser().resolve()
    check_environment()
    directory.parent.mkdir(parents=True, exist_ok=True)
    import fcntl

    with (directory.parent / ("." + directory.name + ".init.lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeploymentError("同一目录的初始化正在执行") from error
        if directory.exists():
            if not (directory / "deployment.json").is_file():
                raise DeploymentError("目标目录不属于此初始化入口；不会覆盖或接管")
            settings = load_installation(directory, args)
            print(
                "使用已有配置和密钥；不拉取、不覆盖、不重建已有容器。手工修改配置不会自动应用到已有容器。",
                flush=True,
            )
        else:
            if not args.domain or not args.email or not args.image:
                raise DeploymentError("首次运行必须提供 --domain、--email 和 --image")
            validate_domain(args.domain)
            if not re.fullmatch(
                r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", args.email
            ):
                raise DeploymentError("email 格式无效")
            if not IMAGE_PATTERN.fullmatch(args.image):
                raise DeploymentError(
                    "image 必须是 ghcr.io/jetcrab/pi-desk-tunnel 的显式数字版本或 sha256 digest"
                )
            check_dns(args.domain)
            check_ports()
            settings = {
                "domain": args.domain,
                "email": args.email,
                "requested_image": args.image,
                "image": pin_image(args.image),
            }
            save_installation(directory, settings)
        print("配置目录：" + str(directory), flush=True)
        print("固定镜像：" + settings["image"], flush=True)
        start_and_check(directory, settings, args.timeout)
        control = dict(
            line.split("=", 1)
            for line in (directory / ".env").read_text().splitlines()
            if line.startswith(ENV_CONTROL + "=")
        )[ENV_CONTROL]
        print("初始化完成：仅本机证书、relay HTTPS、ACME 缓存和控制 HTTP 检查通过。")
        print(
            "未验证 relay 客户端认证、真实隧道转发和公网端到端可达性；须另用桌面客户端验收。"
        )
        print("控制地址：http://" + settings["domain"] + ":7001")
        print("控制密钥：" + control)
        print("控制地址主机同时用于业务入口；不要将其改为仅用于控制的其他主机。")
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        DeploymentError,
        OSError,
        ValueError,
        KeyError,
        subprocess.CalledProcessError,
    ) as error:
        print("初始化失败：" + str(error), file=sys.stderr)
        sys.exit(1)
