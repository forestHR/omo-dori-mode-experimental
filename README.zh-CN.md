[English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omo-dori-mode-experimental

Dori 模式把一个编程智能体会话变成常驻的消息智能体。你只需要在 Telegram 或 Discord 上和一个机器人对话。Dori 把每件事交给 herdr 标签页或 aoe/tmux 会话里单独启动的智能体，记住自己启动过的每个会话，只有在工作真正完成后才关闭它:PR 已合并、issue 已关闭、版本已发布。

它由一个技能(`skills/dori-mode/SKILL.md` 和 references)以及一个用 bun + TypeScript 写的小 CLI `dori` 组成。目前还是实验版本，会有不完善的地方。

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | bash
```

它会把仓库克隆到 `~/.dori/src`,把技能链接到 `~/.agents/skills/dori-mode`,用 `bun link` 把 `dori` 放进 PATH,并把示例配置复制到 `~/.dori/config.json`。如果你的智能体从别的目录加载技能，请设置 `SKILLS_DIR`。

默认后端是 herdr。使用 aoe/tmux 时:

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | DORI_BACKEND=aoe bash
```

`DORI_BACKEND=aoe` 在没有配置文件时复制 `backend: "aoe"` 的配置；已有配置及其后端保持不变。把 `leadPane` 设置为 lead 的 aoe/tmux 会话名。`DORI_REPO` 可覆盖克隆 URL。PATH 中既没有 herdr 也没有 aoe + tmux 时，安装程序会警告；缺少 `gh` 和 `agent-messenger` 只会给出可选工具警告。如果已有安装的 origin 不是这个 fork(或指定的 `DORI_REPO`),会显示警告和重新指向的命令，不会悄悄修改远端，也不会从旧 origin 拉取。

然后在 herdr 里打开智能体；使用 aoe 后端时在 aoe 会话里打开，说一句 "Dori mode" 就行。完整的 Discord + aoe/tmux 服务设置见 [`setups/discord-aoe`](skills/dori-mode/setups/discord-aoe/README.md)。日常运行中总结的经验(完成声明会关闭 lane、暂停等待所有者答复的 lane、应用脚本更新、用影子运行替换监听器)见 [`references/operating-lessons.md`](skills/dori-mode/references/operating-lessons.md)。

## 依赖

- [bun](https://bun.sh) 1.3 或更新版本，以及 git
- 用于 lane 标签页的 [herdr](https://herdr.dev),或用于 lane 会话的 [agent-of-empires (aoe)](https://github.com/njbrake/agent-of-empires) 和 `tmux`
- 能加载技能的编程智能体(按 [OmO](https://github.com/code-yeongyu/oh-my-openagent) 设计，启动命令可以在配置里改)
- 用来确认 PR 合并和 issue 关闭的 `gh`(GitHub CLI),以及确认已发布版本的 `npm`
- 机器人本身用的 [agent-messenger](https://github.com/agent-messenger/agent-messenger)

主机监控在 macOS 上功能完整。在 Linux 上只看负载和磁盘，内存和 swap 显示为未知。

## 给你的 Dori 起名

Dori 第一件事就是问你该怎么称呼它。直接叫 "Dori" 可以，用 Dori 结尾的名字也可以，比如 ShipDori 或 WorkDori,同时运行好几个时更好区分。定下的名字会用在机器人名、消息落款和模式名上，下次只要说一句 "ShipDori mode" 就能重新开启。

## 用 Slack 时

如果你选 Slack,Dori 会再问一个问题，等你回答:

- **用户令牌**:作为工作区里的真实成员行动。需要一个付费席位，费用由你承担。这个成员能看到的它都能读，也能一直显示绿色在线点。
- **机器人令牌**:作为 Slack 应用行动。没有席位费用，但只能看到被邀请进的频道，并且受限于你给应用的权限范围。

## Dori 怎么说话

Dori 会跟着你的说话方式走。你写得简短、随意、用小写，它也这样回。消息用文字，不用表情符号；但 `discord.statusStyle` 为 `"emoji"` 时，Discord 状态标记可以用表情符号，监听器也会用眼睛反应表示已读。一条回复有好几部分时，它会拆成几条短消息发，而不是一大段;每条准备好就立刻发，不故意停顿。唯一的例外是不断变化的进度：那始终是一条消息，原地修改。

## 配置

所有配置都在 `~/.dori/config.json` 里，每一项都可以省略。通常需要设置的是这些:

| 字段 | 含义 |
|---|---|
| `backend` | `"herdr"`(默认)或 `"aoe"` |
| `leadPane` | Dori 自己的 herdr pane(`herdr pane current`),或 aoe 的 tmux 会话名(`tmux display-message -p '#S'`)。各条 lane 的汇报会发到这里。 |
| `laneWorkspace` | 新 lane 标签页打开的 herdr workspace;aoe 不使用此项 |
| `ignorePanes`, `workspaces` | 要跳过的 pane 和 workspace 筛选；aoe 使用 tmux 会话名和 profile 名，`workspaces` 也可留空 |
| `defaultCwd` | lane 的起始目录，也是 lane 创建 worktree 的仓库 |
| `agentCommand` | 启动智能体的命令，写成含 `{model}` 和 `{prompt}` 的 argv 列表 |
| `hooks.threadReply`, `hooks.threadDone` | 你的消息 CLI,写成含 `{thread}` 和 `{text}` 的 argv 列表，用来发布 lane 进度和标记完成 |
| `discord.statusStyle` | Discord 状态标记使用 `"words"`(默认)或 `"emoji"` |
| `discord.autoUnEye` | `true`(默认)时，机器人在某个频道或线程里发言后，`dori inbound discord` 会移除所有者在那里更早消息上的眼睛反应；`false` 则保留 |
| `discord.quietText`、`discord.postRawReports` | `freshness` 发到所有者线程里的话(`{min}` = 距最后一条报告的分钟数)，用所有者的语言；lane 的报告原文交给 lead,不进线程。`postRawReports: true`(默认 `false`)时原样发布。关闭时先发 lane 写给所有者的总结(`claim-done --summary`,没有则由模型写),发出后才把线程标为完成；没有总结就不关闭 |

其余项(时间、阈值、heavy 槽位数)用默认值就够了。完整表格见 [`references/scripts.md`](skills/dori-mode/references/scripts.md)。环境变量 `DORI_CONFIG`、`DORI_STATE_DIR`、`DORI_LEAD_PANE` 优先于配置文件。

### 打开 aoe/tmux lane

lead 也在 aoe 中运行，例如这样配置:

```json
{
  "backend": "aoe",
  "leadPane": "aoe_Dori_0a1b2c3d",
  "agentCommand": ["omo", "--model", "{model}", "{prompt}"],
  "workspaces": [],
  "discord": { "statusStyle": "emoji" }
}
```

智能体必须是可用的 aoe 工具(`aoe agents` 列出内置工具，自定义工具在 aoe 设置中注册)。herdr 使用完整的 `agentCommand` argv 模板。aoe 只用 `agentCommand[0]` 选择工具，通过 `--extra-args` 传入模型，其余参数不使用。

准备好 brief 后，两种后端都用同一条命令打开 lane:

```sh
dori launch fix-login --title "Fix login" --brief ~/.dori/briefs/fix-login.md \
  --done "merged acme/app#412" --thread discord:100000000000000001
```

herdr 打开标签页。aoe 运行 `aoe add <cwd> -t <key> --tool <tool> -l --extra-args "--model <model>"`,最多等待三分钟让智能体显示 `❯` 提示符，再输入 lane 提示词。启动失败会输出 `STARTUP_ERROR`。登记表中的 pane 是 `aoe_fix-login_1a2b3c4d` 这样的 tmux 会话名；aoe 会拒绝已有的标题/路径组合，即使它还在回收站中。

footer 要求 lane 向 lead 发送 `[REPORT] <key> | <milestone|blocker|question|done> | <text>`。aoe 用两个 argv 数组发送，不经过 shell 字符串:

```json
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "-l", "--", "[REPORT] fix-login | milestone | tests passed"]
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "Enter"]
```

`dori freshness` 先从 lead 屏幕读取报告，再看 lane 屏幕。新报告会重置静默计时；默认 15 分钟后提醒，20 分钟后通过 `hooks.threadReply` 发布一行用所有者语言写的简短状态(`discord.quietText`)，每段静默期各执行一次。lane 的报告原文发到 lead 屏幕，由 lead 用人话转述；`discord.postRawReports: true` 时照旧发布原文。

aoe 下，working 或 not-done 的 lane 停下来等人时，`dori watch` 输出 `LANE_BLOCKED <key> <waiting|error|question|idle> <pane>`。它结合 `aoe ps --json` 和屏幕判断：回合运行中不会输出，idle 必须持续 45 秒，等待 monitor、wake source 或正在执行/已安排的 goal 不算 idle。等待会话自己启动的已分离 eval 单元、后台 bash 会话或后台 task 也不算 idle：监控日志只留一行安静的 `BG_WAITING`，超过 `blockedWaitMin`(默认 60 分钟)后才输出 `LANE_BLOCKED`。关闭时会停止 aoe 会话并移入回收站，绝不永久删除。

## 初次了解(Onboarding)

第一次设置时,Dori 在读取你的任何东西之前，会先征求同意：能不能了解一下你用哪些工具、在做什么、为什么做，以及你和你的公司是什么样的。只有你同意了，它才会一个一个地查看你的工具。每个工具它都会先说明要用哪个集成、会读取什么，再单独问你。比如:"有一个能读取 Gmail 和日历的 CLI,我想用它帮你留意日程和邮件，可以吗?"你拒绝的工具会被跳过，它也会记住你拒绝过。

整个过程只读不写。它边看边把了解到的内容写进记忆，最后简短地告诉你它了解了什么、还缺什么。完整流程见 [`references/onboarding.md`](skills/dori-mode/references/onboarding.md)。

## 怎么处理一个请求

每条消息怎么处理，由 Dori 自己决定。

- 提问、查状态、查资料，直接回答，不开新会话。任何改动，哪怕只是一行修改或一个配置值，都交给一条 lane,让你能看到它的线程和 Done 检查。
- 最终要提交 PR 的代码工作、多步骤的工作、耗时长或可以并行的工作，开一条 lane。如果已经有一条空闲的 lane 负责这个仓库，就交给它，不再新开。
- 内存、磁盘或 pane 数量不够时(`dori can-launch` 显示 HOLD),不开新 lane。工作先排队，并告诉你原因。
- 新的工作开新的线程。后续的跟进回到原来的线程，如果那条 lane 已关闭，就重新打开记录下来的会话。简单的问题在哪里问的就在哪里答。

## 会话登记表

每条 lane 在 `~/.dori/state/lanes/` 下有一个 JSON 文件。它把消息线程对应到 herdr pane 或 aoe tmux 会话名，把 pane 对应到智能体自己的会话 id,并记录状态(`working`、`done-claimed`、`verified-done`、`not-done`、`paused`、`closed`)以及每次变化的历史。

`dori sync` 会把登记表和实际在运行的 pane 对照，告诉你哪里对不上：消失的 pane、变了的会话 id、没有办法证明已完成的 lane。它不会删除任何东西。加上 `--write` 会把找到的会话 id 存下来。

## 5 分钟完成流程

lane 声明自己已完成:

```sh
dori claim-done fix-login --evidence "merged acme/app#412 (a1b2c3d)"
```

Dori 收到 `LANE_DONE_CLAIMED`,lane 会被告知 5 分钟后关闭。这期间你可以提出异议:

```sh
dori object-done fix-login --reason "缺少 changelog 条目"
```

理由会原样发给 lane,lane 修好后再次声明完成。如果没人反对，时间一到 `dori watch` 就会关闭这条 lane。关闭前它会重新实时读取每个 `Done =` 信号；如果 worktree 里还有没推到远端的提交或未提交的改动，它就不关闭，声明会带着原因退回 not-done。重启 watcher 不会让 5 分钟重新计时。这期间给它新的工作，完成声明就会撤回：用 `dori type` 给 lane 新指示，或安静下来的 lane 又开始一轮，监视日志会记下 `LANE_CLAIM_REOPENED`，lane 继续工作，之后再声明完成。对已经关闭的 lane 执行 `dori type`，会返回 `LANE_IS_CLOSED`，并说明何时、由谁关闭。

### 怎样才算完成

lane 的 `Done =` 行写的是 watcher 能自己检查的信号:
- PR 已合并
- issue 已关闭
- 包的版本已发布
- 对于不以 PR 结束的工作(本地设置、QA、运行中的服务):退出码为 0 的命令、哈希或 JSON 字段符合预期的文件、返回预期状态码和内容的 URL

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

关闭 lane 时,watcher 会自己重新运行这些检查，不经过 shell,也从不凭 lane 自己的说法就算数。无法解析的信号在启动 lane 时就会被拒绝。完整语法见 [`references/sessions.md`](skills/dori-mode/references/sessions.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `dori launch <key> ...` | 在 brief 里写入 lane footer,打开 herdr 标签页或 aoe 会话，启动智能体，检查启动错误；如果 `Done =` 的信号全都只检查文件或文字，会警告 `LAUNCH_DONE_WEAK`(lane 照样打开),`--done-weak-ok` 可关掉；`--ui` 把所有者的 UI 七步([ui-work.md](skills/dori-mode/references/ui-work.md))放到 brief 最前面，看起来是 UI 工作的 brief 没加 `--ui` 时会警告 `LAUNCH_UI_HINT`(lane 照样打开);brief 里完全没有所有者的八步([sessions.md](skills/dori-mode/references/sessions.md))时，会原样加在四个栏目之后(`LAUNCH_STEPS_ADDED`),只有一部分时不添加，只警告 `LAUNCH_STEPS_PARTIAL`;所有者的指令台账([directives.json](skills/dori-mode/references/directives.json) 加主机本地文件)中适用但 brief 缺少的指令会原样加入(`LAUNCH_DIRECTIVE_ADDED`),缺少必需指令时停止(`LAUNCH_DIRECTIVE_MISSING`,退出码 4,只有 `--waive <id> "<原因>"` 才放行);`dori directive-audit` 每天早上把前一天的 lane 与台账核对 |
| `dori adopt <key> --pane ID ...` | 登记一条已经在运行的 lane |
| `dori sync [--write]` | 对照登记表和实际 pane,列出不一致 |
| `dori claim-done` / `object-done` / `close` | 完成流程；设置了 `DORI_DISCORD_TOKEN` 时，close 会把 `discord:` 工作线程标为完成并归档 |
| `dori pause <key> <原因>` / `dori resume <key>` | 暂停一条在等人的 lane:不再催促或代发进度、不报 `LANE_BLOCKED` 和 `DEAD_PANE`,完成声明也不会自动关闭它；使用 aoe 时还会暂停该 lane 会话的 omo goal 并读回确认(`/goal pause`,未确认则 `PAUSE_UNVERIFIED`,exit 3);`resume` 恢复暂停前的状态和被暂停的 goal |
| `dori watch` | 自动关闭的 watcher,以及 aoe `LANE_BLOCKED` 事件，作为常驻监控运行 |
| `dori freshness [--loop MIN]` | 提醒变安静的 lane,在线程里发一行简短状态，把最后一条汇报交给 lead |
| `dori dead-panes [--loop MIN]` | 报告已停止的智能体 pane |
| `dori guard [--loop MIN]` | 负载、内存、磁盘和 pane 数量告警 |
| `dori fix-attempt <key> --metric M --hypothesis H` | 记一次你让 lane 做的修复;lane 在这类汇报里加 `(fix: M / H)`,同一指标、同一假设到第三次时,`SAME_FIX_3` 提醒你让 lane 转去查根因;记录之前先列出该指标上已经试过的假设(`PRIOR_FIX`) |
| `dori signals [--lane K \| --cwd DIR \| --tag T]` | 同一工作领域里以前的 lane 试过什么、结果如何:编号的修复尝试和转去查根因的时刻(也从 `[REPORT]` 行和 lead 的重新指示里读取)、按指标的标记修复、带理由的完成声明驳回、重发和催促次数、结果、该领域的驳回率和返工、警告。重新指示 lane 之前先看它 |
| `dori scorecard [--date D] [--post]` | 只用记录算出的每日 token 成绩单(不调用模型):每个验证完成的成本和完成声明的驳回率并排，返工最多的 lane、首次回复中位数/p90、lead 的上下文税;保存到 `<stateDir>/scorecard/<日期>.json` 和 `latest.md` 供 lead 查看,`--post` 也发到 Discord(默认关闭;每天保存的 systemd timer 在 Discord + aoe 配置里) |
| `dori heavy <label> [--mem 70G] -- <cmd>` | 负载低时在带内存上限的独立 scope 中运行构建、测试或 GPU 任务(超出时只停该任务,lane 不受影响);已有任务在跑时,只有 GPU、内存、CPU 各自仍剩 10% 以上才同时运行 |
| `dori heavy <label> --kind browser\|cpu --sync DIR -- <cmd>` | 在较空闲的那台 PC 上运行同样的任务:helper 主机接收 `--sync` 目录，在无网络的沙箱里运行，再把改动的文件拷回 |

发给 pane 的文字总是作为一个参数传入，从不经过 shell 字符串，并且会确认 Enter 真的生效了。

## 实用工具

CLI 还带有 Dori 需要的消息相关功能，也可以作为 `scripts/src/messenger/` 下带类型的模块直接引用。

| 命令 | 作用 |
|---|---|
| `dori send slack\|telegram\|discord --to T --text X [--thread ID] [--edit ID]` | 发送或编辑消息。遇到限流会等待后重发，含有 `$(` 的文字会被拒绝 |
| `dori presence slack\|discord` | 让账号保持在线显示。Discord 机器人通过网关保持;Slack 用户账号通过每分钟发一次信号的网页客户端连接保持 |
| `dori transcribe <file>` | 用 `hooks.transcribe` 的命令把语音消息转成文字 |
| `dori can-launch` | 看看还有没有余量再开一条 lane |
| `dori inbound slack [--loop MIN]` | 不漏掉 Slack 上发给 Dori 的任何消息:Threads 视图里的未读回复、Dori 发过言的线程里的新回复(没 @ 也算)、有未读提及的私信和频道 |
| `dori inbound discord` | 接收所有者消息、语音转录和问题卡片答案的网关监听器 |
| `dori ask` / `questions [--open]` / `reopen <Qn>` / `resolve <Qn>` | 发布、列出、重新打开、解决 Discord 问题卡片 |
| `dori thread reply\|wait\|done discord:<id> <text>` | 在工作线程发消息并标记工作中、等待或完成；完成时归档 |

没有对应命令、但模块里提供的功能:
- Telegram:以 "Thinking…" 开头的 `sendMessageDraft` 流式输出、论坛话题、HTML 表格
- Discord:创建线程、改名、归档
- Slack:上传文件
- `typingWhile`:工作进行时一直显示"正在输入"

Dori 在 Slack 上发的每条消息，不管是哪个函数发出的，都会记下所在线程。即使根消息是用原始 API 调用发的，下面没 @ 它的回复也能收到；只监听消息事件的做法会漏掉这种回复。

令牌从 `DORI_SLACK_TOKEN`(用户令牌还需要 `DORI_SLACK_COOKIE`)、`DORI_TELEGRAM_TOKEN` 和 `DORI_DISCORD_TOKEN` 读取。

### Discord 问题卡片和线程状态

在环境变量或 `~/.dori/dori.env` 中设置 `DORI_DISCORD_TOKEN`、`DORI_DISCORD_GUILD`、`DORI_DISCORD_CHANNEL` 和 `DORI_DISCORD_OWNER`(已有环境变量优先)。开启机器人的 Message Content intent,持续运行 `dori inbound discord` 才能接收按钮和输入框答案。可选：`DORI_DISCORD_PAIR_CHANNEL` 指定与其他 Dori 共用的频道；`DORI_DISCORD_PAIR_BOT` 接受一个或多个机器人 ID，以逗号或空白分隔(例如三个 Dori 共用一个 pair 频道，各自列出另外两个机器人)。所有者在那里的消息记为 `scope:"pair"` 行，列出的机器人消息记为 `scope:"pair-bot"` 行(只是信息，不是请求)。`DORI_DISCORD_STATE_DIR` 改变问题卡片的存放目录(默认 `<stateDir>/discord`)。设置 `DORI_DISCORD_SHADOW_INBOX=<文件>` 会运行第二个只写 inbox 行、从不写入 Discord 的监听器，便于切换前与正在运行的监听器对照。

```sh
dori ask --text "发布登录修复吗?" --option "现在发布" --option "等 QA" \
  --thread discord:100000000000000001 --tmux aoe_fix-login_1a2b3c4d
dori questions --open
dori reopen Q1
dori resolve Q1
```

1–9 个选项各自在短 `Pick N` 按钮旁显示全文；把推荐选项放在第一位，它的按钮会突出显示。“自己填写”按钮打开输入框。只有所有者可以回答，也只会 @ 所有者。回答后卡片折叠成记录，答案写入 `~/.dori/state/discord/` 下的 `answers.jsonl` 和监听器 inbox;`--session` 和 `--tmux` 信息用于确定要把答案转交给哪个会话。

带 `--thread` 时，卡片发布在对应工作线程内，并把线程标为等待。回答就在原处折叠成记录，不另发记录行；该线程没有其他未回答问题时回到工作中。`dori reopen` 恢复按钮并再次把线程标为等待。不带 `--thread` 时，新卡片发布到配置的频道。以前发布在频道且关联线程的卡片，仍会在该线程留下不发通知的答案记录。后续工作完成后，`dori resolve` 从跟踪列表移除问题，折叠后的卡片仍留在聊天中。用 resolve 移除一张未回答的卡片时，如果该线程没有其他未回答问题，线程同样回到工作中，不会因为放弃的问题一直停在等待。

`discord.statusStyle: "emoji"` 在线程名开头使用 🔄 工作中、⏸️ 等待、✅ 完成；默认 `"words"` 使用 `[working]`、`[waiting]`、`[done]`。标记只加在线程上：把文字频道、论坛或分类当作线程传入(例如 `dori ask --thread` 用了频道 id)时名称保持不变，该状态以 `THREAD_STATUS_DROPPED <id> ... is not a thread` 丢弃。`dori thread reply` / `wait` / `done` 设置这些状态；done 归档，reply/wait 取消归档。所有者在完成线程发消息时，监听器会把它重新打开并标为工作中。服务及卡片文字本地化设置见 [Discord + aoe 设置](skills/dori-mode/setups/discord-aoe/README.md)。

### 用 iPhone 快捷指令发语音指令

Discord 的 iOS 应用无法被快捷指令操控，所以想一键发送语音指令需要绕个路：iOS 快捷指令录音，再把录音发到 Dori 频道里的 Discord Webhook。把该 Webhook 的 ID 设为 `DORI_DISCORD_OWNER_WEBHOOK` 后，`dori inbound discord` 会把它的消息当作所有者本人的语音消息：加上眼睛表情回应、转写成文字，并以带 `"via":"owner-webhook"` 的行写入 inbox。设置 ID 之前，Webhook 消息只会记录到日志(`DISCORD_WEBHOOK_UNKNOWN id=...`)。创建 Webhook、快捷指令动作设置、通过操作按钮/轻点背面/Siri 调用以及安全注意事项，见 [iOS 快捷指令语音指令指南](skills/dori-mode/setups/discord-aoe/ios-shortcut-voice.md)。

## 测试

没有 CI,测试在本地运行:

```sh
cd skills/dori-mode/scripts
bun install
bun test           # 用假的 herdr、aoe、tmux、git、gh 和 Discord HTTP/网关验证行为
bunx tsc --noEmit  # 类型检查
```

测试覆盖两种后端、启动与报告传递、freshness、阻塞的 lane、完成流程及 Discord 卡片/状态。外部工具和 Discord HTTP/网关均使用替身，不会碰真实的 pane、仓库、GitHub 或 Discord 账号。

## 许可证

MIT

## 从 Dori 迁移

如果你之前用 gist 设置过 Dori 模式，机器人照常能用。改下面四处，它就成了 Dori。

1. **起一个 Dori 名字。** 就叫 "Dori",或者用 Dori 结尾的名字，比如 ShipDori、WorkDori。对智能体说:"从现在起你叫 ShipDori,这是 ShipDori mode。"之后开启模式的说法就从 "Dori mode" 换成 "ShipDori mode"。
2. **改机器人的名字和头像。**
   - Telegram:在 @BotFather 里发送 `/setname`,选中机器人，再发新名字。接着发送 `/setuserpic`,选中机器人，再发新图片。默认的 Dori 头像是 [`skills/dori-mode/assets/dori-avatar.png`](skills/dori-mode/assets/dori-avatar.png),也可以换成你喜欢的图片。机器人的名字和头像只能通过 BotFather 修改。
   - Discord:在 Developer Portal 打开你的应用。在 **Bot** 页面改用户名和图标，在 **General Information** 页面改应用名和图标(可以用同一张默认头像),然后保存。
3. **安装这个仓库。** 运行上面的一行安装命令，再对智能体说 "ShipDori mode",它就会用这个技能和 `dori` CLI,不再用以前粘贴的提示词。
4. **做一次初次了解。** 如果 Dori 时期没做过，说一句"做一下 onboarding"就行。

原有的线程、话题和记忆都会保留。
