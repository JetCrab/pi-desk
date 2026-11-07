"""运行：python -m unittest discover -s apps/tunnel/deploy -p 'test_docker_start.py'。"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[3]
ENTRY = ROOT / "apps/tunnel/docker-start.sh"


def shell_path(path):
    if os.name == "nt":
        return subprocess.check_output(
            ["bash", "-c", 'cygpath -u "$1"', "bash", str(path)], text=True
        ).strip()
    return str(path)


class DockerStartTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "temp/tests/tunnel-docker-start"
        scratch.mkdir(parents=True, exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix="key-lifecycle-", dir=scratch))
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.process = None
        self.logs = []
        executable = self.bin / "pi-desk-tunnel-server"
        executable.write_text(
            "#!/bin/bash\n"
            'printf "%s\\n" "$BASHPID" > "$TEST_STATE_DIR/server.pid"\n'
            'printf "%s\\n" "$PI_DESK_TUNNEL_SERVER_KEY" '
            '"$PI_DESK_TUNNEL_IROH_RELAY_TOKEN" '
            '> "$TEST_STATE_DIR/server.env"\n'
            'if [[ -n "${TEST_EXIT_CODE:-}" ]]; then\n'
            '  exit "$TEST_EXIT_CODE"\n'
            'fi\n'
            "trap 'exit 0' TERM INT\n"
            "while :; do sleep 0.1; done\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": shell_path(self.bin) + ":" + subprocess.check_output(
                ["bash", "-c", 'printf "%s" "$PATH"'], text=True
            ),
            "PI_DESK_TUNNEL_DATA_DIR": shell_path(self.work / "data"),
            "TEST_STATE_DIR": shell_path(self.work),
        }
        for name in ("PI_DESK_TUNNEL_SERVER_KEY", "BASH_ENV", "ENV", "TEST_EXIT_CODE"):
            self.environment.pop(name, None)

    def tearDown(self):
        result = self._outcome.result
        succeeded = not any(test is self for test, _ in result.failures + result.errors)
        try:
            self.stop()
            self.assert_server_stopped()
        except Exception:
            succeeded = False
            raise
        finally:
            for log in self.logs:
                log.close()
            if succeeded:
                shutil.rmtree(self.work)
            else:
                print("容器入口测试失败现场：" + str(self.work))

    def start(self, key=None, ready=True):
        (self.work / "server.env").unlink(missing_ok=True)
        environment = {**self.environment}
        if key is not None:
            environment["PI_DESK_TUNNEL_SERVER_KEY"] = key
        log = (self.work / ("run-" + str(len(self.logs)) + ".log")).open("w+")
        self.logs.append(log)
        self.process = subprocess.Popen(
            ["bash", shell_path(ENTRY)],
            env=environment,
            stdout=log,
            stderr=log,
        )
        if ready:
            deadline = time.monotonic() + 10
            while not (self.work / "server.env").exists():
                if self.process.poll() is not None or time.monotonic() >= deadline:
                    self.fail("启动未就绪：" + self.output())
                time.sleep(0.02)

    def output(self):
        self.logs[-1].seek(0)
        return self.logs[-1].read()

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            subprocess.run(
                ["bash", "-c", 'kill -TERM "$1"', "bash",
                 (self.work / "server.pid").read_text().strip()],
                check=True,
            )
            self.process.wait(timeout=10)

    def assert_server_stopped(self):
        path = self.work / "server.pid"
        if path.exists():
            result = subprocess.run(
                ["bash", "-c", 'kill -0 "$1"', "bash", path.read_text().strip()],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0, "网关仍在运行")

    def test_generated_keys_are_distinct_persisted_and_reused(self):
        self.start()
        control = (self.work / "data/server-key").read_text().strip()
        relay = (self.work / "data/relay-token").read_text().strip()
        for key in (control, relay):
            self.assertRegex(key, r"^[a-f0-9]{64}$")
            self.assertNotIn(key, self.output())
        self.assertNotEqual(control, relay)
        if os.name != "nt":
            self.assertEqual((self.work / "data/server-key").stat().st_mode & 0o777, 0o600)
        self.stop()
        self.assertEqual(self.process.returncode, 0)
        self.assert_server_stopped()
        self.start()
        self.assertEqual(control, (self.work / "data/server-key").read_text().strip())
        self.assertEqual(relay, (self.work / "data/relay-token").read_text().strip())
        values = (self.work / "server.env").read_text().splitlines()
        self.assertEqual(values, [control, relay])

    def test_explicit_key_replaces_saved_key_and_survives_without_env(self):
        self.start()
        self.stop()
        supplied = "Ab09" * 16
        self.start(key=supplied)
        self.assertEqual((self.work / "data/server-key").read_text().strip(), supplied)
        self.assertNotIn(supplied, self.output())
        self.stop()
        self.start()
        self.assertEqual((self.work / "data/server-key").read_text().strip(), supplied)

    def test_invalid_supplied_or_saved_key_fails_without_starting_server(self):
        self.start()
        self.stop()
        original = (self.work / "data/server-key").read_bytes()
        for supplied in ("short", "z" * 64, "a" * 63 + " "):
            self.start(key=supplied, ready=False)
            self.assertNotEqual(self.process.wait(timeout=10), 0)
            self.assertEqual((self.work / "data/server-key").read_bytes(), original)
            self.assertFalse((self.work / "server.env").exists())
        (self.work / "data/server-key").write_text("corrupt")
        self.start(ready=False)
        self.assertNotEqual(self.process.wait(timeout=10), 0)
        self.assertEqual((self.work / "data/server-key").read_text(), "corrupt")

    def test_persistence_failure_does_not_start_with_an_unsaved_key(self):
        self.start()
        self.stop()
        original = (self.work / "data/server-key").read_bytes()
        (self.work / "data/server-key.tmp").mkdir()
        self.start(key="ef" * 32, ready=False)
        self.assertNotEqual(self.process.wait(timeout=10), 0)
        self.assertEqual((self.work / "data/server-key").read_bytes(), original)
        self.assertFalse((self.work / "server.env").exists())

    def test_key_destination_directory_is_not_treated_as_a_saved_key(self):
        (self.work / "data").mkdir()
        for name in ("server-key", "relay-token"):
            path = self.work / "data" / name
            path.mkdir()
            self.start(ready=False)
            self.assertNotEqual(self.process.wait(timeout=10), 0)
            self.assertTrue(path.is_dir())
            self.assertFalse((self.work / "server.env").exists())
            path.rmdir()

    def test_server_exit_status_is_preserved(self):
        self.environment["TEST_EXIT_CODE"] = "23"
        self.start(ready=False)
        self.assertEqual(self.process.wait(timeout=10), 23)


if __name__ == "__main__":
    unittest.main()
