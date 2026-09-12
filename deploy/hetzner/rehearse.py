#!/usr/bin/env python3
"""Manual Linux integration rehearsal with isolated Docker network/proxy only.

Usage: python3 rehearse.py EXISTING_AGENTTOLL_IMAGE REPORT.json
No production credentials, published ports, DNS edits or shared Caddy changes.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from autodeploy import Controller, DeployError, Host, recover_files


APP = """
const http = require('node:http');
const server = http.createServer((req, res) => {
  setTimeout(() => res.end(req.url === '/api/health' ? JSON.stringify({ok:true}) : process.env.REHEARSAL_BODY),
    req.url === '/slow' ? 1800 : 0);
});
server.listen(4021);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
"""


class RehearsalHost(Host):
    failure = None
    in_flight = None

    def still_eligible(self, release):
        # GitHub trust/selection is covered separately, without network fixtures.
        pass

    def probe_command(self, public, release, path="/"):
        target = self.config["caddy_container"] + ":8080" if public else release["container"] + ":4021"
        script = (f"require('node:http').get('http://{target}{path}', {{headers:{{Host:'agenttoll.app'}},signal:AbortSignal.timeout(10000)}},"
                  "res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{console.log(body);"
                  "process.exitCode=res.statusCode===200?0:1})}).on('error',()=>process.exit(1))")
        return ["docker", "run", "--rm", "--network", self.config["network"], "--read-only",
                "--cap-drop", "ALL", "--entrypoint", "node", release["image"], "-e", script]

    def check(self, release, public=False):
        result = self.command(self.probe_command(public, release))
        if result.stdout.decode().strip() != release["sha"]:
            raise DeployError("Wrong release actually served")
        if self.failure == ("public" if public else "candidate"):
            if public:
                self.in_flight = subprocess.Popen(self.probe_command(True, release, "/slow"),
                                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                time.sleep(0.6)
            raise DeployError("Injected unavailable API/proxy check")

    def reload(self, expected):
        if self.failure == "reload":
            self.failure = None
            raise DeployError("Injected reload failure after atomic snippet write")
        super().reload(expected)


def main():
    image, report_path = sys.argv[1:]
    nonce = str(os.getpid())
    names = {"old": "agenttoll-r-test-old-" + nonce, "new": "agenttoll-r-test-new-" + nonce}
    network, caddy = "agenttoll-rehearsal-" + nonce, "agenttoll-test-caddy-" + nonce
    checks = []
    with tempfile.TemporaryDirectory(prefix="agenttoll-rehearsal-") as temporary:
        root = Path(temporary)
        (root / "releases").mkdir()
        router = root / "router"
        router.mkdir()
        caddyfile = root / "Caddyfile"
        caddyfile.write_text("http://agenttoll.app:8080 {\n import /data/agenttoll/upstream.caddy\n}\n")
        snippet = router / "upstream.caddy"
        snippet.write_text("# BEGIN AGENTTOLL\nreverse_proxy " + names["old"] + ":4021\n# END AGENTTOLL\n")
        config = {"network": network, "caddy_container": caddy, "caddyfile": str(caddyfile),
                  "snippet_host": str(snippet), "snippet_container": "/data/agenttoll/upstream.caddy"}
        host = RehearsalHost(root, config)
        controller = Controller(root / "deployer/state", host)
        releases = {}
        try:
            host.command(["docker", "network", "create", network])
            for key, name in names.items():
                directory = root / "releases" / key
                directory.mkdir()
                release = {"sha": key, "container": name, "upstream": name + ":4021",
                           "image": image, "directory": str(directory), "attempt": key}
                releases[key] = release
                host.command(["docker", "run", "-d", "--name", name, "--network", network,
                              "--network-alias", name, "--env", "REHEARSAL_BODY=" + key,
                              "--read-only", "--cap-drop", "ALL", "--init", "--stop-timeout", "135",
                              "--health-interval=1s", "--health-start-period=0s", "--entrypoint", "node",
                              image, "-e", APP])
                host.start(release)
            host.command(["docker", "run", "-d", "--name", caddy, "--network", network,
                          "--mount", f"type=bind,src={caddyfile},dst=/etc/caddy/Caddyfile,readonly",
                          "--mount", f"type=bind,src={router},dst=/data/agenttoll", "caddy:2"])
            time.sleep(2)
            controller.write("current", releases["old"])
            host.activate(releases["old"])
            host.check(releases["old"], public=True)
            shared_before = caddyfile.read_bytes()

            for failure in ("candidate", "reload", "public"):
                host.failure = failure
                try:
                    controller.deploy(releases["new"])
                    raise AssertionError("Failure unexpectedly promoted candidate")
                except DeployError:
                    pass
                host.failure = None
                host.check(releases["old"], public=True)
                assert controller.read("current")["sha"] == "old"
                assert not host.inspect(releases["new"])["State"]["Running"]
                assert caddyfile.read_bytes() == shared_before
                checks.append({"name": failure + " failure restores actual old HTTP service", "ok": True})
                if host.in_flight:
                    stdout, stderr = host.in_flight.communicate(timeout=15)
                    assert host.in_flight.returncode == 0 and stdout.strip() == b"new", (stdout, stderr)
                    checks.append({"name": "in-flight request completes while failed candidate drains", "ok": True})
                    host.in_flight = None

            # Kill an actual controller child after durable journal + live switch.
            pid = os.fork()
            if pid == 0:
                controller.write("pending", {"previous": releases["old"], "candidate": releases["new"]})
                host.start(releases["new"])
                host.promote(releases["old"], releases["new"])
                os.kill(os.getpid(), 9)
            _, status = os.waitpid(pid, 0)
            assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == 9
            recover_files(root, config)
            controller.recover()
            host.check(releases["old"], public=True)
            checks.append({"name": "SIGKILL after switch and boot file recovery restores old service", "ok": True})

            controller.deploy(releases["new"])
            host.check(releases["new"], public=True)
            assert not host.inspect(releases["old"])["State"]["Running"]
            assert controller.read("current")["sha"] == "new"
            assert (root / "current").resolve() == Path(releases["new"]["directory"])
            assert caddyfile.read_bytes() == shared_before
            checks.append({"name": "successful release actually serves new HTTP and preserves shared file", "ok": True})
        finally:
            host.command(["docker", "rm", "-f", "-v", caddy, *names.values()], check=False)
            host.command(["docker", "network", "rm", network], check=False)
    report = {"ok": True, "checks": checks, "scope": "Isolated Docker processes and proxy; no production credentials or payments"}
    Path(report_path).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
