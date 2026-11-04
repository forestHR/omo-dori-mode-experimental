# Egress gate

Python 3.12 standard-library-only asyncio gate for an isolated Dori Linux user.
It binds only `127.0.0.1`; firewall installation and service installation are
separate tasks. Run as the dedicated, unprivileged gate user:

```sh
python3 -I gate.py --config /etc/dori-gate/config.json
```

Configure client/admin UIDs, owner IDs/emails, and the approval channel before use.
Only client UIDs may proxy APIs; only admin UIDs may use `/_admin/*`.
Both may read `/_gate/*`; client restores require an owner message.
Unknown socket UIDs are disconnected. Identity comes from the caller-side
socket entry in `/proc/net/tcp` and `/proc/net/tcp6`, not HTTP headers.

| Port | Function |
| --- | --- |
| 3128 | CONNECT only; configured names/ports, public DNS addresses only |
| 3129 | Google reverse API, journal, restores, OAuth admin, optional vault |
| 3130 | Discord `/api/v10/*`, owner guild/owner-only DMs |
| 3131 | Web window: `GET /fetch?url=`, `GET /search?q=` (optional, `listen.web`) |

The Discord Gateway uses the CONNECT port, not the Discord REST port. CONNECT
copies opaque TLS bytes in both directions; it does not decode WebSocket frames,
opcodes, or zlib streams. The listener requests JSON without compression. A
`DISCORD_LISTENER_CLOSED code=4001` can also be a locally chosen close code: check
the listener's handling of Gateway reconnect/invalid-session events before
attributing it to an upstream unknown opcode.

Owner DM history is available through `POST /api/v10/users/@me/channels` with
the owner's `recipient_id`, then `GET /api/v10/channels/<id>/messages`. The gate
checks the DM recipients on history reads too; another person's DM is refused.

Google paths look like `/www.googleapis.com/calendar/v3/calendars/primary/events`.
The gate supplies Google authorization and strips caller credentials.
Writes require `X-Dori-Owner-Message: channel_id/message_id`; proof must be an
owner message in the owner guild, no older than 24 hours. Successful proofs and
channel/calendar checks are cached for at most ten minutes.

The owner's one voice webhook also counts as an owner message (owner 2026-10-31 20:18 KST Q425 "받기: 그 웹훅 하나만,
24시간 한도·바깥 쓰기 승인 카드 그대로, 형 sudo 한 줄"). With `owner_proof.owner_webhook_id` and
`owner_proof.owner_webhook_channel` both set, a message passes when its `webhook_id` and `author.id` both equal
that id and the proof's channel is that channel. A thread of the channel does not count. Another webhook, another
channel or a bot's post is refused with `owner-message-required`, and with either key empty only the owner's account
counts. Everything else about a proof stays: the 24 hours, the write limit per message (when configured), the outbound cards. Card
buttons and reactions are still the owner's account only. The id goes in the root-owned config and nowhere else.

