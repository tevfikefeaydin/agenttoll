"""Offline safety regressions. Docker/GitHub are replaced only at the boundary."""
import copy
import tempfile
import unittest
import json
import subprocess
from unittest.mock import patch
from pathlib import Path

import autodeploy as deploy


SHA = "a" * 40
OLD = {"sha": "b" * 40, "container": "old", "upstream": "old:4021", "attempt": "old"}
NEW = {"sha": SHA, "container": "new", "upstream": "new:4021", "attempt": "123:1"}
CONFIG = b"other.example {\n reverse_proxy unrelated:8080\n}\n# BEGIN AGENTTOLL\nagenttoll.app {\n reverse_proxy old:4021 {\n  transport http {}\n }\n}\n# END AGENTTOLL\n"


def run(**changes):
    result = {"id": 123, "run_number": 8, "run_attempt": 1,
              "head_sha": SHA, "head_branch": "main", "event": "push",
              "path": ".github/workflows/consistency.yml", "status": "completed",
              "conclusion": "success", "head_repository": {"full_name": deploy.REPO}}
    result.update(changes)
    return result


class SelectionTests(unittest.TestCase):
    def select(self, runs, ancestor=True, fingerprint="same"):
        return deploy.select_run(runs, "same", lambda sha: fingerprint, lambda sha: ancestor)

    def test_successful_main_run_is_eligible(self):
        self.assertEqual(self.select([run()])["head_sha"], SHA)

    def test_pending_failed_pr_fork_wrong_workflow_and_malformed_sha_never_deploy(self):
        for change in [{"status": "in_progress"}, {"conclusion": "failure"},
                       {"event": "pull_request"}, {"head_branch": "feature"},
                       {"head_repository": {"full_name": "attacker/agenttoll"}},
                       {"path": ".github/workflows/other.yml"}, {"head_sha": "--help"}]:
            with self.subTest(change=change):
                self.assertIsNone(self.select([run(**change)]))

    def test_old_code_and_force_pushed_away_commit_never_deploy(self):
        self.assertIsNone(self.select([run()], fingerprint="old-code"))
        self.assertIsNone(self.select([run()], ancestor=False))

    def test_failed_new_attempt_supersedes_old_success_for_same_commit(self):
        self.assertIsNone(self.select([run(run_attempt=1), run(run_attempt=2, conclusion="failure")]))

    def test_manual_ci_run_is_allowed_but_scheduled_payment_workflow_is_not(self):
        self.assertIsNotNone(self.select([run(event="workflow_dispatch")]))
        self.assertIsNone(self.select([run(event="schedule")]))


