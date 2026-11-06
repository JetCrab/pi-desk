"""运行：python -m unittest discover -s apps/tunnel/deploy -p 'test_*.py'。"""

import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "tunnel_init", Path(__file__).with_name("init.py")
)
init = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(init)
ROOT = Path(__file__).resolve().parents[4]
SCRATCH = ROOT / "temp/tests/tunnel-init"
IMAGE = init.REPOSITORY + "@sha256:" + "a" * 64
SETTINGS = {
    "domain": "relay.example.com",
    "email": "operator@example.com",
    "requested_image": IMAGE,
    "image": IMAGE,
}


class InitializationTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix="repeatable-deployment-", dir=SCRATCH))
        self.directory = self.work / "deployment"
        self.chown = mock.patch.object(init.os, "chown", create=True)
        self.chown_mock = self.chown.start()

    def tearDown(self):
        self.chown.stop()
        shutil.rmtree(self.work)

    def run_entry(self, *arguments, ready=None):
        lock = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=mock.Mock())
        with (
            mock.patch.dict(sys.modules, {"fcntl": lock}),
            mock.patch.object(init, "check_environment"),
            mock.patch.object(init, "check_dns"),
            mock.patch.object(init, "check_ports"),
            mock.patch.object(init, "pin_image", return_value=IMAGE) as pin,
            mock.patch.object(init, "start_and_check", side_effect=ready) as check,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            code = init.main(["--directory", str(self.directory), *arguments])
        return code, output.getvalue(), pin, check

    def test_first_install_and_rerun_preserve_every_config_and_secret(self):
        code, output, pin, _ = self.run_entry(
            "--domain",
            SETTINGS["domain"],
            "--email",
            SETTINGS["email"],
            "--image",
            IMAGE,
        )
        self.assertEqual(code, 0)
        self.assertEqual(pin.call_count, 1)
        self.assertEqual(self.chown_mock.call_args.args[1:], (10001, 10001))
        before = {
            path.name: path.read_bytes()
            for path in self.directory.iterdir()
            if path.is_file()
        }
        env = dict(
            line.split("=", 1)
            for line in (self.directory / ".env").read_text().splitlines()
        )
        self.assertRegex(env[init.ENV_CONTROL], r"^[a-f0-9]{64}$")
        self.assertRegex(env[init.ENV_RELAY], r"^[a-f0-9]{64}$")
        self.assertNotEqual(env[init.ENV_CONTROL], env[init.ENV_RELAY])
        self.assertIn(env[init.ENV_CONTROL], output)
        self.assertNotIn(env[init.ENV_RELAY], output)
        self.assertIn("未验证 relay 客户端认证", output)
        self.assertIn("控制地址：http://relay.example.com:7001", output)
        # 人工修改也应保留，不能用模板覆盖已有文件。
        with (self.directory / "relay.toml").open("a") as file:
            file.write("# operator comment\n")
        before["relay.toml"] = (self.directory / "relay.toml").read_bytes()
        (self.directory / "data/acme/cached_cert_fixture").write_text("fixture")
        _, output, pin, _ = self.run_entry()
        self.assertFalse(pin.called)
        self.assertNotIn(env[init.ENV_RELAY], output)
        self.assertEqual(
            before,
            {
                path.name: path.read_bytes()
                for path in self.directory.iterdir()
                if path.is_file()
            },
        )
        self.assertEqual(
            (self.directory / "data/acme/cached_cert_fixture").read_text(), "fixture"
        )
        if os.name != "nt":
            self.assertEqual((self.directory / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)

    def test_existing_directory_and_conflicting_arguments_are_not_adopted(self):
        self.directory.mkdir()
        (self.directory / "operator.txt").write_text("preserve")
        with self.assertRaises(init.DeploymentError):
            self.run_entry()
        self.assertEqual((self.directory / "operator.txt").read_text(), "preserve")
        shutil.rmtree(self.directory)
        init.save_installation(self.directory, SETTINGS)
        before = (self.directory / ".env").read_bytes()
        with self.assertRaisesRegex(init.DeploymentError, "不会覆盖配置"):
            self.run_entry("--domain", "other.example.com")
        self.assertEqual(before, (self.directory / ".env").read_bytes())
        (self.directory / ".env").unlink()
        with self.assertRaisesRegex(init.DeploymentError, "不会自动重建"):
            self.run_entry()
        self.assertFalse((self.directory / ".env").exists())

    def test_failed_readiness_retains_persistent_secrets_for_retry(self):
        init.save_installation(self.directory, SETTINGS)
        before = (self.directory / ".env").read_bytes()
        with self.assertRaisesRegex(init.DeploymentError, "fixture readiness failure"):
            self.run_entry(ready=init.DeploymentError("fixture readiness failure"))
        self.assertEqual(before, (self.directory / ".env").read_bytes())
        self.run_entry()
        self.assertEqual(before, (self.directory / ".env").read_bytes())

    def test_compose_and_relay_templates_match_the_verified_contract(self):
        services = init.compose_config(SETTINGS)["services"]
        relay, gateway = services["iroh-relay"], services["gateway"]
        self.assertEqual(relay["image"], gateway["image"])
        self.assertEqual(relay["image"], IMAGE)
        self.assertEqual(relay["user"], "10001:10001")
        self.assertEqual(relay["userns_mode"], "host")
        self.assertIn("0.0.0.0:443:8443/tcp", relay["ports"])
        self.assertEqual(gateway["network_mode"], "host")
        self.assertEqual(gateway["extra_hosts"], ["relay.example.com=127.0.0.1"])
        self.assertEqual(
            gateway["environment"]["PI_DESK_TUNNEL_PUBLIC_HOST"], SETTINGS["domain"]
        )
        self.assertEqual(
            gateway["environment"]["PI_DESK_TUNNEL_IROH_RELAY_URL"],
            "https://relay.example.com",
        )
        for service in services.values():
            self.assertEqual(service["restart"], "always")
            self.assertEqual(
                service["logging"]["options"], {"max-size": "10m", "max-file": "3"}
            )
            self.assertNotIn("TZ", service["environment"])
        acme = relay["volumes"][1]
        self.assertFalse(acme.get("read_only", False))
        self.assertEqual(acme["target"], "/var/lib/iroh-relay/acme")
        self.assertIn(
            'cert_dir = "/var/lib/iroh-relay/acme"', init.relay_config(SETTINGS)
        )
        self.assertIn('cert_mode = "LetsEncrypt"', init.relay_config(SETTINGS))
        self.assertIn('https_bind_addr = "0.0.0.0:8443"', init.relay_config(SETTINGS))
        self.assertIn("access.shared_token = []", init.relay_config(SETTINGS))

    def test_start_checks_tls_and_cache_before_gateway_without_recreating(self):
        init.save_installation(self.directory, SETTINGS)
        for name in ("cached_account_fixture", "cached_cert_fixture"):
            (self.directory / "data/acme" / name).write_text("fixture")
        with (
            mock.patch.object(init, "docker", return_value="") as docker,
            mock.patch.object(
                init,
                "local_json",
                side_effect=[{"status": "ok", "version": "1.4.1"}, {"status": "ok"}],
            ) as probe,
        ):
            init.start_and_check(self.directory, SETTINGS, 1)
        self.assertEqual(
            probe.call_args_list[0],
            mock.call("relay.example.com", 443, "/healthz", tls=True),
        )
        commands = [call.args for call in docker.call_args_list]
        self.assertEqual(commands[1][-1], "iroh-relay")
        self.assertEqual(commands[2][-1], "gateway")
        for command in commands[1:]:
            self.assertIn("--no-recreate", command)
            self.assertIn("never", command)
            self.assertIn("--no-build", command)
        self.assertFalse(
            any("pull" == argument for command in commands for argument in command)
        )
        (self.directory / "data/acme/cached_cert_fixture").unlink()
        with (
            mock.patch.object(init, "docker") as docker,
            mock.patch.object(
                init, "local_json", return_value={"status": "ok", "version": "1.4.1"}
            ),
        ):
            with self.assertRaisesRegex(init.DeploymentError, "缓存未持久保存"):
                init.start_and_check(self.directory, SETTINGS, 1)
            self.assertFalse(
                any(call.args[-1] == "gateway" for call in docker.call_args_list)
            )

    def test_readiness_failure_does_not_accept_running_or_control_health(self):
        with mock.patch.object(init.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(init.DeploymentError, "超时"):
                init.wait_ready("relay", lambda: False, 1)
        with mock.patch.object(init.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(init.DeploymentError, "超时"):
                init.wait_ready(
                    "TLS", mock.Mock(side_effect=ssl.SSLCertVerificationError()), 1
                )

    def test_explicit_image_is_pinned_and_relay_binary_version_is_checked(self):
        inspect = json.dumps(
            [{"Os": "linux", "Architecture": "amd64", "RepoDigests": [IMAGE]}]
        )
        with (
            mock.patch.object(init.subprocess, "run") as pull,
            mock.patch.object(
                init, "docker", side_effect=[inspect, "iroh-relay 1.4.1"]
            ) as docker,
        ):
            self.assertEqual(init.pin_image(init.REPOSITORY + ":1.2.3"), IMAGE)
            self.assertEqual(pull.call_args.args[0][-1], init.REPOSITORY + ":1.2.3")
            self.assertEqual(docker.call_args.args[-2:], (IMAGE, "--version"))
        with (
            mock.patch.object(init.subprocess, "run"),
            mock.patch.object(
                init, "docker", side_effect=[inspect, "iroh-relay 1.3.0"]
            ),
        ):
            with self.assertRaises(init.DeploymentError):
                init.pin_image(IMAGE)
        self.assertIsNone(init.IMAGE_PATTERN.fullmatch(init.REPOSITORY + ":latest"))
        self.assertIsNone(init.IMAGE_PATTERN.fullmatch(init.REPOSITORY))

    def test_cli_help_and_invalid_timeout_have_real_exit_statuses(self):
        environment = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        help_result = subprocess.run(
            [sys.executable, str(Path(init.__file__)), "--help"],
            capture_output=True,
            encoding="utf-8",
            env=environment,
        )
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("--image", help_result.stdout)
        failed = subprocess.run(
            [sys.executable, str(Path(init.__file__)), "--timeout", "0"],
            capture_output=True,
            encoding="utf-8",
            env=environment,
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("初始化失败", failed.stderr)
        self.assertNotIn("初始化完成", failed.stdout)

    def test_docker_does_not_override_or_print_persistent_secrets(self):
        with (
            mock.patch.dict(
                os.environ,
                {
                    init.ENV_CONTROL: "shell-control-fixture",
                    init.ENV_RELAY: "shell-relay-fixture",
                },
            ),
            mock.patch.object(
                init.subprocess,
                "run",
                return_value=types.SimpleNamespace(
                    returncode=1, stdout="", stderr="shell-relay-fixture"
                ),
            ) as command,
        ):
            with self.assertRaises(init.DeploymentError) as failure:
                init.docker("compose", "up")
        self.assertNotIn(init.ENV_CONTROL, command.call_args.kwargs["env"])
        self.assertNotIn(init.ENV_RELAY, command.call_args.kwargs["env"])
        self.assertNotIn("shell-relay-fixture", str(failure.exception))
        self.assertIn("compose up", str(failure.exception))

    def test_docker_nat_published_port_is_not_taken_over(self):
        containers = json.dumps(
            [
                {
                    "NetworkSettings": {
                        "Ports": {
                            "8443/tcp": [{"HostPort": "443", "HostIp": "0.0.0.0"}]
                        }
                    }
                }
            ]
        )
        with mock.patch.object(
            init, "docker", side_effect=["container-fixture", containers]
        ):
            with self.assertRaisesRegex(init.DeploymentError, "不会接管现有容器"):
                init.check_ports()

    def test_dns_requires_public_ipv4_and_rejects_aaaa(self):
        for address, family in [
            ("127.0.0.1", socket.AF_INET),
            ("2606:4700:4700::1111", socket.AF_INET6),
        ]:
            with mock.patch.object(
                init.socket,
                "getaddrinfo",
                return_value=[(family, socket.SOCK_STREAM, 6, "", (address, 443))],
            ):
                with self.assertRaises(init.DeploymentError):
                    init.check_dns("relay.example.com")
        with mock.patch.object(
            init.socket,
            "getaddrinfo",
            return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
            ],
        ):
            init.check_dns("relay.example.com")
        for invalid in (
            "127.0.0.1",
            "https://relay.example.com",
            'relay.example.com"\ncontact="bad',
        ):
            with self.assertRaises(init.DeploymentError):
                init.validate_domain(invalid)

    @unittest.skipUnless(shutil.which("openssl"), "真实本机 TLS 测试需要 openssl")
    def test_real_local_tls_verifies_host_and_ca_without_public_network(self):
        cert, key = self.work / "cert.pem", self.work / "key.pem"
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                str(key),
                "-out",
                str(cert),
                "-days",
                "1",
                "-subj",
                "/CN=relay.example.com",
                "-addext",
                "subjectAltName=DNS:relay.example.com",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok","version":"1.4.1"}')

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        port = server.server_port
        original_context = ssl.create_default_context
        try:
            with mock.patch.object(
                init.ssl,
                "create_default_context",
                side_effect=lambda: original_context(cafile=str(cert)),
            ):
                self.assertEqual(
                    init.local_json("relay.example.com", port, "/healthz", tls=True)[
                        "status"
                    ],
                    "ok",
                )
                with self.assertRaises(ssl.SSLCertVerificationError):
                    init.local_json("other.example.com", port, "/healthz", tls=True)
            with self.assertRaises(ssl.SSLCertVerificationError):
                init.local_json("relay.example.com", port, "/healthz", tls=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        with socket.socket() as released:
            released.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            released.bind(("127.0.0.1", port))


if __name__ == "__main__":
    unittest.main()
