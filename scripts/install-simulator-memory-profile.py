#!/usr/bin/env python3
"""Enroll the current macOS user's simulators in Device Deck's QA memory profile."""

import argparse
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import subprocess
import sys
import tempfile


LABEL = "com.tantawowa.device-deck.simslim"
PROFILE = {"name": "Device Deck QA", "except": ["store", "web", "icloud"]}
BINARIES = (Path("/opt/homebrew/bin/simslim"), Path("/usr/local/bin/simslim"))


def agent_plist(binary, profile):
    return {
        "Label": LABEL,
        "ProgramArguments": [str(binary), "watch", "--profile", str(profile)],
        "LimitLoadToSessionType": "Aqua",
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
    }


def read_owned(path, decode, expected):
    if path.is_symlink():
        raise ValueError(f"Refusing to change a symlink at {path}")
    if not path.exists():
        return None
    try:
        value = decode(path.read_bytes())
    except (ValueError, plistlib.InvalidFileException) as error:
        raise ValueError(f"Cannot recognize {path}. Preserve or relocate it before continuing.") from error
    if value not in expected:
        raise ValueError(f"Existing file differs from Device Deck's configuration. Preserve or relocate {path} before continuing.")
    return value


def create_file(path, content):
    # Publish a complete file atomically without replacing an existing file.
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent) as staged:
        staged.write(content)
        staged.flush()
        os.link(staged.name, path)


def launchctl(*args):
    return subprocess.run(["/bin/launchctl", *args], capture_output=True, text=True, check=False)


def require_success(result):
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"launchctl failed with exit code {result.returncode}")


def loaded_state(target, agent, control):
    result = control("print", target)
    if result.returncode:
        if "Could not find service" in result.stderr or "Could not find domain" in result.stderr:
            return None
        require_success(result)
    origin = re.search(r"^\s*path = (.+)$", result.stdout, re.MULTILINE)
    if not origin or Path(origin.group(1)).resolve() != agent.resolve():
        raise ValueError(f"Another service uses {target}. Inspect it with launchctl print before continuing.")
    state = re.search(r"^\s*state = (.+)$", result.stdout, re.MULTILINE)
    return state.group(1) if state else "loaded"


def manage(action, home, uid, control=launchctl, binaries=BINARIES):
    domain = f"gui/{uid}"
    target = f"{domain}/{LABEL}"
    agent = home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    profile = home / "Library" / "Application Support" / "Device Deck" / "simslim-profile.json"
    existing_profile = read_owned(profile, json.loads, [PROFILE])
    configurations = [agent_plist(binary, profile) for binary in binaries]
    existing_agent = read_owned(agent, plistlib.loads, configurations)
    state = loaded_state(target, agent, control)

    if action == "status":
        print(f"{target}: {state or 'not loaded'}")
        print(f"{profile}: {'enrolled' if existing_profile else 'absent'}")
        return 0 if state == "running" and existing_profile and existing_agent else 1

    if action == "uninstall":
        if state is not None:
            require_success(control("bootout", target))
        if existing_agent:
            agent.unlink()
        if existing_profile:
            profile.unlink()
        print(f"Unenrolled {home}. Existing simulator overrides persist.")
        return 0

    if control("print", domain).returncode:
        raise RuntimeError("The simulator owner needs an active macOS GUI login session.")
    if existing_agent:
        binary = Path(existing_agent["ProgramArguments"][0])
    else:
        binary = next((candidate for candidate in binaries if os.access(candidate, os.X_OK)), None)
    if binary is None or not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError("Install the CLI with brew install mobai-app/tap/simslim in the host's standard Homebrew prefix.")
    if existing_profile is None:
        create_file(profile, (json.dumps(PROFILE, indent=2) + "\n").encode())
    if existing_agent is None:
        create_file(agent, plistlib.dumps(agent_plist(binary, profile)))
    overrides = control("print-disabled", domain)
    require_success(overrides)
    if re.search(rf'^\s*"{re.escape(LABEL)}"\s*=>\s*disabled\s*$', overrides.stdout, re.MULTILINE):
        require_success(control("enable", target))
    if state is None:
        require_success(control("bootstrap", domain, str(agent)))
    print(f"Enrolled {home}. Run status to check the watcher.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "status", "uninstall"))
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        parser.error("Run this on macOS as the account that owns the simulators.")
    uid = os.getuid()
    return manage(args.action, Path(pwd.getpwuid(uid).pw_dir), uid)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
