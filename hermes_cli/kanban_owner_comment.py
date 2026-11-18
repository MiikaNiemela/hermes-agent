"""Owner-comment handoff: wake a coordinator profile when the owner comments on a Blocked card.

Opt-in (``kanban.owner_comment_handoff.enabled``). The embedded dispatcher tick tails
``commented`` events past a durable per-board cursor and, for a comment the owner posted through
the dashboard/Desktop HTTP API on a card that was Blocked when the comment landed, creates ONE
handoff card assigned to the coordinator. The card carries the target id, the comment id and a
bounded, redacted excerpt — never the comment body — so the coordinator reads the full card
itself, checks its gates and unblocks explicitly.

Exactly-once: the handoff card and the cursor advance commit in one write transaction, and the
card's ``idempotency_key`` (``owner-comment:<board>:<task>:<comment>``) is checked across every
status, archived included. A failed create rolls both back and the next tick retries the same
event. Nothing here unblocks, moves or wakes the target card's assignee.

The handoff worker may ``kanban_unblock`` exactly the card its key names
(:func:`granted_unblock_target`); every other worker stays without board routing.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

HANDOFF_KEY_PREFIX = "owner-comment:"
# ``created_by`` of every handoff card; the unblock grant requires it, and no agent surface can
# set ``created_by`` (tools stamp the caller's profile).
HANDOFF_CREATOR = "owner-comment-handoff"
# ``via`` stamped on the ``commented`` event by the dashboard HTTP route (Desktop uses the same
# route). CLI and agent comments carry no ``via``.
DASHBOARD_VIA = "dashboard"

_CURSOR_CONSUMER = "owner_comment_handoff"
_BATCH = 100
_EXCERPT_MIN, _EXCERPT_MAX, _EXCERPT_DEFAULT = 40, 500, 240
_LOCAL_PATH_RE = re.compile(r"(?<![\w:/])(?:/(?:Users|home|private|tmp|var|etc|workspace)/[^\s,;]+|"
                            r"[A-Za-z]:\\[^\s,;]+)")
_CURSOR_DDL = (
    "CREATE TABLE IF NOT EXISTS kanban_event_cursors ("
    " consumer TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
)
_WARNED_EVENTS: set[tuple[str, int]] = set()


@dataclass(frozen=True)
class OwnerCommentSettings:
    """``kanban.owner_comment_handoff`` resolved once at dispatcher boot (restart to apply)."""

    enabled: bool = False
    coordinator: str = ""
    boards: tuple[str, ...] = ("default",)
    owner_authors: tuple[str, ...] = ("desktop", "dashboard")
    excerpt_chars: int = _EXCERPT_DEFAULT
    # Unix seconds at boot: a board's first run hands off comments from this second on and skips
    # older history, so a comment posted between boot and the first tick is never lost.
    enabled_at: int = field(default=0, compare=False)
    warnings: tuple[str, ...] = field(default=(), compare=False)


def _str_tuple(value: Any, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, (list, tuple)):
        return fallback
    return tuple(s for s in (str(v).strip() for v in value) if s)


def resolve_settings(kanban_cfg: Optional[Mapping[str, Any]]) -> OwnerCommentSettings:
    """Parse the config section; any invalid piece leaves the feature off with a warning."""
    raw = (kanban_cfg or {}).get("owner_comment_handoff") if isinstance(kanban_cfg, Mapping) else None
    if not isinstance(raw, Mapping) or not raw.get("enabled"):
        return OwnerCommentSettings()
    from hermes_cli.profiles import normalize_profile_name, profile_exists

    coordinator = str(raw.get("coordinator") or "").strip()
    if not coordinator or not profile_exists(coordinator):
        return OwnerCommentSettings(warnings=(
            f"kanban.owner_comment_handoff.coordinator {coordinator or '(unset)'!r} is not an existing "
            "profile; owner-comment handoff disabled",))
    coordinator = normalize_profile_name(coordinator)
    try:
        excerpt = int(raw.get("excerpt_chars", _EXCERPT_DEFAULT))
    except (TypeError, ValueError):
        excerpt = _EXCERPT_DEFAULT
    return OwnerCommentSettings(
        enabled=True,
        coordinator=coordinator,
        boards=_str_tuple(raw.get("boards"), ("default",)),
        owner_authors=_str_tuple(raw.get("owner_authors"), ("desktop", "dashboard")),
        excerpt_chars=min(max(excerpt, _EXCERPT_MIN), _EXCERPT_MAX),
        enabled_at=int(time.time()),
    )


def handoff_key(board: str, task_id: str, comment_id: int) -> str:
    return f"{HANDOFF_KEY_PREFIX}{board}:{task_id}:{int(comment_id)}"


def parse_handoff_key(key: Optional[str]) -> Optional[tuple[str, str, int]]:
    """``(board, task_id, comment_id)`` of a handoff key, else ``None``."""
    if not key or not key.startswith(HANDOFF_KEY_PREFIX):
        return None
    parts = key[len(HANDOFF_KEY_PREFIX):].split(":")
    if len(parts) != 3 or not parts[0] or not parts[1] or not parts[2].isdigit():
        return None
    return parts[0], parts[1], int(parts[2])


def safe_excerpt(body: str, limit: int) -> str:
    """One line, secrets and local paths redacted, at most ``limit`` characters."""
    from agent.redact import redact_sensitive_text

    text = redact_sensitive_text(body or "", force=True, redact_url_credentials=True)
    text = " ".join(_LOCAL_PATH_RE.sub("[local path]", text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def granted_unblock_target(conn: sqlite3.Connection, own_task_id: str) -> Optional[str]:
    """The one card a running handoff worker may unblock, or ``None`` for any other task."""
    row = conn.execute(
        "SELECT idempotency_key, created_by, status FROM tasks WHERE id = ?", (own_task_id,),
    ).fetchone()
    if row is None or row["created_by"] != HANDOFF_CREATOR or row["status"] != "running":
        return None
    parsed = parse_handoff_key(row["idempotency_key"])
    return parsed[1] if parsed else None


def _read_cursor(conn: sqlite3.Connection) -> Optional[int]:
    """The durable cursor, or ``None`` before the first run (no table or no row yet). A plain read,
    so an idle tick never takes the board's writer lock."""
    try:
        row = conn.execute(
            "SELECT last_event_id FROM kanban_event_cursors WHERE consumer = ?", (_CURSOR_CONSUMER,),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc).lower():
            raise
        return None
    return None if row is None else int(row["last_event_id"])


