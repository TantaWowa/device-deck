#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-simulator-memory-profile.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.agent = self.home / "Library/LaunchAgents" / (installer.LABEL + ".plist")
        self.profile = self.home / "Library/Application Support/Device Deck/simslim-profile.json"
        self.binary = self.home / "simslim"
        self.binary.touch(mode=0o700)
        self.loaded = None
        self.disabled = False
        self.writes = []

    def control(self, *args):
        if args == ("print", "gui/501"):
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "print":
            if self.loaded is None:
                return subprocess.CompletedProcess(args, 113, "", "Could not find service")
            return subprocess.CompletedProcess(args, 0, f"path = {self.loaded}\nstate = running\n", "")
        if args[0] == "print-disabled":
            override = f'"{installer.LABEL}" => disabled' if self.disabled else ""
            return subprocess.CompletedProcess(args, 0, override, "")
        self.writes.append(args[0])
        if args[0] == "bootstrap":
            self.loaded = Path(args[2])
        if args[0] == "bootout":
            self.loaded = None
        if args[0] == "enable":
            self.disabled = False
        return subprocess.CompletedProcess(args, 0, "", "")

    def manage(self, action):
        return installer.manage(action, self.home, 501, self.control, [self.binary])

    def test_install_status_repeat_and_uninstall(self):
        self.disabled = True
        self.assertEqual(self.manage("install"), 0)
        config = plistlib.loads(self.agent.read_bytes())
        self.assertEqual(config["ProgramArguments"], [str(self.binary), "watch", "--profile", str(self.profile)])
        self.assertEqual(config["LimitLoadToSessionType"], "Aqua")
        self.assertTrue(config["KeepAlive"] and config["RunAtLoad"])
        self.assertEqual(json.loads(self.profile.read_text())["except"], ["store", "web", "icloud"])
        mtimes = [p.stat().st_mtime_ns for p in [self.agent, self.profile]]
        self.assertEqual(self.manage("status"), 0)
        self.assertEqual(self.manage("install"), 0)
        self.assertEqual(mtimes, [p.stat().st_mtime_ns for p in [self.agent, self.profile]])
        self.assertEqual(self.writes, ["enable", "bootstrap"])
        self.assertEqual(self.manage("uninstall"), 0)
        self.assertEqual(self.manage("uninstall"), 0)
        self.assertEqual(self.manage("status"), 1)
        self.assertEqual(self.writes, ["enable", "bootstrap", "bootout"])
        self.assertFalse(self.agent.exists() or self.profile.exists())

    def test_preserves_user_changes(self):
        self.manage("install")
        self.profile.write_text('{"name":"custom"}')
        for action in ["install", "uninstall"]:
            with self.assertRaisesRegex(ValueError, "differs"):
                self.manage(action)
        self.assertEqual(self.profile.read_text(), '{"name":"custom"}')
        self.assertEqual(self.writes, ["bootstrap"])
        self.assertTrue(self.agent.exists())

    def test_foreign_loaded_label_is_preserved(self):
        self.loaded = self.home / "other.plist"
        for action in ["install", "uninstall"]:
            with self.assertRaisesRegex(ValueError, "Another service"):
                self.manage(action)
        self.assertFalse(self.writes or self.profile.exists() or self.agent.exists())


if __name__ == "__main__":
    unittest.main()
