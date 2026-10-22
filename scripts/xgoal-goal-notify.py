#!/usr/bin/env python3
"""Gate OpenCode Notifier's completion alert on XGoal's persisted status."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path


def database_path() -> Path:
    configured = os.environ.get("XGOAL_DB")
    if configured:
        return Path(configured).expanduser()
    data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return data_home / "opencode-xgoal" / "goals.db"


def latest_goal(session_id: str) -> tuple[str, str] | None:
    path = database_path()
    if not path.exists():
        return None
    try:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)
        try:
            row = connection.execute(
                "SELECT status, objective FROM goals WHERE session_id = ? "
                "ORDER BY generation DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error:
        # If the XGoal DB exists but cannot be read, suppress the alert. Failing
        # open here would recreate the premature-completion notification.
        return ("unknown", "")
    if row is None:
        return None
    return str(row[0]), str(row[1])


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[1] != "complete" or not argv[2]:
        return 0

    session_id, session_title = argv[2], argv[3]
    goal = latest_goal(session_id)
    if goal is None:
        title = "OpenCode"
        message = f"Session has finished: {session_title or 'Task'}"
    else:
        status, objective = goal
        if status != "complete":
            return 0
        title = "OpenCode goal complete"
        message = objective or session_title or "The goal was verified complete."

    try:
        subprocess.run(
            ["notify-send", "--app-name=OpenCode", "--", title, message],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
