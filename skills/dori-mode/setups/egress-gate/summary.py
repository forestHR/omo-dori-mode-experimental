#!/usr/bin/env python3
"""Print a Korean daily change summary, or nothing when there are no changes."""
import argparse
import collections
import datetime as dt
import http.client
import json
import re
from pathlib import Path
from urllib.parse import urlencode, urlsplit


def defang(text: str) -> str:
    """Titles come from the Dori; a link in them would be fetched by Discord for a preview."""
    return re.sub(r"(?i)\b(h)tt(ps?)://", r"\1xx\2[:]//", text)


def window_records(path: Path, cutoff: dt.datetime) -> list:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as stream:
        return [row for line in stream if (row := json.loads(line)) and
                dt.datetime.fromisoformat(row["ts"]) >= cutoff]


NAMES = {"calendar": "일정", "tasks": "할 일", "drive": "드라이브",
         "docs": "문서", "obsidian": "노트", "sheets": "시트", "forms": "폼"}
TEST_TITLE = re.compile(r"게이트\s*시험|gate[ -]?test", re.IGNORECASE)
SHOWN_TITLES = 3
# A refused write is a write request the gate turned down. CONNECT tunnels (a Dori tool calling a host off
# the allow list), reads, and upstreams that did not answer stay in denials.jsonl but are not writes.
NOT_WRITES = {"GET", "HEAD", "CONNECT"}
UPSTREAM_FAILURES = {"request-failed", "upstream-unavailable", "upstream-check-failed",
                     "upstream-response-too-large", "connect-upstream-unreachable", "node-gate-unavailable"}


def refused_writes(denials: list) -> list:
    return [row for row in denials
            if row.get("method") not in NOT_WRITES and row.get("reason") not in UPSTREAM_FAILURES]


def verb(row: dict) -> str:
    op = row["op"]
    if op.startswith("restore."):
        return "되살림"
    if op.startswith("permissions."):
        return "공유"
    if op.startswith("comments."):
        return "댓글"
    if row.get("delete") or op.endswith(".delete"):
        return "삭제"
    if op.endswith((".insert", ".create", ".copy")):
        return "추가"
    return "수정"


def title_of(row: dict, snapshot_title=None) -> str:
    resource = row["resource"]
    title = resource.get("title") or resource.get("summary") or resource.get("name")
    if not title and snapshot_title:
        title = snapshot_title(row)
    title = " ".join(str(title or "제목 없음").split())
    return title.rsplit("/", 1)[-1].removesuffix(".md") if row["api"] == "obsidian" else title


def short(text: str, width: int = 20) -> str:
    return text if len(text) <= width else text[:width - 1] + "…"


def by_kind(rows: list, verbs_shown: bool = True) -> str:
    """일정 4(추가 3·수정 1) · 할 일 1 - kinds by count, verbs inside when more than one."""
    kinds = collections.defaultdict(collections.Counter)
    for row in rows:
        kinds[row["api"]][verb(row)] += 1
    parts = []
    for api, verbs in sorted(kinds.items(), key=lambda item: (-sum(item[1].values()), item[0])):
        part = f"{NAMES.get(api, api)} {sum(verbs.values())}"
        if verbs_shown and len(verbs) > 1:
            part += "(" + "·".join(f"{v} {n}" for v, n in verbs.most_common()) + ")"
        parts.append(part)
    return " · ".join(parts)


