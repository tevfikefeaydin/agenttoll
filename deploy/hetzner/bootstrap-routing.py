#!/usr/bin/env python3
"""Operator-only, one-time import bootstrap after config/state/recovery installation."""
import fcntl
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from autodeploy import Controller, DeployError, Host, atomic_write, upstream_snippet


def main():
    root = Path("/opt/agenttoll")
    with (root / "deployer/deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        host = Host(root, json.loads((root / "deployer/config.json").read_text()))
        state = Controller(root / "deployer/state", host)
        current = state.read("current")
        if state.read("pending") or state.read("bootstrap"):
            raise DeployError("Recover existing transaction before bootstrap")
        before, inode = host.caddyfile.read_bytes(), host.caddyfile.stat().st_ino
        directive = ("import " + host.config["snippet_container"]).encode()
        if directive in before:
            host.reload(current["upstream"])
            print("Routing import already installed and active")
            return
        block = re.search(rb"(?s)# BEGIN AGENTTOLL.*?# END AGENTTOLL", before)
        if not block or before.count(b"# BEGIN AGENTTOLL") != 1:
            raise DeployError("Expected a unique existing AgentToll block")
        pattern = (rb"(?m)^[ \t]*reverse_proxy " + re.escape(current["upstream"].encode()) +
                   rb"\s*\{\s*transport http\s*\{\s*dial_timeout 5s\s*response_header_timeout 130s\s*\}\s*\}")
        changed, count = re.subn(pattern, b"    " + directive, block[0])
        if count != 1:
            raise DeployError("Unexpected inline proxy; inspect before editing")
        candidate = before[:block.start()] + changed + before[block.end():]
        atomic_write(host.snippet, upstream_snippet(current["upstream"]))
        host.caddy("sh", "-c", "umask 077; cat > /tmp/agenttoll-bootstrap.Caddyfile; "
                   "caddy validate --adapter caddyfile --config /tmp/agenttoll-bootstrap.Caddyfile", input=candidate)
        if host.caddyfile.read_bytes() != before or host.caddyfile.stat().st_ino != inode:
            raise DeployError("Concurrent shared Caddy edit")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = root / "deployer" / ("Caddyfile.before-autodeploy-" + stamp)
        atomic_write(backup, before)
        state.write("bootstrap", {"caddyfile_hex": before.hex(), "backup": str(backup)})

        def in_place(content):
            with host.caddyfile.open("wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())

        try:
            in_place(candidate)
            host.reload(current["upstream"])
            host.check(current, public=True)
        except Exception:
            if host.caddyfile.read_bytes() == candidate:
                in_place(before)
                host.reload(current["upstream"])
                state.remove("bootstrap")
            raise
        state.remove("bootstrap")
        report = {"ok": True, "at": stamp, "upstream": current["upstream"],
                  "shared_inode_preserved": host.caddyfile.stat().st_ino == inode,
                  "before_sha256": hashlib.sha256(before).hexdigest(),
                  "after_sha256": hashlib.sha256(candidate).hexdigest(), "backup": str(backup)}
        atomic_write(root / "deployer/rehearsals/bootstrap.json", json.dumps(report, indent=2).encode())
        print(json.dumps(report))


if __name__ == "__main__":
    main()