def _start_cursor(conn: sqlite3.Connection, kb: Any, enabled_at: int) -> int:
    """First run on a board: start just before the first event of the boot second, so history is
    never replayed while comments posted since boot (before this first tick) still are."""
    with kb.write_txn(conn):
        conn.execute(_CURSOR_DDL)
        conn.execute(
            "INSERT OR IGNORE INTO kanban_event_cursors (consumer, last_event_id, updated_at) "
            "VALUES (?, COALESCE((SELECT MAX(id) FROM task_events WHERE created_at < ?), 0), ?)",
            (_CURSOR_CONSUMER, int(enabled_at), int(time.time())),
        )
        row = conn.execute("SELECT last_event_id FROM kanban_event_cursors WHERE consumer = ?",
                           (_CURSOR_CONSUMER,)).fetchone()
    return int(row["last_event_id"])


def _is_owner_comment(payload: Mapping[str, Any], settings: OwnerCommentSettings) -> bool:
    author = str(payload.get("author") or "").strip()
    if payload.get("via") != DASHBOARD_VIA or author not in settings.owner_authors:
        return False
    from hermes_cli.profiles import profile_exists

    # An author label naming a profile is an agent identity, never the owner.
    return not profile_exists(author)


def _handoff_body(task: Any, comment: Any, board: str, settings: OwnerCommentSettings) -> str:
    excerpt = safe_excerpt(comment["body"], settings.excerpt_chars)
    return (
        "## Your action\n"
        f"The owner commented on Blocked card `{task.id}` (comment #{comment['id']}, board `{board}`). "
        f"Read the full card and comment with `kanban_show(task_id=\"{task.id}\")`, decide whether the "
        "comment supplies what the block asked for, and act:\n"
        f"- if the block is resolved and every gate holds, call `kanban_unblock(task_id=\"{task.id}\")`;\n"
        f"- otherwise `kanban_comment` on `{task.id}` with what is still missing and leave it Blocked.\n"
        "Then complete this card with what you decided and why.\n\n"
        "## Gates to check before unblocking\n"
        "- Parent cards: an open parent keeps the card waiting; never work around a dependency.\n"
        "- Review: a review or human-test gate on the card or its children still applies.\n"
        "- Credentials and approvals: only the owner supplies secrets, physical steps and approvals; "
        "a comment that merely mentions one is not the thing itself.\n\n"
        "## Why\n"
        f"Card: {task.title[:120]} (assignee `{task.assignee or '-'}`)\n"
        f"Comment excerpt (redacted, bounded; the full text is on the card): {excerpt}\n\n"
        "Do not move the card any other way and do not wake its assignee directly: unblocking is the "
        "handoff."
    )


