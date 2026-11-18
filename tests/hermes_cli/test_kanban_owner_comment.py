"""Owner-comment handoff: an owner comment on a Blocked card wakes the coordinator exactly once.

Behaviour contract for ``hermes_cli.kanban_owner_comment`` driven through the real dashboard
HTTP route (the surface Desktop uses), the real DB layer and the embedded dispatcher's tick.
"""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_owner_comment as koc

SECRET = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"


def _router():
    plugin_file = Path(__file__).resolve().parents[2] / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_kanban_owc", plugin_file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod.router


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    for var in ("HERMES_KANBAN_DB", "HERMES_KANBAN_HOME", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_TASK",
                "HERMES_KANBAN_RUN_ID", "HERMES_KANBAN_WORKSPACES_ROOT"):
        monkeypatch.delenv(var, raising=False)
    for name in ("assistant-clara", "adrian"):
        (home / "profiles" / name).mkdir(parents=True)
        (home / "profiles" / name / "config.yaml").write_text("{}\n")
    kb._INITIALIZED_PATHS.clear()
    koc._WARNED_EVENTS.clear()
    kb.init_db()
    return home


@pytest.fixture
def client(home):
    app = FastAPI()
    app.include_router(_router(), prefix="/api/plugins/kanban")
    return TestClient(app)


@pytest.fixture
def settings(home):
    return koc.resolve_settings({"owner_comment_handoff": {"enabled": True, "coordinator": "assistant-clara"}})


def _blocked_card(title="Connect calendar", assignee="adrian", board=None):
    with kbc.connect_closing(board=board) as conn:
        tid = kb.create_task(conn, title=title, assignee=assignee, board=board)
        assert kb.block_task(conn, tid, reason="needs the calendar URL", kind="needs_input")
    return tid


def _tick(settings, board="default"):
    with kbc.connect_closing(board=board) as conn:
        return koc.run_owner_comment_handoff(conn, board=board, settings=settings)


def _comment(client, tid, body, author="desktop", board=None):
    url = f"/api/plugins/kanban/tasks/{tid}/comments" + (f"?board={board}" if board else "")
    r = client.post(url, json={"author": author, "body": body})
    assert r.status_code == 200, r.text


def _handoffs(board=None):
    with kbc.connect_closing(board=board) as conn:
        rows = conn.execute(
            "SELECT id FROM tasks WHERE created_by = ? ORDER BY created_at", (koc.HANDOFF_CREATOR,),
        ).fetchall()
        return [kb.get_task(conn, r["id"]) for r in rows]


def test_owner_comment_on_blocked_card_creates_one_bounded_handoff(client, settings):
    tid = _blocked_card()
    assert _tick(settings) == []  # first run starts caught up
    long_body = f"Here is the calendar: https://cal.example/feed token {SECRET} /home/miika/notes.txt " + "x" * 2000
    _comment(client, tid, long_body)

    created = _tick(settings)
    assert len(created) == 1
    [handoff] = _handoffs()
    assert handoff.id == created[0]
    assert handoff.assignee == "assistant-clara" and handoff.status == "ready"
    with kbc.connect_closing() as conn:
        comment_id = kb.list_comments(conn, tid)[-1].id
        target = kb.get_task(conn, tid)
    assert handoff.idempotency_key == koc.handoff_key("default", tid, comment_id)
    assert tid in handoff.body and f"#{comment_id}" in handoff.body
    assert SECRET not in handoff.body and "/home/miika" not in handoff.body
    assert "x" * 300 not in handoff.body
    # Never auto-processed: the target stays Blocked with its assignee untouched.
    assert target.status == "blocked" and target.assignee == "adrian"


def test_comment_after_boot_before_first_tick_is_handed_off_once(client, settings):
    """Regression: the first tick used to seed its cursor past a comment posted since boot."""
    tid = _blocked_card()
    _comment(client, tid, "calendar URL is in the vault entry 'calendar'")

    created = _tick(settings)
    assert len(created) == 1
    assert [h.id for h in _handoffs() if h] == created
    assert _tick(settings) == []


def test_comments_from_before_boot_are_not_replayed(client, settings):
    tid = _blocked_card()
    _comment(client, tid, "an old answer from before the feature was enabled")
    later_boot = dataclasses.replace(settings, enabled_at=int(time.time()) + 1)

    assert _tick(later_boot) == []
    _comment(client, tid, "a new answer after boot")
    assert len(_tick(later_boot)) == 1


def test_repeated_ticks_and_restart_never_duplicate(client, settings):
    tid = _blocked_card()
    _tick(settings)
    _comment(client, tid, "calendar URL is in the vault entry 'calendar'")
    assert len(_tick(settings)) == 1
    # Gateway restart: fresh process state, fresh connections, the durable cursor survives.
    kb._INITIALIZED_PATHS.clear()
    koc._WARNED_EVENTS.clear()
    assert _tick(settings) == []
    # A lost cursor write (or a second consumer) replays the event: the key still holds,
    # even after the coordinator archived its handoff card.
    [handoff] = _handoffs()
    with kbc.connect_closing() as conn:
        assert kb.archive_task(conn, handoff.id)
        conn.execute("UPDATE kanban_event_cursors SET last_event_id = 0")
        conn.commit()
    assert _tick(settings) == []
    assert len(_handoffs()) == 1


