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


def notification_state_path() -> Path:
    state_home = Path(
        os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    )
    return state_home / "opencode-xgoal" / "notified-goals.sqlite3"


def latest_goal(session_id: str) -> tuple[str, str, str] | None:
    path = database_path()
    if not path.exists():
        return None
    try:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)
        try:
            row = connection.execute(
                "SELECT status, objective, id FROM goals WHERE session_id = ? "
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
    return str(row[0]), str(row[1]), str(row[2])


def notify_goal_once(goal_id: str, title: str, message: str) -> int:
    """Send at most one completion alert for a persisted goal."""
    path = notification_state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=2)
        try:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS notified_goals ("
                "goal_id TEXT PRIMARY KEY, notified_at_ms INTEGER NOT NULL)"
            )
            connection.execute("BEGIN IMMEDIATE")
            already_notified = connection.execute(
                "SELECT 1 FROM notified_goals WHERE goal_id = ?", (goal_id,)
            ).fetchone()
            if already_notified:
                connection.rollback()
                return 0

            result = subprocess.run(
                ["notify-send", "--app-name=OpenCode", "--", title, message],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode != 0:
                connection.rollback()
                return result.returncode
            connection.execute(
                "INSERT INTO notified_goals (goal_id, notified_at_ms) "
                "VALUES (?, CAST(strftime('%s','now') AS INTEGER) * 1000)",
                (goal_id,),
            )
            connection.commit()
            return 0
        finally:
            connection.close()
    except (OSError, sqlite3.Error):
        # Do not emit a duplicate or untracked alert if deduplication state is
        # unavailable; the next completion event can retry.
        return 1


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[1] != "complete" or not argv[2]:
        return 0

    session_id, session_title = argv[2], argv[3]
    goal = latest_goal(session_id)
    if goal is None:
        title = "OpenCode"
        message = f"Session has finished: {session_title or 'Task'}"
    else:
        status, objective, goal_id = goal
        if status != "complete":
            return 0
        title = "OpenCode goal complete"
        message = objective or session_title or "The goal was verified complete."
        return notify_goal_once(goal_id, title, message)

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