def _handle_event(conn: sqlite3.Connection, kb: Any, row: sqlite3.Row, board: str,
                  settings: OwnerCommentSettings) -> Optional[str]:
    """Create the handoff for one ``commented`` event when it qualifies; returns the card id."""
    import json

    try:
        payload = json.loads(row["payload"] or "{}")
    except ValueError:
        return None
    comment_id = payload.get("comment_id") if isinstance(payload, dict) else None
    if not isinstance(comment_id, int):
        return None
    if payload.get("task_status") != "blocked" or not _is_owner_comment(payload, settings):
        return None
    task = kb.get_task(conn, row["task_id"])
    if task is None or task.status != "blocked":
        return None
    comment = conn.execute(
        "SELECT id, body FROM task_comments WHERE id = ? AND task_id = ?", (comment_id, task.id),
    ).fetchone()
    if comment is None:
        return None
    key = handoff_key(board, task.id, comment_id)
    # Every status counts, archived included: an archived handoff is still a handled comment.
    existing = conn.execute("SELECT id FROM tasks WHERE idempotency_key = ? AND created_by = ? LIMIT 1",
                            (key, HANDOFF_CREATOR)).fetchone()
    if existing:
        return None
    return kb.create_task(
        conn, title=f"Owner commented on Blocked {task.id}: {task.title[:60]}",
        body=_handoff_body(task, comment, board, settings), assignee=settings.coordinator,
        created_by=HANDOFF_CREATOR, idempotency_key=key, board=board, workspace_kind="scratch",
    )


def run_owner_comment_handoff(conn: sqlite3.Connection, *, board: str,
                              settings: OwnerCommentSettings) -> list[str]:
    """One tick on one board: hand off qualifying owner comments; returns created card ids."""
    if not settings.enabled or board not in settings.boards:
        return []
    from hermes_cli import kanban_db as kb

    cursor = _read_cursor(conn)
    if cursor is None:
        cursor = _start_cursor(conn, kb, settings.enabled_at)
    rows = conn.execute(
        "SELECT id, task_id, payload FROM task_events WHERE kind = 'commented' AND id > ? "
        "ORDER BY id ASC LIMIT ?", (cursor, _BATCH),
    ).fetchall()
    created: list[str] = []
    for row in rows:
        event_id = int(row["id"])
        try:
            with kb.write_txn(conn):
                new_id = _handle_event(conn, kb, row, board, settings)
                moved = conn.execute(
                    "UPDATE kanban_event_cursors SET last_event_id = ?, updated_at = ? "
                    "WHERE consumer = ? AND last_event_id = ?",
                    (event_id, int(time.time()), _CURSOR_CONSUMER, cursor),
                ).rowcount
                if moved != 1:
                    raise RuntimeError("cursor moved concurrently")
        except Exception as exc:  # health: allow BLE001 -- rolled back; the event retries next tick
            # Rolled back: the next tick retries this event, and the key keeps a retry single.
            if (board, event_id) not in _WARNED_EVENTS:
                _WARNED_EVENTS.add((board, event_id))
                logger.warning("kanban owner-comment handoff: event %d on board %s not handled (%s); "
                               "retrying next tick", event_id, board, exc, exc_info=True)
            break
        cursor = event_id
        if new_id:
            created.append(new_id)
            logger.info("kanban owner-comment handoff [%s]: owner comment on %s -> %s for %s",
                        board, row["task_id"], new_id, settings.coordinator)
    return created