def test_non_owner_comments_and_other_statuses_do_not_trigger(client, settings, home):
    blocked = _blocked_card()
    with kbc.connect_closing() as conn:
        ready = kb.create_task(conn, title="ready card", assignee="adrian")
    _tick(settings)
    with kbc.connect_closing() as conn:
        kb.add_comment(conn, blocked, "adrian", "agent comment via the tool")          # agent identity
        kb.add_comment(conn, blocked, "desktop", "CLI --author desktop, no HTTP route")  # forged label
    _comment(client, blocked, "dashboard post under a profile's name", author="adrian")
    _comment(client, blocked, "dashboard post with an unlisted label", author="someone")
    _comment(client, ready, "owner comment on a card that is not Blocked")
    assert _tick(settings) == []
    assert _handoffs() == []
    # The cursor moved past every rejected event, so a later owner comment is handled alone.
    _comment(client, blocked, "the URL is in the vault")
    assert len(_tick(settings)) == 1


def test_other_boards_are_not_watched(client, settings):
    kb.create_board("side")
    tid = _blocked_card(board="side")
    _tick(settings, board="side")
    _comment(client, tid, "owner comment on another board", board="side")
    assert _tick(settings, board="side") == []
    assert _handoffs(board="side") == []


def test_card_unblocked_before_the_tick_is_skipped(client, settings):
    tid = _blocked_card()
    _tick(settings)
    _comment(client, tid, "done, unblocking it myself")
    with kbc.connect_closing() as conn:
        assert kb.unblock_task(conn, tid)
    assert _tick(settings) == []


def test_failed_create_rolls_back_and_retries_once(client, settings, monkeypatch):
    tid = _blocked_card()
    _tick(settings)
    _comment(client, tid, "first")
    real_create = kb.create_task
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("disk full")
        return real_create(*args, **kwargs)

    monkeypatch.setattr(kb, "create_task", flaky)
    assert _tick(settings) == []
    assert _handoffs() == []
    assert len(_tick(settings)) == 1
    assert len(_handoffs()) == 1


@pytest.mark.parametrize("raw", [
    None,
    {"enabled": False, "coordinator": "assistant-clara"},
    {"enabled": True, "coordinator": ""},
    {"enabled": True, "coordinator": "no-such-profile"},
])
def test_feature_is_off_unless_enabled_with_a_real_coordinator(home, raw):
    resolved = koc.resolve_settings({"owner_comment_handoff": raw} if raw is not None else {})
    assert not resolved.enabled
    assert bool(resolved.warnings) == bool(raw and raw.get("enabled"))


def test_config_section_reaches_the_dispatcher_tick(client, home, monkeypatch):
    """The gateway's embedded dispatcher reads the section and hands off before dispatching."""
    from gateway.kanban_watchers_dispatcher import _KanbanDispatcher, _resolve_dispatcher_settings
    from hermes_cli import kanban_db_dispatch as kbd

    (home / "config.yaml").write_text(
        "kanban:\n  owner_comment_handoff:\n    enabled: true\n    coordinator: assistant-clara\n")
    from hermes_cli.config_effective import load_user_config_effective
    kanban_cfg = load_user_config_effective()["kanban"]
    dispatched = []
    monkeypatch.setattr(kbd, "dispatch_once", lambda conn, **kw: dispatched.append(
        [t.id for t in _handoffs()]))
    dispatcher = _KanbanDispatcher(kb, _resolve_dispatcher_settings(kanban_cfg, kb),
                                   koc.resolve_settings(kanban_cfg))
    tid = _blocked_card()
    dispatcher.tick_once_for_board("default")
    _comment(client, tid, "here you go")
    dispatcher.tick_once_for_board("default")
    assert len(dispatched) == 2 and dispatched[0] == [] and len(dispatched[1]) == 1


# --- the coordinator's narrow unblock grant -------------------------------------------------


def _run_as_worker(monkeypatch, task_id, profile):
    with kbc.connect_closing() as conn:
        assert kb.claim_task(conn, task_id)
        run_id = kb._current_run_id(conn, task_id)
    monkeypatch.setenv("HERMES_PROFILE", profile)
    monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    monkeypatch.setenv("HERMES_KANBAN_RUN_ID", str(run_id))


def test_handoff_worker_may_unblock_only_its_target(client, settings, monkeypatch):
    from tools import kanban_tools as kt

    target = _blocked_card()
    other = _blocked_card(title="unrelated")
    _tick(settings)
    _comment(client, target, "the URL is in the vault")
    [handoff_id] = _tick(settings)
    _run_as_worker(monkeypatch, handoff_id, "assistant-clara")

    assert kt._check_kanban_unblock_mode() is True
    assert kt._check_kanban_orchestrator_mode() is False  # kanban_list stays hidden
    refused = json.loads(kt._handle_unblock({"task_id": other}))
    assert "may unblock only" in refused.get("error", "")
    done = json.loads(kt._handle_unblock({"task_id": target}))
    assert done.get("status") in {"ready", "todo"}, done
    with kbc.connect_closing() as conn:
        assert kb.get_task(conn, other).status == "blocked"


def test_ordinary_worker_keeps_no_unblock_and_cannot_forge_a_grant(home, monkeypatch):
    from tools import kanban_tools as kt

    target = _blocked_card()
    with kbc.connect_closing() as conn:
        own = kb.create_task(conn, title="plain card", assignee="assistant-clara",
                             idempotency_key=koc.handoff_key("default", target, 999))
    _run_as_worker(monkeypatch, own, "assistant-clara")
    assert kt._check_kanban_unblock_mode() is False
    out = json.loads(kt._handle_unblock({"task_id": target}))
    assert "orchestrator-only" in out.get("error", "")
    forged = json.loads(kt._handle_create({
        "title": "squat", "assignee": "assistant-clara",
        "idempotency_key": koc.handoff_key("default", target, 1000)}))
    assert "reserved" in forged.get("error", "")
