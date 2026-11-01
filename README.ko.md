[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omo-dori-mode-experimental

Dori 모드는 코딩 에이전트 세션 하나를 늘 켜져 있는 메신저 에이전트로 바꿉니다. 사용자는 텔레그램이나 디스코드에서 봇 하나와 이야기합니다. Dori는 일마다 herdr 탭이나 aoe/tmux 세션에 에이전트를 따로 띄워 맡기고, 자기가 띄운 세션을 모두 기억하며, 일이 정말 끝났을 때만 닫습니다. PR이 머지되고, 이슈가 닫히고, 버전이 배포된 다음에요.

스킬(`skills/dori-mode/SKILL.md`와 references)과 bun + TypeScript로 만든 작은 CLI `dori`로 구성됩니다. 아직 실험 단계라 거친 부분이 남아 있어요.

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | bash
```

저장소를 `~/.dori/src`에 받고, 스킬을 `~/.agents/skills/dori-mode`에 링크하고, `bun link`로 `dori`를 PATH에 올리고, 예시 설정을 `~/.dori/config.json`에 복사합니다. 에이전트가 다른 곳에서 스킬을 읽는다면 `SKILLS_DIR`를 지정하세요.

기본 백엔드는 herdr입니다. aoe/tmux를 쓰려면:

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | DORI_BACKEND=aoe bash
```

`DORI_BACKEND=aoe`는 설정 파일이 없을 때 `backend: "aoe"`인 설정을 복사합니다. 기존 설정은 백엔드를 포함해 유지합니다. `leadPane`은 리드의 aoe/tmux 세션 이름으로 설정하세요. `DORI_REPO`로 복제 URL을 바꿀 수 있습니다. PATH에 herdr도 aoe + tmux도 없으면 설치 프로그램이 경고하며, `gh`와 `agent-messenger`가 없는 경우는 선택 사항 경고입니다. 기존 설치의 origin이 이 포크(또는 지정한 `DORI_REPO`)가 아니면 경고와 변경 명령을 보여 주고, 원격을 몰래 바꾸거나 예전 origin에서 pull하지 않습니다.

그다음 herdr 안에서, aoe 백엔드라면 aoe 세션 안에서 에이전트를 열고 "Dori mode"라고 말하면 됩니다. 디스코드 + aoe/tmux 서비스 전체 설정은 [`setups/discord-aoe`](skills/dori-mode/setups/discord-aoe/README.md)에 있습니다. 매일 운영하며 얻은 교훈(완료 주장이 레인을 닫는다는 점, 소유자 답을 기다리는 레인 멈추기, 스크립트 업데이트 반영, 섀도 실행으로 수신기 교체)은 [`references/operating-lessons.md`](skills/dori-mode/references/operating-lessons.md)에 있습니다.

## 필요한 것

- [bun](https://bun.sh) 1.3 이상, git
- 레인 탭용 [herdr](https://herdr.dev), 또는 레인 세션용 [agent-of-empires (aoe)](https://github.com/njbrake/agent-of-empires)와 `tmux`
- 스킬을 읽는 코딩 에이전트 ([OmO](https://github.com/code-yeongyu/oh-my-openagent) 기준으로 만들었고, 에이전트 실행 명령은 설정으로 바꿀 수 있습니다)
- PR 머지와 이슈 종료 확인용 `gh`(GitHub CLI), 배포 버전 확인용 `npm`
- 봇 자체를 위한 [agent-messenger](https://github.com/agent-messenger/agent-messenger)

호스트 감시는 macOS에서 전부 동작합니다. 리눅스에서는 부하와 디스크만 보고, 메모리와 스왑은 알 수 없음으로 나옵니다.

## Dori 이름 짓기

Dori는 맨 처음에 자기를 뭐라고 부를지 묻습니다. 그냥 "Dori"도 되고, ShipDori나 WorkDori처럼 끝이 Dori로 끝나는 이름도 됩니다. 여러 개를 함께 돌릴 때 구분하기 좋습니다. 정한 이름은 봇 이름과 메시지 끝 서명, 모드 이름에 그대로 쓰입니다. 다음부터는 "ShipDori mode"라고만 하면 다시 켜집니다.

## 슬랙으로 쓸 때

슬랙을 고르면 Dori가 한 가지를 더 묻고 답을 기다립니다.

- **사용자 토큰**: 워크스페이스의 실제 멤버로 움직입니다. 유료 좌석이 하나 필요하고 그 비용은 사용자가 냅니다. 그 멤버가 볼 수 있는 건 모두 읽을 수 있고, 초록색 온라인 표시도 유지할 수 있습니다.
- **봇 토큰**: 슬랙 앱으로 움직입니다. 좌석 비용은 없지만, 초대받은 채널과 앱에 준 권한 범위 안에서만 볼 수 있습니다.

## Dori의 말투

Dori는 사용자의 말투를 따라갑니다. 짧고 편하게, 소문자로 쓰면 그대로 짧고 편하게 답합니다. 메시지는 이모지 대신 말로 쓰지만, `discord.statusStyle`이 `"emoji"`이면 디스코드 상태 표시에 이모지를 쓸 수 있고 리스너는 눈 리액션으로 읽음 표시를 합니다. 할 말이 여러 갈래면 긴 글 하나 대신 짧은 메시지 몇 개로 나눠 보내고, 각 메시지는 준비되는 대로 바로 보냅니다. 일부러 뜸을 들이지 않아요. 계속 바뀌는 진행 상황 하나만은 예외라서, 메시지 하나를 그 자리에서 고쳐 갑니다.

## 설정

설정 파일은 `~/.dori/config.json` 하나이고, 어느 항목이든 빼도 됩니다. 보통 정해 두는 항목은 아래와 같아요.

| 항목 | 뜻 |
|---|---|
| `backend` | `"herdr"`(기본값) 또는 `"aoe"` |
| `leadPane` | Dori 자신의 herdr pane (`herdr pane current`), 또는 aoe의 tmux 세션 이름 (`tmux display-message -p '#S'`). 레인 보고가 여기로 옵니다. |
| `laneWorkspace` | 새 레인 탭이 열릴 herdr workspace. aoe에서는 쓰지 않습니다 |
| `ignorePanes`, `workspaces` | 감시에서 제외할 pane과 workspace 필터. aoe에서는 tmux 세션 이름과 프로필 이름을 쓰며, `workspaces`는 비워 둬도 됩니다 |
| `defaultCwd` | 레인이 시작하는 디렉터리이자, 레인이 worktree를 만드는 저장소 |
| `agentCommand` | 에이전트 실행 명령. `{model}`, `{prompt}`가 들어간 argv 목록 |
| `hooks.threadReply`, `hooks.threadDone` | 메신저 CLI를 `{thread}`, `{text}`가 들어간 argv 목록으로. 레인 진행 상황을 올리고 완료 표시를 할 때 씁니다. |
| `discord.statusStyle` | 디스코드 상태 표시를 `"words"`(기본값) 또는 `"emoji"`로 설정 |
| `discord.autoUnEye` | `true`(기본값)면 봇이 그 채널이나 스레드에 글을 쓸 때 `dori inbound discord`가 소유자의 앞선 메시지에서 눈 리액션을 지움. `false`면 그대로 둠 |
| `discord.quietText`, `discord.postRawReports` | `freshness`가 소유자 스레드에 올리는 글(`{min}` = 마지막 보고 뒤 지난 분), 소유자 언어로. 레인의 보고 원문은 스레드가 아니라 리드에게 감. `postRawReports: true`(기본 `false`)면 원문을 그대로 올림. 닫기는 레인의 소유자용 정리 글(`claim-done --summary`, 없으면 모델이 씀)을 먼저 올린 뒤에만 스레드를 완료로 표시하고, 정리가 없으면 닫지 않음 |

나머지(시간, 임계값, heavy 슬롯 수)는 기본값으로 충분합니다. 전체 표는 [`references/scripts.md`](skills/dori-mode/references/scripts.md)에 있습니다. `DORI_CONFIG`, `DORI_STATE_DIR`, `DORI_LEAD_PANE` 환경변수를 주면 파일 값 대신 그 값을 씁니다.

### aoe/tmux 레인 열기

리드도 aoe 안에서 실행하고, 예를 들어 이렇게 설정하세요.

```json
{
  "backend": "aoe",
  "leadPane": "aoe_Dori_0a1b2c3d",
  "agentCommand": ["omo", "--model", "{model}", "{prompt}"],
  "workspaces": [],
  "discord": { "statusStyle": "emoji" }
}
```

에이전트는 aoe 도구로 등록되어 있어야 합니다(`aoe agents`로 기본 도구를 확인하고, 사용자 도구는 aoe 설정에 등록). herdr에서는 `agentCommand`가 전체 argv 템플릿입니다. aoe에서는 `agentCommand[0]`만 도구를 고르고, 모델은 `--extra-args`로 전달하며 나머지 인자는 쓰지 않습니다.

brief를 준비한 뒤 어느 백엔드에서든 같은 명령으로 레인을 엽니다.

```sh
dori launch fix-login --title "Fix login" --brief ~/.dori/briefs/fix-login.md \
  --done "merged acme/app#412" --thread discord:100000000000000001
```

herdr는 탭을 엽니다. aoe는 `aoe add <cwd> -t <key> --tool <tool> -l --extra-args "--model <model>"`을 실행하고, 에이전트의 `❯` 프롬프트를 최대 3분 기다린 다음 레인 프롬프트를 입력합니다. 시작 실패는 `STARTUP_ERROR`로 나옵니다. 레지스트리의 pane은 `aoe_fix-login_1a2b3c4d` 같은 tmux 세션 이름이며, aoe는 휴지통에 있는 경우에도 같은 제목/경로 조합을 거부합니다.

footer는 레인이 `[REPORT] <key> | <milestone|blocker|question|done> | <text>`를 리드에게 보내도록 안내합니다. aoe에서는 셸 문자열 대신 argv 배열 두 개로 보냅니다.

```json
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "-l", "--", "[REPORT] fix-login | milestone | tests passed"]
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "Enter"]
```

`dori freshness`는 리드 화면에서 먼저 보고를 읽고, 없으면 레인 화면을 봅니다. 새 보고는 무응답 시간을 초기화합니다. 기본값으로 15분 뒤 알림을 보내고 20분 뒤 `hooks.threadReply`로 소유자 말투의 짧은 상태 한 줄(`discord.quietText`)을 올리며, 무응답 구간마다 한 번씩 실행합니다. 레인의 보고 원문은 리드 화면으로 보내 리드가 사람 말로 정리하게 하고, `discord.postRawReports: true`면 예전처럼 원문을 올립니다.

aoe에서 `dori watch`는 working 또는 not-done 레인이 사람을 기다리며 멈추면 `LANE_BLOCKED <key> <waiting|error|question|idle> <pane>`을 출력합니다. `aoe ps --json`과 화면을 함께 확인하며, 턴이 실행 중이면 출력하지 않습니다. idle은 45초간 지속돼야 하고, 모니터나 wake source, 진행 중이거나 예약된 goal을 기다리는 경우는 idle이 아닙니다. 세션이 직접 띄운 분리된 eval 셀, 백그라운드 bash 세션, 백그라운드 task를 기다리는 경우도 idle이 아니며, 감시 로그에 조용한 `BG_WAITING` 줄만 남고 `blockedWaitMin`(기본 60분)이 지나면 `LANE_BLOCKED`가 됩니다. 닫을 때는 aoe 세션을 멈추고 휴지통으로 옮기며 영구 삭제하지 않습니다.

## 온보딩

처음 설정할 때 Dori는 아무것도 읽기 전에 먼저 허락을 구합니다. 어떤 도구를 쓰는지, 무슨 일을 왜 하는지, 사용자와 회사가 어떤 곳인지 알아봐도 되느냐고요. 허락해야만 도구를 하나씩 살펴봅니다. 도구마다 어떤 연동을 쓸지, 그게 무엇을 읽는지 설명하고 따로 묻습니다. 예를 들면 "Gmail과 캘린더를 읽는 CLI로 일정과 메일을 지켜봐도 될까요?" 하는 식입니다. 거절한 도구는 건너뛰고, 거절했다는 사실도 기억합니다.

전 과정은 읽기만 합니다. 알게 된 내용은 그때그때 메모리에 적고, 마지막에 무엇을 알게 됐고 무엇이 아직 비어 있는지 짧게 정리해 줍니다. 자세한 절차는 [`references/onboarding.md`](skills/dori-mode/references/onboarding.md)에 있어요.

## 요청 처리 방식

메시지마다 어떻게 처리할지는 Dori가 스스로 정합니다.

- 질문, 상태 확인, 조회는 새 세션 없이 바로 답합니다. 한 줄짜리 수정이나 설정 값 하나라도 무언가를 바꾸는 일은 모두 레인에 맡겨서, 스레드와 Done 확인이 붙은 채로 보이게 합니다.
- PR로 끝나는 코드 작업, 여러 단계짜리 일, 오래 걸리거나 나눠서 돌릴 수 있는 일은 레인을 엽니다. 그 저장소를 맡고 있는 쉬는 레인이 있으면 새로 열지 않고 거기에 맡깁니다.
- 메모리, 디스크, pane 수에 여유가 없으면(`dori can-launch`가 HOLD) 새 레인을 열지 않습니다. 일을 대기열에 넣고 이유를 알려 줍니다.
- 새 일은 새 스레드에서 시작합니다. 이어지는 일은 원래 스레드로 돌아가고, 레인이 닫혔으면 예전 세션을 다시 엽니다. 짧은 질문은 물어본 자리에서 답합니다.

## 세션 레지스트리

레인마다 `~/.dori/state/lanes/` 아래에 JSON 파일이 하나씩 생깁니다. 메신저 스레드와 herdr pane 또는 aoe tmux 세션 이름, pane과 에이전트 세션 id를 연결하고, 상태(`working`, `done-claimed`, `verified-done`, `not-done`, `paused`, `closed`)와 그 변화 이력을 남깁니다.

`dori sync`는 이 기록을 실제로 떠 있는 pane과 비교해서 어긋난 곳을 알려 줍니다. 사라진 pane, 바뀐 세션 id, 끝났다는 걸 증명할 방법이 없는 레인 같은 것들입니다. 아무것도 지우지 않습니다. `--write`를 붙이면 찾은 세션 id를 저장합니다.

## 5분 완료 흐름

레인이 끝났다고 알립니다.

```sh
dori claim-done fix-login --evidence "merged acme/app#412 (a1b2c3d)"
```

Dori는 `LANE_DONE_CLAIMED`를 받고, 레인에는 5분 뒤 닫힌다는 메시지가 갑니다. 그 사이에 반대하려면 이렇게 합니다.

```sh
dori object-done fix-login --reason "changelog 항목이 빠졌음"
```

적은 이유가 레인에 그대로 전달되고, 레인은 고친 뒤 다시 완료를 알립니다. 아무도 반대하지 않으면 시간이 지난 뒤 `dori watch`가 레인을 닫습니다. 닫기 전에 `Done =` 신호를 모두 실제로 다시 확인하고, worktree에 원격에 올라가지 않은 커밋이나 커밋하지 않은 변경이 있으면 닫지 않습니다. 이때 완료 요청은 이유와 함께 not-done으로 돌아갑니다. watcher를 다시 켜도 5분 시계는 처음부터 다시 세지 않습니다. 그 사이에 새 일을 주면 완료 요청은 취소됩니다. 레인에 `dori type`으로 지시를 넣거나 조용해진 레인이 다시 턴을 돌면 감시 로그에 `LANE_CLAIM_REOPENED`가 남고, 레인은 계속 일한 뒤 다시 완료를 알립니다. 이미 닫힌 레인에 `dori type`을 하면 언제 누가 닫았는지와 함께 `LANE_IS_CLOSED`라고 알려 줍니다.

### 무엇을 완료로 보나

레인의 `Done =` 줄에는 watcher가 직접 확인할 수 있는 신호를 적습니다.
- PR 머지
- 이슈 종료
- 패키지 버전 배포
- PR로 끝나지 않는 일(로컬 설정, QA, 띄워 둔 서비스)이라면, 종료 코드 0으로 끝나는 명령, 해시나 JSON 값이 맞는 파일, 기대한 상태 코드와 본문으로 응답하는 URL

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

watcher는 레인을 닫을 때 셸 없이 이 확인을 직접 다시 돌리고, 레인이 됐다고 한 말을 그대로 믿지 않습니다. 해석할 수 없는 신호는 레인을 띄울 때 거부합니다. 전체 문법은 [`references/sessions.md`](skills/dori-mode/references/sessions.md)에 있어요.

## 명령

| 명령 | 하는 일 |
|---|---|
| `dori launch <key> ...` | brief에 레인 footer를 쓰고, herdr 탭이나 aoe 세션을 열고, 에이전트를 시작하고, 시작 오류를 확인; `Done =` 신호가 모두 파일·글자만 확인하면 `LAUNCH_DONE_WEAK` 경고(레인은 그대로 열림), `--done-weak-ok`로 끔; `--ui`는 소유자의 UI 7단계([ui-work.md](skills/dori-mode/references/ui-work.md))를 brief 맨 위에 넣고, UI 일로 보이는 brief에 `--ui`가 없으면 `LAUNCH_UI_HINT` 경고(레인은 그대로 열림); 소유자의 8단계([sessions.md](skills/dori-mode/references/sessions.md))가 하나도 없는 brief에는 네 칸 뒤에 그대로 붙이고(`LAUNCH_STEPS_ADDED`), 일부만 있으면 아무것도 붙이지 않고 `LAUNCH_STEPS_PARTIAL` 경고; 소유자 지침 장부([directives.json](skills/dori-mode/references/directives.json)와 호스트 로컬 파일)에서 범위에 드는데 brief에 없는 지침은 그대로 넣고(`LAUNCH_DIRECTIVE_ADDED`), 꼭 있어야 할 지침이 없으면 멈춤(`LAUNCH_DIRECTIVE_MISSING`, 종료 코드 4, `--waive <id> "<이유>"`로만 통과); `dori directive-audit`가 매일 아침 지난 하루 레인을 장부와 대조 |
| `dori adopt <key> --pane ID ...` | 이미 돌고 있는 레인을 등록 |
| `dori set-thread <key> <adapter>:<id>` | 레인의 작업 스레드를 바꿈; `launch`, `adopt`, `set-thread`는 `discord:`처럼 빈 값이나 틀린 형식을 거부 |
| `dori sync [--write]` | 레지스트리와 실제 pane 비교, 어긋난 곳 표시 |
| `dori claim-done` / `object-done` / `close` | 완료 흐름; 쓸 수 있는 스레드가 없으면 스레드 훅을 조용히 건너뛰지 않고 `THREAD_MISSING <key>`를 출력; `DORI_DISCORD_TOKEN`이 있으면 close가 `discord:` 작업 스레드를 완료로 표시하고 보관; 다른 열린 lane이나 열린 질문 카드가 그 스레드를 아직 쓰면 lane 결과만 올리고 스레드 상태는 그대로 |
| `dori pause <key> <이유>` / `dori resume <key>` | 사람을 기다리는 레인을 멈춰 둠: freshness 알림·게시, `LANE_BLOCKED`, `DEAD_PANE`이 나오지 않고 완료 요청이 와도 자동으로 닫지 않음; `resume`은 멈추기 전 상태로 되돌림 |
| `dori watch` | 자동 닫기 watcher와 aoe `LANE_BLOCKED` 이벤트. 지속 모니터로 돌립니다 |
| `dori freshness [--loop MIN]` | 조용해진 레인을 깨우고, 스레드에 짧은 상태 한 줄을 올리고 마지막 보고는 리드에게 넘김 |
| `dori dead-panes [--loop MIN]` | 멈춘 에이전트 pane 보고 |
| `dori guard [--loop MIN]` | 부하, 메모리, 디스크, pane 수 경고 |
| `dori fix-attempt <key> --metric M --hypothesis H` | 레인에 시킨 수정 한 번을 셈; 레인은 그런 보고에 `(fix: M / H)`를 붙이고, 같은 지표·같은 가설로 세 번째가 되면 `SAME_FIX_3`이 근본 원인 조사로 바꾸라고 알림; 기록하기 전에 그 지표에 이미 시도한 가설 목록(`PRIOR_FIX`)을 먼저 출력 |
| `dori signals [--lane K \| --cwd DIR \| --tag T]` | 한 작업 영역의 지난 레인들이 무엇을 시도했고 어떻게 됐는지: 번호 붙은 수정 시도와 근본 원인 조사로의 전환(`[REPORT]` 줄과 리드의 재지시에서도 읽음), 지표별 태그 수정, 이유가 붙은 완료 주장 거부, 재지시·독촉 수, 결과, 영역의 거부율·재작업, 경고. 레인에 재지시하기 전에 읽는다 |
| `dori scorecard [--date D] [--post]` | 기록만으로 내는 하루 토큰 성적표(모델 호출 없음): 검증 완료당 비용과 완료 주장 거부율을 나란히, 재작업 상위 레인, 첫 답글 중앙값/p90, 리드 컨텍스트 세금; 리드가 읽도록 `<stateDir>/scorecard/<날짜>.json`과 `latest.md`에 저장, `--post`는 디스코드에도 보냄(기본 꺼짐; 매일 저장하는 systemd timer는 Discord + aoe 설정에 있음) |
| `dori heavy <label> [--mem 70G] -- <cmd>` | 부하가 낮을 때 빌드·테스트·GPU 일을 메모리 상한이 걸린 자기 scope에서 실행(넘치면 그 일만 꺼지고 레인은 그대로), 이미 도는 일이 있으면 GPU·메모리·CPU가 각각 10% 이상 남을 때만 같이 실행 |
| `dori heavy <label> --kind browser\|cpu --sync DIR -- <cmd>` | 같은 일을 덜 바쁜 PC에서 실행: 헬퍼 호스트가 `--sync` 폴더를 받아 네트워크 없는 상자에서 돌리고 바뀐 파일을 돌려줌 |

pane에 보내는 글은 항상 인자 하나로 넘기고 셸 문자열을 거치지 않습니다. Enter가 실제로 들어갔는지도 확인합니다.

## 유틸리티

CLI에는 Dori에게 필요한 메신저 기능도 들어 있습니다. `scripts/src/messenger/` 아래 타입이 붙은 모듈로 가져다 쓸 수도 있어요.

| 명령 | 하는 일 |
|---|---|
| `dori send slack\|telegram\|discord --to T --text X [--thread ID] [--edit ID]` | 메시지 보내기와 수정. rate limit은 기다렸다 다시 보내고, `$(`가 들어간 글은 거부합니다 |
| `dori presence slack\|discord` | 계정을 온라인으로 유지. 디스코드 봇은 게이트웨이로, 슬랙 사용자 계정은 1분마다 신호를 보내는 웹 클라이언트 소켓으로 유지합니다 |
| `dori transcribe <file>` | `hooks.transcribe` 명령으로 음성 메시지를 글로 변환 |
| `dori can-launch` | 레인을 하나 더 열 여유가 있는지 확인 |
| `dori inbound slack [--loop MIN]` | 슬랙에서 Dori에게 온 것을 빠짐없이 잡기. Threads 화면의 읽지 않은 답글, Dori가 글을 쓴 스레드의 새 답글(태그가 없어도), 읽지 않은 멘션이 있는 DM과 채널 |
| `dori inbound discord` | 사용자 메시지, 음성 변환, 질문 카드 답변을 받는 게이트웨이 리스너 |
| `dori ask` / `questions [--open]` / `reopen <Qn>` / `resolve <Qn>` | 디스코드 질문 카드 게시, 목록 조회, 다시 열기, 처리 완료 |
| `dori thread reply\|wait\|done discord:<id> <text>` | 작업 스레드에 글을 쓰고 작업 중/대기/완료 표시. 완료 시 보관 |

명령은 없지만 모듈로 제공되는 기능도 있습니다.
- 텔레그램: "Thinking…"으로 시작하는 `sendMessageDraft` 스트리밍, 포럼 토픽, HTML 표
- 디스코드: 스레드 만들기, 이름 바꾸기, 보관
- 슬랙: 파일 업로드
- `typingWhile`: 작업이 도는 동안 입력 중 표시를 띄워 둡니다

슬랙에서 Dori가 보내는 메시지는 어떤 함수로 보냈든 그 스레드를 기록해 둡니다. 원시 API 호출로 올린 글 아래에 태그 없이 달린 답글도 놓치지 않는데, 메시지 이벤트만 듣는 방식으로는 이런 답글을 놓칩니다.

토큰은 `DORI_SLACK_TOKEN`(사용자 토큰이면 `DORI_SLACK_COOKIE`도), `DORI_TELEGRAM_TOKEN`, `DORI_DISCORD_TOKEN`에서 읽습니다.

### 디스코드 질문 카드와 스레드 상태

환경변수나 `~/.dori/dori.env`에 `DORI_DISCORD_TOKEN`, `DORI_DISCORD_GUILD`, `DORI_DISCORD_CHANNEL`, `DORI_DISCORD_OWNER`를 설정하세요(이미 설정된 환경변수가 우선). 봇의 Message Content intent를 켜고 버튼과 입력창 답변을 받도록 `dori inbound discord`를 계속 실행하세요. 선택: `DORI_DISCORD_PAIR_CHANNEL`은 다른 Dori들과 함께 쓰는 채널이고, `DORI_DISCORD_PAIR_BOT`에는 그 봇 ID를 하나 이상 쉼표나 공백으로 구분해 넣습니다(예: Dori 셋이 pair 채널 하나를 공유하면 각각 나머지 두 봇을 등록). 그 채널의 소유자 글은 `scope:"pair"`, 등록한 봇들의 글은 `scope:"pair-bot"` 행(정보일 뿐 요청이 아님)으로 남습니다. `DORI_DISCORD_STATE_DIR`은 질문 카드 저장 위치를 바꿉니다(기본 `<stateDir>/discord`). `DORI_DISCORD_SHADOW_INBOX=<파일>`을 주면 그 파일에 inbox 행만 쓰고 디스코드에는 아무것도 쓰지 않는 두 번째 리스너가 돌아, 전환 전에 기존 리스너와 대조할 수 있습니다.

```sh
dori ask --text "로그인 수정을 배포할까요?" --option "지금 배포" --option "QA 기다리기" \
  --thread discord:100000000000000001 --tmux aoe_fix-login_1a2b3c4d
dori questions --open
dori reopen Q1
dori resolve Q1
```

선택지 1–9개는 각각 짧은 `Pick N` 버튼 옆에 전체 내용으로 표시됩니다. 추천을 맨 앞에 두면 버튼이 강조됩니다. 직접 쓰기 버튼은 입력창을 엽니다. 소유자만 답할 수 있고 소유자만 멘션합니다. 답하면 카드는 기록으로 접히고, `~/.dori/state/discord/` 아래 `answers.jsonl`과 리스너 inbox에 저장됩니다. `--session`과 `--tmux` 정보로 답을 전달할 세션을 구분합니다.

`--thread`를 주면 해당 작업 스레드 안에 카드를 올리고 대기 상태로 표시합니다. 답하면 그 자리에서 기록으로 접히며 별도 기록 메시지는 없습니다. 그 스레드에 열린 질문이 더 없으면 작업 중으로 돌아갑니다. `dori reopen`은 버튼을 복구하고 스레드를 다시 대기로 표시합니다. `--thread`가 없으면 새 카드는 설정된 채널에 올라갑니다. 스레드가 연결된 예전 채널 카드는 답변 기록을 그 스레드에 알림 없이 남깁니다. 후속 작업이 끝나면 `dori resolve`로 추적 목록에서 지우며, 접힌 카드는 채팅에 남습니다. 답을 받지 않은 카드를 resolve로 지울 때도 그 스레드에 열린 질문이 더 없으면 작업 중으로 돌아가므로, 버린 질문 때문에 스레드가 대기로 남지 않습니다.

`discord.statusStyle: "emoji"`는 스레드 이름 앞에 🔄 작업 중, ⏸️ 대기, ✅ 완료를 붙입니다. 기본 `"words"`는 `[working]`, `[waiting]`, `[done]`입니다. 표시는 스레드에만 붙습니다. 텍스트 채널·포럼·카테고리를 스레드로 넘겨도(예: `dori ask --thread`에 채널 id) 이름은 그대로이고, 그 상태는 `THREAD_STATUS_DROPPED <id> ... is not a thread`로 버려집니다. `dori thread reply` / `wait` / `done`이 상태를 바꾸며, done은 보관하고 reply/wait는 보관을 해제합니다. 완료 스레드에 소유자가 메시지를 쓰면 리스너가 작업 중으로 다시 엽니다. 서비스와 카드 문구 번역 설정은 [디스코드 + aoe 설정](skills/dori-mode/setups/discord-aoe/README.md)을 보세요.

### 아이폰 단축어로 음성 지시

디스코드 iOS 앱은 단축어로 조작할 수 없어서, 버튼 하나로 음성 지시를 보내려면 우회합니다. iOS 단축어가 녹음한 파일을 Dori 채널의 디스코드 웹후크로 올리고, `DORI_DISCORD_OWNER_WEBHOOK`에 그 웹후크 ID를 넣으면 `dori inbound discord`가 그 글을 소유자의 음성 메시지로 받습니다. 눈 반응을 달고 받아쓴 뒤 `"via":"owner-webhook"`가 붙은 행으로 inbox에 남깁니다. ID를 넣기 전에는 웹후크 글을 로그(`DISCORD_WEBHOOK_UNKNOWN id=...`)에만 남깁니다. 웹후크 만들기, 단축어 동작 설정, 동작 버튼·뒷면 탭·시리 호출, 보안 주의는 [iOS 단축어 음성 지시 안내](skills/dori-mode/setups/discord-aoe/ios-shortcut-voice.md)를 따라 하세요.

## 테스트

CI는 없습니다. 테스트는 로컬에서 돌립니다.

```sh
cd skills/dori-mode/scripts
bun install
bun test           # 가짜 herdr, aoe, tmux, git, gh, Discord HTTP/게이트웨이로 동작 확인
bunx tsc --noEmit  # 타입 검사
```

두 백엔드, 시작과 보고 전달, freshness, 멈춘 레인, 완료 흐름, 디스코드 카드와 상태를 테스트합니다. 외부 도구와 Discord HTTP/게이트웨이는 가짜로 대체하며 실제 pane, 저장소, GitHub, 디스코드 계정은 건드리지 않아요.

## 라이선스

MIT

## Dori에서 옮겨 오기

예전 gist로 Dori 모드를 쓰고 있었다면 봇은 그대로 동작합니다. 네 가지만 바꾸면 Dori가 됩니다.

1. **Dori 이름 정하기.** 그냥 "Dori"나 ShipDori, WorkDori처럼 Dori로 끝나는 이름이면 됩니다. 에이전트에게 "이제부터 네 이름은 ShipDori고, 이건 ShipDori mode야"라고 말하세요. 그다음부터는 "Dori mode" 대신 "ShipDori mode"가 모드를 켜는 말이 됩니다.
2. **봇 이름과 프로필 사진 바꾸기.**
   - 텔레그램: @BotFather에서 `/setname`을 보내고 봇을 고른 뒤 새 이름을 보냅니다. 이어서 `/setuserpic`을 보내고 봇을 고른 뒤 새 이미지를 보냅니다. 기본 Dori 그림은 [`skills/dori-mode/assets/dori-avatar.png`](skills/dori-mode/assets/dori-avatar.png)이고, 원하는 이미지로 바꿔도 됩니다. 봇 이름과 사진은 BotFather에서만 바꿀 수 있습니다.
   - 디스코드: Developer Portal에서 애플리케이션을 엽니다. **Bot** 페이지에서 사용자 이름과 아이콘을, **General Information**에서 앱 이름과 아이콘을 바꾸고(같은 기본 그림을 쓰면 됩니다) 저장합니다.
3. **이 저장소 설치하기.** 위의 한 줄 설치를 실행하고 에이전트에게 "ShipDori mode"라고 말하면, 예전에 붙여 넣던 프롬프트 대신 스킬과 `dori` CLI를 씁니다.
4. **온보딩 하기.** Dori 때 한 적이 없다면 "온보딩 해 줘"라고 하면 됩니다.

기존 스레드, 토픽, 메모리는 그대로 남습니다.