def render(changes: list, denials: list, pending: list, hours: float, name: str = "",
           snapshot_title=None) -> str:
    """A few lines for a phone; links, owner proof, approvals and restore IDs stay in the journal."""
    final = name and 0xAC00 <= ord(name[-1]) <= 0xD7A3 and (ord(name[-1]) - 0xAC00) % 28
    who = f"{name}{'이' if final else '가'} " if name else ""
    span = "오늘" if hours == 24 else f"최근 {hours:g}시간"
    done = [row for row in changes if 200 <= row["status"] < 300]
    failed = len(changes) - len(done)
    tests = [row for row in done if TEST_TITLE.search(title_of(row, snapshot_title))]
    real = [row for row in done if row not in tests]
    lines = [f"{span} {who}바꾼 것 {len(done)}건"]
    if real:
        lines.append(by_kind(real))
        kst = dt.timezone(dt.timedelta(hours=9))
        latest = sorted(real, key=lambda row: row["ts"], reverse=True)
        shown = [dt.datetime.fromisoformat(row["ts"]).astimezone(kst).strftime("%H:%M ") +
                 defang(short(title_of(row, snapshot_title))) for row in latest[:SHOWN_TITLES]]
        more = f" 외 {len(real) - SHOWN_TITLES}건" if len(real) > SHOWN_TITLES else ""
        lines.append(" · ".join(shown) + more)
    if tests:
        lines.append(f"게이트 시험 {len(tests)}건({by_kind(tests, False).replace(' · ', '·')})")
    restorable = sum(1 for row in done if row["restorable"] and verb(row) == "삭제")
    if restorable:
        lines.append(f"되살릴 수 있음 {restorable}건")
    refused = len(refused_writes(denials))
    others = [text for count, text in ((failed, f"실패 {failed}건"), (refused, f"막힌 쓰기 {refused}건"),
                                       (len(pending), f"승인 기다림 {len(pending)}건")) if count]
    if others:
        lines.append(" · ".join(others))
    lines.append(f"자세한 건 {name}에게 물어보면 올림" if name else "자세한 건 물어보면 올림")
    return "\n".join(lines)


def post_summary(config: dict, hours: float) -> int:
    state = Path(config["state"])
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    changes = window_records(state / "changes.jsonl", cutoff)
    denials = window_records(state / "denials.jsonl", cutoff)
    pending = []
    for path in sorted((state / "pending").glob("*.json")):
        row = json.loads(path.read_text())
        if dt.datetime.fromisoformat(row["ts"]) >= cutoff:
            pending.append(row)
    if not changes and not refused_writes(denials) and not pending:
        print("SUMMARY_EMPTY")
        return 0
    def snapshot_title(row: dict) -> str:
        """A delete returns no body; its title is in the snapshot taken before it."""
        try:
            data = json.loads((state / row["snapshot"]).read_text())
        except (KeyError, TypeError, OSError, ValueError):
            return ""
        return str(data.get("title") or data.get("summary") or data.get("name") or "") if isinstance(data, dict) else ""

    content = render(changes, denials, pending, hours, config.get("dori_name", ""), snapshot_title)
    base = urlsplit(config.get("discord_api_base", "https://discord.com/api/v10"))
    connection_class = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
    authorization = "Bot " + Path(config["owner_proof"]["token_file"]).read_text().strip()
    messages = [content[i:i + 1899] for i in range(0, len(content), 1899)]
    for message in messages:
        connection = connection_class(base.hostname, base.port, timeout=30)
        try:
            body = json.dumps({"content": message, "allowed_mentions": {"parse": []}, "flags": 4}, ensure_ascii=False).encode()
            connection.request("POST", base.path.rstrip("/") +
                               f"/channels/{config['approval']['channel_id']}/messages", body,
                               {"Authorization": authorization, "Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            if not 200 <= response.status < 300:
                raise SystemExit(f"summary post returned HTTP {response.status}")
        finally:
            connection.close()
    print(f"SUMMARY_POSTED {len(messages)} messages")
    return len(messages)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3129)
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--post", action="store_true")
    args = parser.parse_args()
    if args.hours <= 0:
        parser.error("--hours must be positive")
    if args.post:
        if not args.config:
            parser.error("--post requires --config")
        post_summary(json.loads(args.config.read_text()), args.hours)
        return
    connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=30)
    try:
        connection.request("GET", "/_gate/changes?" + urlencode({"since": f"{args.hours}h"}))
        response = connection.getresponse()
        if response.status != 200:
            raise SystemExit(f"gate returned HTTP {response.status}")
        changes = json.loads(response.read())
    finally:
        connection.close()
    if not changes:
        return
    print(render(changes, [], [], args.hours))


if __name__ == "__main__":
    main()
