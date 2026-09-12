#!/usr/bin/env python3
"""Public GitHub -> staged Docker -> Caddy. No third-party Python dependencies.

Install this operator-owned program separately; releases never execute a copy
of it from the fetched repository. All probes are unsigned and have no wallet.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = "tevfikefeaydin/agenttoll"
WORKFLOW = ".github/workflows/consistency.yml"
RELEASE_INPUTS = ["Dockerfile", ".dockerignore", "compose.yaml", "package.json",
                  "package-lock.json", "tsconfig.json", "tsconfig.tests.json",
                  "vercel.json", "src", "web", "public", "scripts", "mcp", "tests",
                  WORKFLOW, "deploy/hetzner/autodeploy.py",
                  "deploy/hetzner/test_autodeploy.py", "deploy/hetzner/verify-proxy.mjs"]
RECIPIENT = "0xe55359021a6a22d8385b827405991c56075f56f8"


class DeployError(RuntimeError):
    pass


def select_run(runs, wanted_fingerprint, fingerprint, is_ancestor):
    """An old success must never hide a newer failed or pending attempt."""
    seen = set()
    for run in sorted(runs, key=lambda r: (r.get("run_number", 0), r.get("run_attempt", 0)), reverse=True):
        sha = run.get("head_sha", "")
        if (not re.fullmatch(r"[a-f0-9]{40}", sha) or run.get("head_branch") != "main"
                or run.get("event") not in ("push", "workflow_dispatch")
                or run.get("path") != WORKFLOW
                or (run.get("head_repository") or {}).get("full_name") != REPO):
            continue
        if sha in seen:
            continue
        seen.add(sha)
        if (run.get("status") == "completed" and run.get("conclusion") == "success"
                and is_ancestor(sha) and fingerprint(sha) == wanted_fingerprint):
            return run
    return None


def rewrite_upstream(content, expected, replacement):
    for value in (expected, replacement):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*:4021", value):
            raise DeployError("Invalid upstream")
    begin, end = b"# BEGIN AGENTTOLL", b"# END AGENTTOLL"
    if content.count(begin) != 1 or content.count(end) != 1:
        raise DeployError("Missing or ambiguous AgentToll markers")
    start, finish = content.index(begin), content.index(end)
    if finish <= start:
        raise DeployError("Invalid AgentToll marker order")
    block = content[start:finish]
    pattern = rb"(?m)^(\s*reverse_proxy\s+)" + re.escape(expected.encode()) + rb"(?=\s|$)"
    block, count = re.subn(pattern, lambda m: m[1] + replacement.encode(), block)
    if count != 1 or len(re.findall(rb"(?m)^\s*reverse_proxy\s+", block)) != 1:
        raise DeployError("AgentToll upstream changed or is ambiguous")
    return content[:start] + block + content[finish:]


def sync_directory(path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def active_upstreams(configuration):
    found = []

    def walk(value, agenttoll=False):
        if isinstance(value, dict):
            matchers = value.get("match", [])
            if isinstance(matchers, list):
                agenttoll = agenttoll or any(isinstance(matcher, dict) and
                    "agenttoll.app" in (matcher.get("host") or []) for matcher in matchers)
            if agenttoll and value.get("handler") == "reverse_proxy":
                found.extend(item.get("dial") for item in value.get("upstreams", []))
            for child in value.values():
                walk(child, agenttoll)
        elif isinstance(value, list):
            for child in value:
                walk(child, agenttoll)

    walk(configuration.get("apps", {}).get("http", {}).get("servers", {}))
    return found


def atomic_write(path, content, mode=0o600):
    """Same filesystem rename: the file is always entirely old or entirely new."""
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".agenttoll-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Controller:
    def __init__(self, state_dir, host):
        self.directory = Path(state_dir)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.host = host

    def read(self, name):
        path = self.directory / (name + ".json")
        return json.loads(path.read_text()) if path.exists() else None

    def write(self, name, data):
        atomic_write(self.directory / (name + ".json"), json.dumps(data, indent=2).encode() + b"\n")

    def remove(self, name):
        (self.directory / (name + ".json")).unlink(missing_ok=True)
        sync_directory(self.directory)

    def recover(self):
        pending = self.read("pending")
        if not pending:
            self.finish_cleanup()
            return
        previous, candidate = pending["previous"], pending["candidate"]
        # Do not stop either process if restoring routing fails.
        self.host.restore(previous, candidate)
        self.host.activate(previous)
        self.write("current", previous)
        self.remove("cleanup")
        self.write("failed", {"attempt": candidate["attempt"], "sha": candidate["sha"],
                              "reason": "Unsuccessful or interrupted deployment"})
        self.host.stop(candidate)
        self.remove("pending")

    def finish_cleanup(self):
        previous = self.read("cleanup")
        if previous:
            try:
                self.host.stop(previous)
                self.remove("cleanup")
            except Exception as error:
                print(f"Validated release remains active; old-container cleanup will retry: {error}", flush=True)

    def rollback(self):
        if self.read("pending"):
            self.recover()
            return
        previous, current = self.read("previous"), self.read("current")
        if not previous or not current:
            raise DeployError("No previous release recorded")
        if previous["container"] == current["container"]:
            return  # Repeated rollback must never stop the already-restored app.
        self.write("pending", {"previous": previous, "candidate": current})
        self.recover()

    def deploy(self, candidate):
        self.recover()
        if self.read("cleanup"):
            raise DeployError("Previous container cleanup is pending; defer new deployment")
        previous = self.read("current")
        if not previous:
            raise DeployError("Bootstrap current release before activating automation")
        self.write("pending", {"previous": previous, "candidate": candidate})
        try:
            self.host.start(candidate)
            self.host.check(candidate)
            self.host.still_eligible(candidate)
            self.host.promote(previous, candidate)
            self.host.check(candidate, public=True)
            self.host.activate(candidate)
            self.write("previous", previous)
            self.write("current", candidate)
            self.write("cleanup", previous)
            self.remove("pending")
        except Exception:
            self.recover()
            raise
        # Success is durable before SIGTERM, including for an in-flight payment.
        self.remove("failed")
        self.finish_cleanup()


class Host:
    def __init__(self, root, config):
        self.root, self.config = Path(root), config
        self.repository = self.root / "repository.git"
        self.snippet = Path(config["snippet_host"])
        self.caddyfile = Path(config["caddyfile"])

    def command(self, args, *, input=None, timeout=120, output=None, check=True):
        result = subprocess.run(args, input=input, stdout=output or subprocess.PIPE,
                                stderr=subprocess.STDOUT if output else subprocess.PIPE, timeout=timeout,
                                env={**os.environ, "GIT_TERMINAL_PROMPT": "0",
                                     "DOCKER_CONFIG": str(self.root / "deployer/docker"),
                                     "BUILDX_CONFIG": str(self.root / "deployer/buildx")})
        if check and result.returncode:
            # Arguments/environment may include secrets in future; never dump them.
            raise DeployError(f"{args[0]} exited {result.returncode}; "
                              f"{(result.stderr or b'See release report/build log').decode(errors='replace')[-600:]}")
        return result

    def git(self, *args, **kwargs):
        return self.command(["git", f"--git-dir={self.repository}", *args], **kwargs)

    def fetch(self):
        if not self.repository.exists():
            self.command(["git", "init", "--bare", str(self.repository)])
        self.git("fetch", "--no-tags", f"https://github.com/{REPO}.git",
                 "+refs/heads/main:refs/heads/main", timeout=180)
        return self.git("rev-parse", "refs/heads/main").stdout.decode().strip()

    def fingerprint(self, sha):
        result = self.git("ls-tree", "-r", "--full-tree", sha, "--", *RELEASE_INPUTS)
        return hashlib.sha256(result.stdout).hexdigest()

    def is_ancestor(self, sha):
        return self.git("merge-base", "--is-ancestor", sha, "refs/heads/main", check=False).returncode == 0

    def workflow_trusted(self, sha):
        blob = self.git("rev-parse", f"{sha}:{WORKFLOW}").stdout.decode().strip()
        if blob != self.config["workflow_blob"]:
            raise DeployError("CI workflow changed: operator must review and update workflow_blob")
        context = self.git("rev-parse", f"{sha}:.dockerignore").stdout.decode().strip()
        if context != self.config["build_context_blob"]:
            raise DeployError("Build context changed: review RELEASE_INPUTS and update build_context_blob")

    def runs(self):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{REPO}/actions/workflows/consistency.yml/runs?branch=main&per_page=30",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "AgentToll-Hetzner-Deploy/1",
                     "X-GitHub-Api-Version": "2022-11-28"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)
        if not isinstance(data.get("workflow_runs"), list):
            raise DeployError("Invalid workflow response")
        return data["workflow_runs"]

    def eligible(self, head):
        self.workflow_trusted(head)
        return select_run(self.runs(), self.fingerprint(head), self.fingerprint, self.is_ancestor)

    def still_eligible(self, release):
        head = self.fetch()
        run = self.eligible(head)
        if (not run or run["head_sha"] != release["sha"]
                or f'{run["id"]}:{run.get("run_attempt", 1)}' != release["attempt"]):
            raise DeployError("Main or its successful CI attempt changed before promotion")

    def prepare(self, run):
        if shutil.disk_usage(self.root).free < 5 * 1024 ** 3:
            raise DeployError("Less than 5 GiB free; current release kept, build paused")
        sha = run["head_sha"]
        tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + sha[:12]
        directory = self.root / "releases" / tag
        directory.mkdir(mode=0o700)
        archive = directory / "source.tar"
        with archive.open("wb") as stream:
            self.git("archive", "--format=tar", sha, output=stream)
        with tarfile.open(archive) as source:
            source.extractall(directory, filter="data")
        archive.unlink()
        atomic_write(directory / ".agenttoll-owned.json", json.dumps({"owner": "autodeploy-v1", "sha": sha}).encode())
        image = "agenttoll:" + tag
        with (directory / "build.log").open("wb") as stream:
            self.command(["docker", "buildx", "build", "--builder", self.config["builder"],
                          "--load", "--progress=plain", "--tag", image,
                          "--label", "com.agenttoll.managed=autodeploy",
                          "--label", f"org.opencontainers.image.revision={sha}", str(directory)],
                         timeout=900, output=stream)
        name = "agenttoll-r-" + tag.lower()
        release = {"sha": sha, "container": name, "upstream": name + ":4021", "image": image,
                   "directory": str(directory), "fingerprint": self.fingerprint(sha),
                   "attempt": f'{run["id"]}:{run.get("run_attempt", 1)}',
                   "ci_url": run.get("html_url"), "created_at": datetime.now(timezone.utc).isoformat()}
        release["image_id"] = self.command(["docker", "image", "inspect", image, "--format", "{{.Id}}"]
                                          ).stdout.decode().strip()
        atomic_write(directory / "release.json", json.dumps(release, indent=2).encode())
        return release

    def inspect(self, release):
        result = self.command(["docker", "inspect", release["container"]], check=False)
        return json.loads(result.stdout)[0] if result.returncode == 0 else None

    def start(self, release):
        name = release["container"]
        existing = self.inspect(release)
        if existing:
            if (release.get("image_id") and existing["Image"] != release["image_id"]):
                raise DeployError("Existing container image ID differs from recorded release")
            if not release.get("image_id") and existing["Config"]["Image"] != release["image"]:
                raise DeployError("Existing container image differs from recorded release")
            self.command(["docker", "start", name])
        else:
            if not re.fullmatch(r"agenttoll-r-[a-z0-9-]+", name):
                raise DeployError("Unexpected candidate container name")
            self.command(["docker", "run", "-d", "--name", name, "--network", self.config["network"],
                          "--network-alias", name, "--env-file", str(self.root / "shared/runtime.env"),
                          "--env", "NODE_ENV=production", "--env", "PORT=4021",
                          "--env", "PUBLIC_URL=https://agenttoll.app", "--env", f"ADDRESS={RECIPIENT}",
                          "--env", "NETWORK=base", "--env", "TRUST_PROXY=1", "--init",
                          "--restart", "unless-stopped", "--stop-timeout", "135", "--read-only",
                          "--tmpfs", "/tmp:size=64m,mode=1777", "--cap-drop", "ALL",
                          "--security-opt", "no-new-privileges:true", "--memory", "768m", "--cpus", "1",
                          "--pids-limit", "128", "--log-driver", "local", "--log-opt", "max-size=10m",
                          "--log-opt", "max-file=3", "--label", "com.agenttoll.managed=autodeploy",
                          "--label", f"org.opencontainers.image.revision={release['sha']}",
                          release.get("image_id", release["image"])])
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            info = self.inspect(release)
            if info and info["State"].get("Health", {}).get("Status") == "healthy":
                if name.startswith("agenttoll-r-"):
                    self.verify_alias(release, info)
                return
            if not info or not info["State"]["Running"]:
                break
            time.sleep(2)
        raise DeployError("Candidate did not become healthy")

    def verify_alias(self, release, info):
        name = release["container"]
        aliases = info["NetworkSettings"]["Networks"][self.config["network"]].get("Aliases", []) or []
        if name not in aliases or "agenttoll-api" in aliases or info["HostConfig"].get("PortBindings"):
            raise DeployError("Candidate must have only private, unique routing")
        if release.get("image_id") and (info["Image"] != release["image_id"] or
                info["Config"].get("Labels", {}).get("org.opencontainers.image.revision") != release["sha"]):
            raise DeployError("Candidate immutable image identity does not match release")
        network = json.loads(self.command(["docker", "network", "inspect", self.config["network"]]).stdout)[0]
        identifiers = list(network.get("Containers", {}))
        peers = json.loads(self.command(["docker", "inspect", *identifiers]).stdout)
        matching = [peer["Id"] for peer in peers if name in
                    (peer["NetworkSettings"]["Networks"][self.config["network"]].get("Aliases", []) or [])]
        if matching != [info["Id"]]:
            raise DeployError("Candidate network alias is not unique")

    def check(self, release, public=False):
        # A separate checker has no runtime env/keys. For staging it shares ONLY
        # the candidate's network namespace, dialing loopback with canonical Host.
        command = ["docker", "run", "--rm", "-i", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--memory", "256m", "--cpus", "0.5"]
        if public:
            command += ["--add-host", f"agenttoll.app:{self.config['ip']}"]
        else:
            command += ["--network", "container:" + release["container"]]
        script = ""
        if not public:
            script = """