class ProxyTests(unittest.TestCase):
    def test_active_proxy_inspection_ignores_unrelated_non_route_match_fields(self):
        configuration = {"apps":{"http":{"servers":{"shared":{"routes":[
            {"match":[{"host":["other.example"]}], "handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"other:80"}]}]},
            {"match":"some non-route string", "handler":"rewrite"},
            {"match":[{"host":["agenttoll.app"]}], "handle":[{"handler":"subroute","routes":[
                {"match":[{"path":["/*"]}], "handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"candidate:4021"}]}]}
            ]}]}
        ]}}}}}
        self.assertEqual(deploy.active_upstreams(configuration), ["candidate:4021"])
    def test_only_agenttoll_upstream_changes_and_unrelated_bytes_survive(self):
        result = deploy.rewrite_upstream(CONFIG, "old:4021", "new:4021")
        self.assertEqual(result, CONFIG.replace(b"reverse_proxy old:4021", b"reverse_proxy new:4021"))

    def test_ambiguous_missing_or_concurrently_changed_upstream_is_rejected(self):
        for content in [CONFIG.replace(b"# END AGENTTOLL", b""), CONFIG + CONFIG,
                        CONFIG.replace(b"old:4021", b"external-change:4021")]:
            with self.subTest(content=content):
                with self.assertRaises(deploy.DeployError):
                    deploy.rewrite_upstream(content, "old:4021", "new:4021")

    def test_untrusted_upstream_cannot_inject_caddy_directives(self):
        with self.assertRaises(deploy.DeployError):
            deploy.rewrite_upstream(CONFIG, "old:4021", "new:4021\nrespond bad")


class FakeHost:
    """Models only remote process/HTTP boundaries; state persistence is real."""
    def __init__(self):
        self.config = CONFIG
        self.running = {"old"}
        self.fail = None
        self.activated = "old"
        self.public_observed = None

    def start(self, release):
        self.running.add(release["container"])

    def check(self, release, public=False):
        if public:
            self.public_observed = (copy.copy(self.running), self.config)
        if self.fail == ("public" if public else "candidate"):
            raise deploy.DeployError("unavailable response")

    def still_eligible(self, release):
        if self.fail == "stale":
            raise deploy.DeployError("main changed during build")

    def promote(self, previous, candidate):
        self.config = deploy.rewrite_upstream(self.config, previous["upstream"], candidate["upstream"])

    def restore(self, previous, candidate):
        self.running.add(previous["container"])
        if self.fail == "rollback":
            raise deploy.DeployError("proxy reload unavailable")
        if candidate["upstream"].encode() in self.config:
            self.config = deploy.rewrite_upstream(self.config, candidate["upstream"], previous["upstream"])
        elif previous["upstream"].encode() not in self.config:
            raise deploy.DeployError("operator changed AgentToll routing")

    def activate(self, release):
        self.activated = release["container"]

    def stop(self, release):
        if self.fail == "stop-old" and release["container"] == "old":
            raise deploy.DeployError("temporary Docker stop failure")
        self.running.discard(release["container"])


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.host = FakeHost()
        self.controller = deploy.Controller(Path(self.tmp.name), self.host)
        self.controller.write("current", OLD)

    def tearDown(self):
        self.tmp.cleanup()

    def test_success_keeps_old_running_until_public_checks_and_persists_previous(self):
        self.controller.deploy(NEW)
        running, config = self.host.public_observed
        self.assertEqual(running, {"old", "new"})
        self.assertIn(b"reverse_proxy new:4021", config)
        self.assertEqual(self.host.running, {"new"})
        self.assertEqual(self.controller.read("current"), NEW)
        self.assertEqual(self.controller.read("previous"), OLD)
        self.assertIsNone(self.controller.read("pending"))

    def test_candidate_failure_leaves_previous_serving_and_records_failed_attempt(self):
        self.host.fail = "candidate"
        with self.assertRaises(deploy.DeployError):
            self.controller.deploy(NEW)
        self.assertEqual(self.host.config, CONFIG)
        self.assertEqual(self.host.running, {"old"})
        self.assertEqual(self.controller.read("current"), OLD)
        self.assertEqual(self.controller.read("failed")["attempt"], "123:1")

    def test_post_switch_failure_restores_previous_without_reverting_other_sites(self):
        self.host.fail = "public"
        self.host.config += b"new-other.example { respond fine }\n"
        before = self.host.config
        with self.assertRaises(deploy.DeployError):
            self.controller.deploy(NEW)
        self.assertEqual(self.host.config, before)
        self.assertEqual(self.host.activated, "old")
        self.assertEqual(self.host.running, {"old"})

    def test_main_change_during_build_prevents_promotion(self):
        self.host.fail = "stale"
        with self.assertRaises(deploy.DeployError):
            self.controller.deploy(NEW)
        self.assertEqual(self.host.config, CONFIG)

    def test_interruption_after_switch_recovers_old_release_from_durable_journal(self):
        self.host.start(NEW)
        self.host.promote(OLD, NEW)
        self.controller.write("pending", {"previous": OLD, "candidate": NEW})
        self.controller.write("current", NEW)
        resumed = deploy.Controller(Path(self.tmp.name), self.host)
        resumed.recover()
        self.assertEqual(self.host.config, CONFIG)
        self.assertEqual(resumed.read("current"), OLD)
        self.assertEqual(self.host.running, {"old"})

    def test_failed_rollback_keeps_both_containers_and_journal_for_next_recovery(self):
        self.host.start(NEW)
        self.host.promote(OLD, NEW)
        self.controller.write("pending", {"previous": OLD, "candidate": NEW})
        self.host.fail = "rollback"
        with self.assertRaises(deploy.DeployError):
            self.controller.recover()
        self.assertEqual(self.host.running, {"old", "new"})
        self.assertIsNotNone(self.controller.read("pending"))

    def test_post_commit_stop_failure_keeps_success_and_retries_cleanup_next_tick(self):
        self.host.fail = "stop-old"
        self.controller.deploy(NEW)
        self.assertEqual(self.controller.read("current"), NEW)
        self.assertIsNone(self.controller.read("failed"))
        self.assertIsNone(self.controller.read("pending"))
        self.assertIsNotNone(self.controller.read("cleanup"))
        self.host.fail = None
        self.controller.recover()
        self.assertEqual(self.host.running, {"new"})
        self.assertIsNone(self.controller.read("cleanup"))

    def test_another_release_cannot_overwrite_unfinished_old_container_cleanup(self):
        self.host.fail = "stop-old"
        self.controller.deploy(NEW)
        third = {**NEW, "container":"third", "upstream":"third:4021", "attempt":"124:1"}
        with self.assertRaises(deploy.DeployError):
            self.controller.deploy(third)
        self.assertEqual(self.controller.read("cleanup"), OLD)
        self.assertIsNone(self.controller.read("pending"))
        self.assertNotIn("third", self.host.running)
        self.host.fail = None
        self.controller.deploy(third)
        self.assertEqual(self.controller.read("current"), third)

    def test_emergency_rollback_remains_available_while_old_cleanup_is_failing(self):
        self.host.fail = "stop-old"
        self.controller.deploy(NEW)
        self.controller.rollback()
        self.assertEqual(self.controller.read("current"), OLD)
        self.assertIsNone(self.controller.read("cleanup"))
        self.assertEqual(self.host.running, {"old"})
        self.assertEqual(self.host.config, CONFIG)
        self.controller.rollback()
        self.assertEqual(self.host.running, {"old"})


class FilesystemTests(unittest.TestCase):
    def test_retention_keeps_current_previous_recent_and_unowned_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = root / "releases"
            parent.mkdir()
            paths = []
            for day in range(1, 7):
                path = parent / f"2026090{day}T120000Z-aaaaaaaaaaaa"
                path.mkdir()
                (path / ".agenttoll-owned.json").write_text(json.dumps({"owner":"autodeploy-v1", "sha":SHA}))
                paths.append(path)
            foreign = parent / "operator-backup"
            foreign.mkdir()
            host = deploy.Host(root, {"snippet_host":str(root / "snippet"), "caddyfile":str(root / "Caddyfile")})
            host.prune_releases([{"directory":str(paths[0])}, {"directory":str(paths[1])}])
            self.assertTrue(paths[0].exists())
            self.assertTrue(paths[1].exists())
            self.assertFalse(paths[2].exists())
            self.assertTrue(all(path.exists() for path in paths[3:]))
            self.assertTrue(foreign.exists())

    def test_mutated_image_tag_cannot_replace_recorded_container_bits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host = deploy.Host(root, {"snippet_host":str(root / "snippet"), "caddyfile":str(root / "Caddyfile")})
            release = {**NEW, "image":"agenttoll:release", "image_id":"sha256:expected"}
            with patch.object(host, "inspect", return_value={"Image":"sha256:different"}):
                with self.assertRaises(deploy.DeployError):
                    host.start(release)
    def test_interrupted_atomic_write_keeps_old_routing_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            snippet = Path(temporary) / "upstream.caddy"
            snippet.write_bytes(CONFIG)
            with patch.object(deploy.os, "replace", side_effect=OSError("power loss before rename")):
                with self.assertRaises(OSError):
                    deploy.atomic_write(snippet, b"new complete config")
            self.assertEqual(snippet.read_bytes(), CONFIG)
            self.assertEqual(list(Path(temporary).iterdir()), [snippet])

    def test_boot_recovery_restores_proxy_before_docker_is_available(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet = root / "upstream.caddy"
            snippet.write_bytes(CONFIG.replace(b"old:4021", b"new:4021"))
            controller = deploy.Controller(root / "deployer/state", None)
            controller.write("pending", {"previous": OLD, "candidate": NEW})
            deploy.recover_files(root, {"snippet_host": str(snippet)})
            self.assertIn(b"reverse_proxy old:4021", snippet.read_bytes())
            # Docker recovery still needs this journal to drain the candidate.
            self.assertIsNotNone(controller.read("pending"))
            deploy.recover_files(root, {"snippet_host": str(snippet)})
            self.assertIn(b"reverse_proxy old:4021", snippet.read_bytes())

    def test_boot_rebuilds_missing_snippet_and_quarantines_broken_pending(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet = root / "upstream.caddy"
            controller = deploy.Controller(root / "deployer/state", None)
            controller.write("current", OLD)
            (controller.directory / "pending.json").write_text('{"previous":')
            deploy.recover_files(root, {"snippet_host": str(snippet)})
            self.assertIn(b"reverse_proxy old:4021", snippet.read_bytes())
            self.assertIsNone(controller.read("pending"))
            self.assertEqual(len(list(controller.directory.glob("pending.corrupt-*.json"))), 1)
            snippet.write_bytes(b"malformed proxy config")
            deploy.recover_files(root, {"snippet_host": str(snippet)})
            self.assertIn(b"reverse_proxy old:4021", snippet.read_bytes())

    def test_unrecoverable_state_disables_only_agenttoll_route(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet = root / "upstream.caddy"
            with self.assertRaises(deploy.DeployError):
                deploy.recover_files(root, {"snippet_host": str(snippet)})
            self.assertIn(b"503", snippet.read_bytes())
            self.assertNotIn(b"reverse_proxy", snippet.read_bytes())

    def test_concurrent_shared_caddy_edit_aborts_before_upstream_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet, shared = root / "upstream.caddy", root / "Caddyfile"
            snippet.write_bytes(CONFIG)
            shared.write_bytes(b"agenttoll.app { import /data/agenttoll/upstream.caddy }\n")
            host = deploy.Host(root, {"snippet_host": str(snippet), "caddyfile": str(shared),
                                      "snippet_container": "/data/agenttoll/upstream.caddy"})

            def external_validate(*args, **kwargs):
                self.assertIn(b"reverse_proxy new:4021", kwargs["input"])
                shared.write_bytes(shared.read_bytes() + b"other.example { respond fine }\n")

            with patch.object(host, "caddy", side_effect=external_validate):
                with self.assertRaises(deploy.DeployError):
                    host.promote(OLD, NEW)
            self.assertEqual(snippet.read_bytes(), CONFIG)
            self.assertIn(b"other.example", shared.read_bytes())

    def test_unchanged_shared_config_is_never_rewritten_during_promotion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snippet, shared = root / "upstream.caddy", root / "Caddyfile"
            snippet.write_bytes(CONFIG)
            original = b"agenttoll.app { import /data/agenttoll/upstream.caddy }\n"
            shared.write_bytes(original)
            inode = shared.stat().st_ino
            host = deploy.Host(root, {"snippet_host": str(snippet), "caddyfile": str(shared),
                                      "snippet_container": "/data/agenttoll/upstream.caddy"})
            with patch.object(host, "caddy"), patch.object(host, "reload"):
                host.promote(OLD, NEW)
            self.assertEqual(shared.read_bytes(), original)
            self.assertEqual(shared.stat().st_ino, inode)
            self.assertIn(b"reverse_proxy new:4021", snippet.read_bytes())


class GitInputTests(unittest.TestCase):
    def test_data_docs_skip_but_source_and_mode_changes_need_new_ci(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init")
            (root / "src").mkdir()
            (root / "data").mkdir()
            (root / "src/app.ts").write_text("export const result = 1;\n")
            def commit():
                git("add", ".")
                git("-c", "user.name=Deployment Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
                return git("rev-parse", "HEAD")
            original = commit()
            host = deploy.Host(root, {"snippet_host":str(root / "snippet"), "caddyfile":str(root / "Caddyfile")})
            host.repository = root / ".git"
            (root / "data/stats.json").write_text('{"new":1}\n')
            (root / "README.md").write_text("Updated documentation\n")
            docs = commit()
            self.assertEqual(host.fingerprint(original), host.fingerprint(docs))
            (root / "src/app.ts").write_text("export const result = 2;\n")
            source = commit()
            self.assertNotEqual(host.fingerprint(source), host.fingerprint(docs))
            git("update-index", "--chmod=+x", "src/app.ts")
            git("-c", "user.name=Deployment Test", "-c", "user.email=test@example.invalid", "commit", "-m", "mode")
            self.assertNotEqual(host.fingerprint(source), host.fingerprint(git("rev-parse", "HEAD")))


if __name__ == "__main__":
    unittest.main()