A dashboard order is the other proof (owner 2026-10-21 23:23 KST "문지기가 대시보드 지시도
형 명령으로 인정"): `X-Dori-Owner-Order: <n>` (the dashboard order number, 1-999999999) when no
`X-Dori-Owner-Message` is sent; an owner message always wins. With `owner_order` set, the gate
asks the project-board dashboard on every write, never cached:
`GET <api_base>/api/orders/<n>` with `X-PB-Gate-Token: <token_file contents>` (`token_header`).
The answer must be a JSON object with `number` equal to the asked number, `via` `"owner-device"` (made in
the browser through `tailscale serve` on one of the owner's own devices, as the board decides from its
`owner_devices`; `tailnet` - a server or other device under the owner's login - and `local` are refused),
`device` the sending device's tailnet stable node id (and, when the gate config lists `owner_devices`,
one of them, case-insensitive; the servers share the owner's login, so the login alone cannot tell
them apart), `created_by` one of `owner_logins` (the owner's tailnet login, case-insensitive), `created_at` an ISO time with zone no older than
`max_age_hours` (24) and not in the future, `status` one of `open_statuses` (default `받음`, `넘김`,
`처리 중`; `끝` is refused) and `body_sha256` 64 hex characters.
Anything else, a non-2xx answer, no answer within `timeout_seconds` (5) or a missing setting is
`403 owner-order-required` before Google. An order has no write count limit, only the time window
(owner 2026-10-21 23:55 KST Q353 "횟수 제한 없애고 24시간 창만"; the owner-message write limit below does
not apply to orders either). Then the gate records the use on the dashboard
(`POST <api_base>/api/orders/<n>/use`, same header; the answer's `number` must match) and refuses
the write if that fails; the use is recorded when the proof is accepted, so a write the policy then
parks or refuses is still recorded. The order changes only the proof: outbound writes still park on the
approval card, and Gmail send stays refused. The dashboard keeps its gate token in the agent
account (0600); the owner's root apply copies it to `/etc/dori-gate/dashboard-orders-token`
(root:dori-gate 0640) and again whenever the dashboard makes a new one.

A todo the owner approved by its card is the third proof (owner 2026-11-03 06:09 KST Q2 "고친다: 카드 승인 할 일도
근거로 받음", after Q454/Q455: a todo approved by card goes at once, one the board took in without a card asks
first): `X-Dori-Owner-Todo: <todo id>` (the dashboard todo id, `pb-<12 hex>-<n>`) when neither
`X-Dori-Owner-Message` nor `X-Dori-Owner-Order` is sent. With `owner_todo` set, the gate asks the dashboard on
every write, never cached: `GET <api_base>/api/todos/<id>` with the same gate token header (`token_file`,
`token_header`). The answer must be a JSON object with `todo_id` equal to the asked id, `auto_applied` exactly
`false` (the board took it in through the owner's approval card, not by its own auto-apply switch), `card` with the
card's `channel_id` and `message_id` (digits), `status` one of `open_statuses` (default `열림`, `진행`; `완료` and
`보류` are refused) and `approved_at` an ISO time with zone, not in the future. There is no 24-hour window: the
todo is the owner's basis while it is open, and finishing, holding or deleting it ends that (owner 2026-11-03 10:53
KST "그래 열려있는동안 해"); `owner_todo.max_age_hours` is no longer read, so an installed config that still has it
keeps working. Then the gate checks the card on Discord itself, with the owner-proof bot token: the
channel is in the owner's guild, the owner's own account (`owner_id`, not a bot) reacted ✅ on that message and did
not react ⛔. Anything else, a non-2xx answer, no answer within `timeout_seconds` (5), a card the bot cannot read
or a missing setting is `403 owner-todo-required` before Google. The gate then records the use
(`POST <api_base>/api/todos/<id>/use`, same header; the answer's `todo_id` must match) and refuses the write if
that fails. Like an order, a todo has no write count limit, and it changes only the proof: outbound
writes still park on the approval card and Gmail send stays refused. The journal row keeps `owner_todo` (id, link,
`approved_at`, card link). YooDori's backlog puts the header in each card-approved todo lane's brief
(`references/scripts.md`, backlog feed). `owner_todo` usually shares `owner_order`'s `api_base` and token file.

A card is only for a write that reaches someone other than the owner (owner 2026-11-02 21:35 KST Q447
"바깥 사람에게 가는 것만: 메일·바깥 초대·바깥 공유", and 21:41 KST "파일 바꾸는 것도 승인 없이 구글 드라이브 다 승인 없이").
Writes inside the owner's account (spreadsheets, conversions, images by URL, any number of writes or deletes)
go straight and keep the journal, snapshots, daily summary and restores. The two count limits below are off
unless the config sets `limits`. An owner-owned file already shared with named people, groups or a domain is
edited without a card (the owner made that share, 21:41 KST); a new share, a public (`anyone`) target, a shared
drive and a file that is not the owner's still need one.

| API | Direct writes | Approval card | Always refused |
| --- | --- | --- | --- |
| Calendar | Own/private events, calendars.create, owner ACL, ACL removal | External attendees, foreign organizer, public/non-owned calendar, external ACL | watch, quickAdd, import, move, calendar deletion/update, calendarList writes |
| Tasks | Tasklist create/update; task create/update/delete/move | Configured limits only | clear, tasklist deletion |
| Drive | Own/private files create/update/copy/trash, spreadsheets and conversions, comments/replies on own files, owner permission, permission removal | Public/shared/non-owned targets/parents, external permission, comments/replies with a mention (`+name`, `@name`, a mail address) or on a non-owned file | Permanent file deletion, emptyTrash, watch, shared-drive management |
| Docs | Create and owned/private batchUpdate, images and links by URL included | Public/non-owned documents | Other writes |
| Sheets | Create and writes on owned/private spreadsheets | Public/shared/non-owned spreadsheets, also as a `copyTo` destination | Non-API routes, `copyTo` without a valid destination |
| Forms (`forms.googleapis.com`) | GET `v1/forms/<id>` and POST `v1/forms/<id>:batchUpdate` (info, settings, item create, move, delete, update) on the owner's own form, also one open to responders; writes need owner proof and keep the whole form as a snapshot, no one-call restore | Never | Other people's, shared-drive and anyone-can-edit forms, also reads (`drive-not-owned`, `public-drive-target`); responses, `setPublishSettings`, watches, `forms.create` (`forms-route-not-allowed`). Responses stay shut because they are other people's data and no owner task needs them. The Drive scope is enough; no `forms.body` consent |
| Gmail | Reads | Never | Every write; send-capable OAuth scopes |
| Contacts (`people.googleapis.com`) | GET `people:searchContacts`, `people:batchGet`, `people/<id>`, `people/me/connections`, `otherContacts`, `otherContacts:search` | Never | Every write, contact groups, directory, other paths (`403 contacts-read-only`) |
| Vault | Owner-initiated Markdown writes | Configured limits only | Delete API, traversal, hidden paths, symlinks |

Direct event writes force `sendUpdates=none` and disable legacy notifications.
Approved external invites use `sendUpdates=all`. Attachments remain refused.
Drive uploads support media and multipart; resumable sessions are refused because
their opaque upload URLs do not preserve the checked metadata endpoint.
Other unlisted endpoints are denied. Request bodies are capped at 25 MiB;
vault writes at 1 MiB. Chunked requests are decoded; trailers cannot alter headers.

## Web window

Owner 2026-10-29 10:02 KST "그래 그럼 그렇게 한번 해보자" (stage 1 of the web window, for the gated Dori only).
The gate reads pages and searches for the Dori; the Dori itself still has no DNS and no web. Off unless
`listen.web` is set. Both calls are `GET` only and need the same owner proof as a write
(`X-Dori-Owner-Message`, `X-Dori-Owner-Order` or `X-Dori-Owner-Todo`); one owner message (or order, or todo) is
one task.

```sh
W=http://127.0.0.1:3131; O='X-Dori-Owner-Message: <channel id>/<message id>'
curl -sG -H "$O" --data-urlencode 'url=https://arxiv.org/abs/2503.18813' "$W/fetch"
curl -sG -H "$O" --data-urlencode 'q=prompt injection defenses' "$W/search"
```

- **Which URLs open.** Only a URL that is, character for character (fragment aside), one of:
  (a) a URL written in the owner message of the proof (an order has none);
  (b) a search result or page link the window returned earlier in the same task, or a redirect target;
  (c) an `https` URL without `?` on a host in `web.public_sites`.
  Anything else is `403 url-without-source` with `"message": "출처 없는 주소. 검색으로 찾아"`.
  Userinfo and ports other than the scheme's own are refused.
- **How it fetches.** The gate resolves the name, refuses if any address is not public
  (`web-private-address`), connects to that checked address (no second lookup), and sends a fixed
  `GET` with no body, cookie, authorization or caller header. Redirects are followed up to
  `max_redirects` (3), each hop resolved and checked again; one more is `502 too-many-redirects`.
  The body is read up to `max_bytes` (2 MiB) and cut there. HTML becomes text (scripts, styles, frames
  dropped, never run) plus its absolute links; text, JSON and XML pass as text; anything else is
  `415 unsupported-content-type`.
- **What it returns.** `text/plain`: the address, status and size, then the content between
  `[남의 글 시작 - ...]` and `[남의 글 끝]`, then the links the task may open next.
- **Search.** The query is refused before it leaves when it is empty or longer than `max_query_chars`
  (120), carries a key shape (`query-secret-shape`) or a mail address, phone, resident or account
  number shape (`query-personal-shape`). Without a provider in `web.search` the answer is then
  `503 search-off`, and the window still fetches. With one, a name, address or phone of the owner's
  contacts is `query-contact` (read through the gate's own Contacts grant, plus `owner_emails` and
  `owner_names`; `503 contacts-check-unavailable` when they cannot be read), and only then is the
  provider asked:
  - `"provider": "duckduckgo-html"` (owner 2026-10-29 14:12 KST Q377: no key, no cost, not an official
    API): the gate posts `q` to `https://html.duckduckgo.com/html/` (`kl` from `region`, default `wt-wt`)
    with its own User-Agent, the page itself as `Referer` (as its own form does; without it DuckDuckGo answers
    its bot check) and no cookie, reads the result titles, links and snippets, unwraps
    `duckduckgo.com/l/?uddg=` hops to the real address (that address becomes a rule (b) source; the
    hop itself never does) and drops ads. DuckDuckGo's bot check (an `anomaly` page, or 202/403/429)
    is `503 search-blocked`, logged as status `blocked`, and every search answers the same for
    `rest_seconds` (600) without asking DuckDuckGo again.
  - `"provider": "brave"` with `key_file` (readable by the gate user only): the Brave Search API;
    no key file is `503 search-off`. The key never leaves the gate.
- **Limits per task.** `max_opens_per_task` (40) fetches and `max_searches_per_task` (20) searches,
  then `429`. Tasks are kept in memory for 24 hours; a restart empties them (rule (b) starts over).
- **Log.** Every fetch hop and search appends `{ts, uid, kind, owner_message, host, status, bytes}` to
  `web.jsonl` (0600) and prints `GATE_WEB <kind> <host> <status> <bytes>`; never a path, query or
  content. Refusals go to `denials.jsonl` as `GET /fetch` or `GET /search` with the reason.

The firewall must let the Dori reach the new port: `install.sh` adds `listen.web` to `gate_ports`.

**omo's own tools through the window** (owner 2026-10-29 14:55 KST Q379 "다섯 도리 다 omo 웹 도구(검색·읽기)를
그대로 쓰되, 속은 창구(검문소)를 거치게"). `omo-web-window.js` is an omo extension that registers `web_search`
and `webfetch` under omo's own names; a user extension's tool replaces the builtin tool of the same name
(senpi `ExtensionRunner.getAllRegisteredTools`). Both call this window over plain loopback HTTP (never through
`HTTP(S)_PROXY`), with an optional `owner_message` argument (`<channel id>/<message id>`, or `order:<n>`; else
`DORI_OWNER_MESSAGE`) sent as the owner-proof header; without one nothing is sent. A refusal comes back to the
model as a tool error with the gate's reason and message. The extension also sets `PI_ANTHROPIC_WEB_SEARCH=0`
and `PI_OPENAI_WEB_SEARCH=0`: otherwise omo hands searches to the model company's server-side search, which
runs outside the gate. Enable it for one account with one file, `~/.omo/agent/extensions/dori-web-window.js`:

```js
export { default } from "file:///home/<account>/.dori/src/skills/dori-mode/setups/egress-gate/omo-web-window.js";
```

Test: `bun test omo-web-window.test.js` (a loopback fake window; `DORI_WEB_WINDOW` points the extension at it).

## Approval and journal

Outbound changes and the 11th delete/hour or 31st write/owner message are parked,
returning `202` with a card link. The gate posts short Korean cards (kind, recipients, title,
✅/⛔ only; the reason, owner-message link and expiry stay in the pending record) and checks every
20 seconds. A sharing or comment card on a Drive file shows that file's name and the access asked for
(`내용: <file> 공유(보기)`; an unreadable name says so with the file id), so the card alone tells who gets what. Only the owner's non-bot reaction counts. Cancel wins over approve.
Cards expire after 24 hours. Missing/tampered cards never execute. A SHA-256
content check precedes reactions. Clients cannot edit/delete pending cards or
add/remove their reactions through the Discord port. On any message, a client may remove only its own reaction
(`@me`); removing another account's reaction, all reactions of an emoji or all reactions is
`403 reaction-removal-not-allowed`, so the owner's ⛔ on a dashboard todo card stays for the todo proof.

Each card lives in a thread, and its result is written on the card there. A request
written inside a thread under the approval channel keeps its card in that thread; one
written in the approval channel gets a thread on that message; anything else opens a new
thread in the approval channel (any thread failure falls back to the channel); a new thread is named
`🔔 🔐 <kind> · <what>` (🔔: a card in it waits on the owner). When the card joins a thread a Dori opened
first (`dori thread open --from` on the owner's message, or a Dori thread the request was written in), that
thread is renamed to the same shape with the Dori's title kept: `🔔 정해영 OmO 문의 답장` becomes
`🔔 🔐 정해영 OmO 문의 답장`, so the decision later marks it like any card thread (2026-11-04). A name
already in that shape (one mark, then `🔐`, `✉️` or `📬`) and a thread the owner opened himself keep their
name; a failed rename is logged (`GATE_CARD_THREAD_RENAME_FAILED`) and the card is posted anyway. The cards one owner message asks for
share one thread (owner Q474, 2026-11-03; one request had made eighteen Drive sharing threads in two
minutes): a card or a batch card whose owner message already has an undecided card or batch card in a
thread goes into that thread, in any order and also when they arrive at once. Choosing the thread until the
card is on record holds the approval lock, so neither another card nor the poller's decisions (which close
threads) run in between. A thread whose cards were all decided is not reused. A newer card
for the same work in the same thread (same API, operation and path; for creates, the same
title) replaces the older undecided card: it is marked `🔁 새 판으로 대체됨` and never runs.
Once the last card in a thread the gate opened (its name starts `🔐 ` after any leading mark) is decided,
the thread gets one leading mark, `✅` (executed, 2xx), `⛔` (cancelled), `💤` (a day with no answer) or `❗`
(failed), in place of any mark it had (also the older `✅ 완료 · `-style words, so a name never shows two),
and is archived; the
owner's own threads and threads with an open card keep their title. At start the gate also titles
open card threads whose cards were all decided earlier (owner 2026-10-19 "승인 결과를 스레드 제목에
반영하게 해줘").
Discord reopens an archived thread on any new message. When a message posted through the
Discord port goes into a thread that was archived under one of those end marks (or an older
`✅ 완료 · `-style title; the gate's own card threads and the node's request threads use the same marks), the gate archives it again
right after the post. A decided thread someone else reopened, or one without a status title,
stays as it is. So does a decided thread that holds a live card: a message newer than the
thread's last title change that carries both ✅ and ⛔ reactions (a newer card for the same work
can land in a thread already titled decided). If the thread's history cannot be read, the gate
leaves it open rather than hide a card.
A card the owner already reacted to is left to the poller.

Pending requests are private JSON files in `pending/`. Execution is marked
durably before sending: an interrupted, uncertain write is never automatically
replayed after restart. Confirm its real upstream state before resubmitting.
An approved write is replayed with its original query string. The poller keeps running when
one check fails: a failure it does not expect is logged as `GATE_APPROVAL_CHECK_FAILED <type>`
(never the error text). On 2026-10-25 a Drive share with a query string ended the poller with
an unlogged TypeError, and no card ran after it until a restart.
`GET /_gate/pending` lists IDs, reasons, links, owner messages, ages, and `status` (`merged` with its `batch`
for a card waiting on a batch). A Drive card parked only by the owner-message limit also shows `item`: the
batch item that write is, ready to copy onto a batch list so the card merges.

### Batch approval

Owner 2026-10-30 10:56 KST Q390 "묶음 승인 만들기: 정리 목록 전체를 카드 하나로 보여 주고 ✅ 한 번이면 그 목록만 실행,
지금 29장도 거기 합침". A cleanup with more in-account Drive writes than the owner-message limit goes on one card.
Since Q447 (2026-11-02) that limit is off unless `limits.writes_per_owner_message` is set, so with the default
config no in-account write is parked and a batch is not needed; it stays for a config that sets the limit:

```
POST /_gate/batch                      (google port, X-Dori-Owner-Message: <channel>/<message>)
{"title": "도리집 정리", "items": [
  {"kind": "folder", "ref": "f1", "name": "짱돌", "parent": "<folder id>"},
  {"kind": "folder", "name": "2026-10", "parent_ref": "f1"},
  {"kind": "upload", "name": "a.md", "parent_ref": "f1", "size": 5, "sha256": "<hex of the bytes>"},
  {"kind": "move", "file": "<file id>", "from": "<folder id>", "to_ref": "f1"}]}
-> 202 {"status": "pending_approval", "batch": "<sha256>", "card": "<link>", "merged": <n>}
```

Only these three kinds exist. A folder made in the batch is named by its `ref`; a later item points at it
with `parent_ref`/`to_ref`. The whole list is refused (`403 batch-refused` with `reasons`) when an item
deletes or trashes (`batch-delete`), shares or comments (`batch-sharing`), invites (`batch-calendar`) or mails
(`batch-mail`), holds a URL (`batch-external-url`), points at a ref the list does not make
(`batch-parent-not-listed`), or names an existing file or folder that is not the owner's own, is in a shared
drive or is public (`batch-not-owned`); any other kind or field is `batch-kind-not-allowed`/`batch-invalid`.

The card goes where any card goes (the card-thread rules above). Its first line is
`묶음 승인 · 형 계정 안 쓰기 · 지우기 없음`, then the counts per kind and the upload total, the folder tree
(each existing folder with the new top folders under it), the number of merged waiting cards, and the owner
message. The batch id is the SHA-256 of the owner message, title and items; the same list again returns the
same card.

After the owner's ✅ a write carrying `X-Dori-Batch: <batch>` (no owner-message header needed) runs for 24
hours when it is exactly one open listed item: a folder create (`POST /drive/v3/files`, name, folder
mimeType, one parent), a multipart upload (`uploadType=multipart`, name, one parent, the same size and
SHA-256), or a move (`PATCH /drive/v3/files/<id>?addParents=<to>&removeParents=<from>`, empty body). It
skips only the owner-message write limit; any other reason (not owned, public, spreadsheet) is
`batch-write-needs-card`. Other writes are `batch-item-not-listed`, a second run of a done (or uncertain)
item `batch-item-used`, a wrong id `batch-unknown`, before ✅ or after ⛔/expiry `batch-not-approved`, after
the day `batch-expired`. A listed write the service refused (non-2xx) can be sent again; a folder create or
upload whose answer never came is never sent again. A move is different, because sending it twice changes
nothing: when its answer does not come, the gate reads the file's parents back (`root` is resolved to the
real My Drive id). If the file sits under the new parent and not the old one, the write is journaled as 200
with `"verified": "read-back-moved"`, the item is done, and the caller gets 200. If it is still under the
old parent, the item goes back to open and the caller gets 502 `{"error": "upstream-unavailable",
"moved": false}`, so it can send the move again. Otherwise the item is uncertain (`"moved": null`). An
uncertain move can be sent again. The gate checks its parents first, and if the move already landed it
answers 200 with `"alreadyMoved": true` without writing. The journal line is
`GATE_MOVE_READBACK moved|not-moved|unclear|already-moved <file id>`.

Google writes wait up to `google_write_timeout_seconds` (default 300) for Google's answer. On 2026-11-01
Drive folder moves took 14-28 s, and many took longer than the old fixed 30 s. The gate gave up on them as
`upstream-unavailable` while Google was still working, so 42 PARA moves went uncertain. Each write is journaled as usual with `approved_by` (the batch card) and
`batch`. `GET /_gate/batch/<batch>` shows the status, each item's state and the ids of folders made so far.
Writes without the header are judged exactly as before.

Undecided cards the owner-message limit parked for the same owner message that are on the list are merged
when the batch is posted: the card gets `🔗 묶음 카드로 합침 → <batch card>` on top and stops answering its own
reactions. When the batch card is decided they close with it: ✅ runs each once under the batch
(`✅ 실행됨`), ⛔ or expiry closes them unrun, and their threads follow the thread rules. Cards with any other
reason and cards not on the list stay as they are. If the batch card goes missing or is edited, its merged
cards go back to waiting on their own.

For the Dori, only when the config sets the write limit: "한 형 글에서 형 드라이브 안 쓰기(폴더 만들기·올리기·옮기기)가 30건을 넘을 것 같으면 하나씩 카드를 만들지 말고
목록 전체를 POST /_gate/batch로 한 번 내고, 형 ✅ 뒤 각 쓰기에 X-Dori-Batch 머리를 붙인다."

Changes/denials are in `changes.jsonl`/`denials.jsonl` (0600), snapshots in
`snapshots/` (0700 directory, 0600 files). Each Google write carries its original
owner-message link, pre-change snapshot where applicable, and approval-card link
when approved. A write on a dashboard order has the order link as `owner_message` and
`owner_order` `{id, url, body_sha256, created_at, device}` (`url` is `owner_order.link` with `{id}`
filled in, else the API address), next to the written resource's title, so each change can be
matched with the order's text. A write on a card-approved todo has the todo link as `owner_message` and
`owner_todo` `{id, url, approved_at, card}` (`card` the approval card's Discord link). Logs exclude request bodies, authorization and query credentials;
snapshots and parked bodies are confidential state, not diagnostic logs.
New-resource creation has no previous state, so its snapshot is null.

```sh
python3 -I gatectl.py status
python3 -I gatectl.py auth-url
python3 -I gatectl.py auth-finish 'http://localhost/?code=...&state=...'
python3 -I gatectl.py tokeninfo
python3 -I gatectl.py changes --since 24h
python3 -I gatectl.py restore CHANGE_ID
python3 -I gatectl.py restore CHANGE_ID --owner-message CHANNEL_ID/MESSAGE_ID
```

OAuth uses installed-app `client_secret.json` in the state directory, PKCE S256,
offline consent, and `http://localhost`. Keep it and `owner-bot-token` at 0600.
Refresh tokens are stored in `google-token.json` (0600), access tokens in memory.
`auth-finish` rejects sending Gmail scopes and every scope outside the config.
Contacts lookup needs `contacts.readonly` and `contacts.other.readonly` in `google_scopes`;
after adding them, run `auth-url` again and have the owner consent once (the old token keeps
working until then, and contacts reads return Google's 403 until it is replaced).
Do not put credentials in config, command-line logs, or environment dumps.

`GET /_gate/changes?since=24h` also accepts an ISO timestamp.
`POST /_gate/restore/ID` reinserts deleted events/tasks, restores event/task
updates, reverses Drive trash and metadata/parent changes, or restores vault
content. Restores are writes, checked and journaled, and may themselves need a
card. Docs uses version history (409). Drive binary contents, ACL/permission
edits, and comment edits cannot be restored by this metadata journal.

## Optional vault

Add `"vault": {"dir": "/private/vault-clone", "remote": "git@host:repo.git",
"ssh_key": "/private/vault-key", "allowed_prefix": "Notes"}`.
The gate operates only its dedicated clone, pulls with rebase, commits and pushes
with that SSH key. Git operations have a 120-second timeout; push failure fetches
and resets the gate's clone to its upstream. Never point this at a human checkout.
`GET /_vault/note?path=Notes/example.md` reads;
`PUT` writes UTF-8 Markdown with owner proof. Without vault config: 503.

## Daily summary

```sh
python3 -I summary.py --hours 24
python3 -I summary.py --config /etc/dori-gate/config.json --hours 24 --post
```

The first command reads the gate endpoint (admin UID allowed) and prints nothing
when no changes exist. The second is suitable for an external systemd timer,
running as the gate user: reads journals/pending directly and posts a short
phone-sized message: a head line (changes in the window), one line of counts per
kind (`일정 4(추가 3·수정 1) · 할 일 1`), the latest three `HH:MM title` (KST),
titles matching `게이트 시험`/`gate test` folded into one line, a count of restorable
deletes, one line of failed/refused/pending counts, and `자세한 건 <name>에게 물어보면
올림`. Optional config `"dori_name"` names the Dori in the head and last lines.
`막힌 쓰기` counts refused writes only: a `denials.jsonl` row whose method is not
`GET`/`HEAD`/`CONNECT` and whose reason is not an upstream failure (`request-failed`,
`upstream-unavailable`, ...). Refused CONNECT tunnels (a tool's telemetry host off the allow
list), refused reads and upstream failures stay in the journal and are not posted; with
nothing else to say the summary prints `SUMMARY_EMPTY`.
Links, owner proof, approvals and restore IDs stay in the journal only; the Dori
reads them from `GET /_gate/changes` and `GET /_gate/pending` when the owner asks.
Posts using the gate bot to the configured approval channel in chunks below 1900
characters. Prints `SUMMARY_EMPTY` or
`SUMMARY_POSTED N messages`. No service or timer is installed by these files.

## One gate holds the keys: forward mode and named grants

When the Dori host and the machine that keeps the owner's keys are different, run this same gate on
both and keep every Google (and vault) credential, every approval card and the journal on one of them
("the node gate"). Without the keys below in the config nothing changes.

**Forward mode** (the keyless gate, on the Dori host). Add
`"google_forward": {"unix": "/run/dori-gate-node/gate.sock"}` (`timeout` defaults to 360 s, longer than the
node gate's Google write wait). The Google port then
checks only the caller uid (`clients`) and passes the request (path, query, body,
`X-Dori-Owner-Message`; never `Authorization`) unchanged to the node gate, which does the owner proof,
the direct-or-card decision, the card, the write and the journal. The CONNECT allow list and the Discord
port stay local and unchanged. It parks nothing and runs no approval poller. `/_admin/status` answers
`mode: forward`; every other admin path answers `409 keys-on-node`. A node gate out of reach is
`502 node-gate-unavailable`, never a direct Google call. It refuses to start (`GATE_FORWARD_REFUSED
<reason>`, exit 3) while its state still holds `*-token.json` or `client_secret.json`, an open card in
`pending/`, or the config still has `vault`, `grants` or `token_clients`: move those first.

The socket comes from `systemd/dori-gate-node-tunnel.service` (`ssh -N -L <socket>:127.0.0.1:3129`, as
the gate user, its own key `/var/lib/dori-gate/node-tunnel-key` and a pinned `node-known-hosts`; the
socket is 0600) plus the drop-in `systemd/dori-gate.service.d/forward.conf`. On the node, a relay account
with one authorized_keys line that allows only this forward:
`restrict,port-forwarding,permitopen="127.0.0.1:3129",command="/usr/bin/false",from="<dori host>" <key>`.
The node gate sees the relay account's uid, so its `clients` is `[<relay uid>]`.

**Node gate.** A listener whose port is `null` stays off (`"listen": {"connect": null, "google": 3129,
"discord": null}` until the Dori itself lives there). Named grants hold other refresh tokens for local
jobs that cannot carry an owner message (scheduled reminders, Drive publishing):

```json
"grants": {"jobs": {"scopes": ["openid", "https://www.googleapis.com/auth/calendar", "..."],
                    "token_file": "jobs-token.json"}},
"token_clients": [1002]
```

`GET /_gate/access-token?grant=jobs` from a `token_clients` uid returns
`{"access_token", "expires_in", "scope"}` (never a refresh token) and appends
`{ts, uid, grant}` to `tokens.jsonl`; everyone else gets `403 token-client-required`, a grant not yet
consented `503 google-auth-required`, and the reverse API's own grant is never minted
(`400 grant-required`). A named grant may hold send-capable scopes (the jobs it serves send approved
mail themselves); the reverse API's grant still may not. Consent per grant:
`gatectl.py auth-url --grant jobs`, then `gatectl.py auth-finish --grant jobs '<redirect>'`.
`gatectl.py status` lists `grants` with presence and scopes only.

## Tests

```sh
python3 -I -m unittest discover -s . -p test_gate.py -v
python3 -I -m py_compile gate.py gatectl.py summary.py test_gate.py
```

Tests use ephemeral loopback fake Google/Discord upstreams and temporary private
state. Trusted test injection points: `upstreams` (host to base URL),
`web.dial` (checked public address to a loopback plain-HTTP `[host, port]`), `web.search.endpoint`,
`discord_api_base`, `tokeninfo_url`, `proc_tcp_paths`, installed-client `token_uri`,
and ephemeral listener ports (`0`). Never make config writable by the client UID.

Python's isolated mode removes the current directory from the import search
path, so `python3 -I -m unittest test_gate.py -v` fails to import the test module.
Discovery explicitly adds its start directory while retaining isolated mode.