import http from 'node:http';
globalThis.fetch = (input, options = {}) => {
  const request = new Request(input, options);
  const url = new URL(request.url);
  if (url.origin !== 'https://agenttoll.app') throw new Error('Unexpected probe origin');
  if (request.method !== 'GET') throw new Error('Only unsigned GET probes are allowed');
  const headers = new Headers(request.headers);
  headers.set('Host', 'agenttoll.app'); headers.set('X-Forwarded-Proto', 'https');
  // Node fetch intentionally ignores an explicit Host header. Native HTTP
  // preserves it while dialing only the candidate's private loopback socket.
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1', port:4021, path:url.pathname + url.search,
      method:'GET', headers:Object.fromEntries(headers), signal:request.signal}, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for(let i=0;i<res.rawHeaders.length;i+=2) responseHeaders.append(res.rawHeaders[i],res.rawHeaders[i+1]);
        resolve(new Response(Buffer.concat(chunks), {status:res.statusCode, headers:responseHeaders}));
      });
    });
    req.on('error', reject); req.end();
  });
};
"""
        script += f"""
import {{checkService}} from './dist/operations-check.js';
const report = await checkService({{baseUrl:'https://agenttoll.app', network:'base', recipient:'{RECIPIENT}'}});
report.transport = {json.dumps('public-https' if public else 'candidate-network-loopback')};
console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
"""
        directory = Path(release["directory"])
        with (directory / ("public-api.json" if public else "candidate-api.json")).open("wb") as stream:
            self.command(command + ["--entrypoint", "node", release.get("image_id", release["image"]), "--input-type=module"],
                         input=script.encode(), timeout=90, output=stream)
        if public:
            with (directory / "public-proxy.json").open("wb") as stream:
                self.command(["docker", "run", "--rm", "--read-only", "--cap-drop", "ALL",
                              "--security-opt", "no-new-privileges:true", "--memory", "256m", "--cpus", "0.5",
                              "--mount", f"type=bind,src={directory}/deploy/hetzner/verify-proxy.mjs,dst=/app/deploy/hetzner/verify-proxy.mjs,readonly",
                              "--mount", f"type=bind,src={directory}/vercel.json,dst=/app/vercel.json,readonly",
                              "--entrypoint", "node", release.get("image_id", release["image"]), "/app/deploy/hetzner/verify-proxy.mjs",
                              self.config["ip"]], timeout=180, output=stream)

    def caddy(self, *args, **kwargs):
        return self.command(["docker", "exec", "-i", self.config["caddy_container"], *args], **kwargs)

    def promote(self, previous, candidate):
        before, inode = self.caddyfile.read_bytes(), self.caddyfile.stat().st_ino
        current = self.snippet.read_bytes()
        replacement = rewrite_upstream(current, previous["upstream"], candidate["upstream"])
        directive = ("import " + self.config["snippet_container"]).encode()
        if before.count(directive) != 1:
            raise DeployError("Expected exactly one AgentToll upstream import")
        full_candidate = before.replace(directive, replacement)
        self.caddy("sh", "-c", "umask 077; cat > /tmp/agenttoll-validate.Caddyfile; "
                   "caddy validate --adapter caddyfile --config /tmp/agenttoll-validate.Caddyfile",
                   input=full_candidate)
        if (self.caddyfile.stat().st_ino != inode or self.caddyfile.read_bytes() != before
                or self.snippet.read_bytes() != current):
            raise DeployError("Concurrent proxy edit; refusing to overwrite it")
        atomic_write(self.snippet, replacement)
        self.reload(candidate["upstream"])

    def reload(self, expected):
        self.caddy("caddy", "reload", "--adapter", "caddyfile", "--config", "/etc/caddy/Caddyfile")
        active = self.caddy("wget", "-qO-", "http://127.0.0.1:2019/config/").stdout
        configuration = json.loads(active)
        # Assert the active HTTP route, not just the file written to disk.
        if active_upstreams(configuration) != [expected]:
            raise DeployError("Active Caddy route does not match candidate")

    def restore(self, previous, candidate):
        self.start(previous)
        content = self.snippet.read_bytes()
        # Both paths validate and reload, covering a crash between file and reload.
        try:
            rewrite_upstream(content, candidate["upstream"], previous["upstream"])
            self.promote(candidate, previous)
        except DeployError as error:
            try:
                rewrite_upstream(content, previous["upstream"], previous["upstream"])
            except DeployError:
                raise error
            self.promote(previous, previous)

    def activate(self, release):
        directory = Path(release["directory"]).resolve()
        if directory.parent != (self.root / "releases").resolve() or not directory.is_dir():
            raise DeployError("Release directory is outside managed releases")
        temporary = self.root / ".current-next"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(directory, target_is_directory=True)
        os.replace(temporary, self.root / "current")
        sync_directory(self.root)

    def stop(self, release):
        name = release["container"]
        if name != "agenttoll-agenttoll-1" and not re.fullmatch(r"agenttoll-r-[a-z0-9-]+", name):
            raise DeployError("Refusing to stop an unrelated container")
        info = self.inspect(release)
        if info and info["State"]["Running"]:
            self.command(["docker", "stop", "--time", "135", name], timeout=150)

    def prune_releases(self, protected):
        """Keep three recent owned releases plus every live/rollback transaction."""
        parent = (self.root / "releases").resolve()
        owned = []
        for path in parent.iterdir():
            marker = path / ".agenttoll-owned.json"
            if (path.is_symlink() or not path.is_dir() or path.resolve().parent != parent
                    or not re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{12}", path.name) or not marker.is_file()):
                continue
            identity = json.loads(marker.read_text())
            if identity.get("owner") == "autodeploy-v1" and re.fullmatch(r"[a-f0-9]{40}", identity.get("sha", "")):
                owned.append(path)
        keep = {Path(item["directory"]).resolve() for item in protected if item}
        keep.update(sorted(owned, reverse=True)[:3])
        for path in owned:
            if path in keep:
                continue
            release_file = path / "release.json"
            release = json.loads(release_file.read_text()) if release_file.exists() else None
            if release:
                info = self.inspect(release)
                if info:
                    labels = info["Config"].get("Labels", {}) or {}
                    if (info["State"]["Running"] or labels.get("com.agenttoll.managed") != "autodeploy"
                            or info["Image"] != release.get("image_id")
                            or labels.get("org.opencontainers.image.revision") != release.get("sha")):
                        continue
                    self.command(["docker", "rm", release["container"]])
                # Remove only this owned tag if it still names the recorded bits.
                image = self.command(["docker", "image", "inspect", release["image"]], check=False)
                if image.returncode == 0:
                    metadata = json.loads(image.stdout)[0]
                    if (metadata["Id"] != release.get("image_id") or
                            (metadata["Config"].get("Labels", {}) or {}).get("com.agenttoll.managed") != "autodeploy"):
                        continue
                    self.command(["docker", "image", "rm", release["image"]])
            # Validated direct child, with an operator-created ownership marker.
            shutil.rmtree(path)


def upstream_snippet(upstream):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*:4021", upstream):
        raise DeployError("Invalid recorded upstream")
    return ("# BEGIN AGENTTOLL\nreverse_proxy " + upstream + " {\n"
            "    transport http {\n        dial_timeout 5s\n        response_header_timeout 130s\n"
            "    }\n}\n# END AGENTTOLL\n").encode()


def recover_files(root, config):
    """Runs before Docker on boot: never needs a container or external network."""
    state = Controller(Path(root) / "deployer/state", None)
    bootstrap = state.read("bootstrap")
    if bootstrap:
        target = Path(config["caddyfile"])
        # In-place once, because the existing Caddy bind mount pins this inode.
        with target.open("wb") as stream:
            stream.write(bytes.fromhex(bootstrap["caddyfile_hex"]))
            stream.flush()
            os.fsync(stream.fileno())
        state.remove("bootstrap")
    try:
        pending = state.read("pending")
        if pending and (not isinstance(pending, dict) or not isinstance(pending.get("previous"), dict)
                        or not isinstance(pending.get("candidate"), dict)):
            raise ValueError("Invalid pending record")
    except (ValueError, TypeError):
        corrupt = state.directory / ("pending.corrupt-" + str(time.time_ns()) + ".json")
        os.replace(state.directory / "pending.json", corrupt)
        sync_directory(state.directory)
        print("Corrupt transaction quarantined; restoring recorded current route", flush=True)
        pending = None
    snippet = Path(config["snippet_host"])
    try:
        safe = pending["previous"] if pending else state.read("current")
        content = upstream_snippet(safe["upstream"])
    except (ValueError, TypeError, KeyError, DeployError):
        atomic_write(snippet, b'# BEGIN AGENTTOLL\nrespond "AgentToll recovery pending" 503\n# END AGENTTOLL\n')
        raise DeployError("No valid release state; AgentToll returns 503, shared Docker remains independent")
    atomic_write(snippet, content)


def main():
    import fcntl  # Linux-only process lock; pure safety tests also run on Windows.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="/opt/agenttoll")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--retry", action="store_true")
    action.add_argument("--rollback", action="store_true")
    action.add_argument("--recover-files", action="store_true")
    action.add_argument("--status", action="store_true")
    args = parser.parse_args()
    root = Path(args.root)
    with (root / "deployer/deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        config = json.loads((root / "deployer/config.json").read_text())
        if args.recover_files:
            recover_files(root, config)
            return
        host = Host(root, config)
        controller = Controller(root / "deployer/state", host)
        if args.status:
            print(json.dumps({name: controller.read(name) for name in ("current", "previous", "pending", "cleanup", "failed", "observed")}, indent=2))
            return
        if args.rollback:
            controller.rollback()
            print("Previous release restored; failed attempt held until new CI or --retry", flush=True)
            return
        controller.recover()
        if controller.read("cleanup"):
            print("Waiting for previous container cleanup before another release", flush=True)
            return
        try:
            host.prune_releases([controller.read(name) for name in ("current", "previous", "cleanup")])
        except Exception as error:
            print(f"Scoped old-release cleanup deferred: {error}", flush=True)
        head = host.fetch()
        fingerprint = host.fingerprint(head)
        controller.write("observed", {"sha": head, "checked_at": datetime.now(timezone.utc).isoformat()})
        if (controller.read("current") or {}).get("fingerprint") == fingerprint:
            print("Main release inputs unchanged; current container kept", flush=True)
            return
        run = host.eligible(head)
        if not run:
            print("Waiting for successful main CI matching current release inputs", flush=True)
            return
        attempt = f'{run["id"]}:{run.get("run_attempt", 1)}'
        if (controller.read("failed") or {}).get("attempt") == attempt and not args.retry:
            print("Failed deployment attempt held; rerun CI or use --retry after investigation", flush=True)
            return
        print(f"Building CI-approved {run['head_sha']} ({attempt})", flush=True)
        try:
            release = host.prepare(run)
            controller.deploy(release)
        except Exception:
            controller.write("failed", {"sha": run["head_sha"], "attempt": attempt,
                                        "reason": "Deployment failed; inspect service journal and release reports"})
            raise
        print(f"Deployed {release['sha']} from {release['ci_url']}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except BlockingIOError:
        print("Another AgentToll deployment/check holds the lock; skipping", flush=True)
    except Exception as error:
        print(f"AgentToll deployment paused: {error}", flush=True)
        raise SystemExit(1)
