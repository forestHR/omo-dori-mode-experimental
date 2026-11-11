# 도리 캘린더 (Google Apps Script)

도리가 내 기본 구글 캘린더를 읽고, 내가 승인 카드에 답한 일정만 넣고 고치고 지우게 하는 웹앱이다.
Google Cloud 콘솔과 OAuth 클라이언트는 쓰지 않는다. 도리는 `dori gcal` 로 이 웹앱을 부른다.

- 도리가 만든 일정에는 표시가 붙는다(태그 `dori=1`, 설명 첫 줄 `[도리] <요청 id>`). 고치기와 지우기는 이 표시가 있는 일정에만 된다. 내가 직접 넣은 일정은 읽기만 한다.
- 알림은 휴대폰 팝업 알림이고, 따로 말하지 않으면 30분 전이다.
- 쓰기 요청에는 승인 근거(카드 id 또는 디스코드 링크)가 있어야 한다. 없으면 도리 쪽 도구가 보내지 않고, 웹앱도 거절한다.
- 비밀값과 웹앱 주소는 디스코드, 볼트, 드롭박스, 보고, 커밋 어디에도 적지 않는다.

## 설치 (혜린이 한다)

1. https://script.google.com 에서 `도리 캘린더` 프로젝트를 연다. `Code.gs` 의 내용을 모두 지우고, 이 폴더의 [`Code.gs`](Code.gs) 전체를 붙여 넣은 뒤 저장한다.
2. 왼쪽 ⚙ **프로젝트 설정** → 맨 아래 **스크립트 속성** → **스크립트 속성 추가**를 누른다. 속성 이름은 `DORI_SECRET`, 값은 직접 만든 긴 임의 문자열(32자 이상)로 넣고 저장한다.
3. 오른쪽 위 **배포** → **새 배포**를 누른다.
4. ⚙ 유형 선택에서 **웹 앱**을 고른다.
5. **다음 사용자 인증 정보로 실행: 나**, **액세스 권한이 있는 사용자: 모든 사용자**로 정하고 **배포**를 누른다. 처음이면 권한 허용 창이 뜨니 내 계정으로 허용한다(캘린더 권한).
6. 나온 **웹 앱 URL**(`https://script.google.com/macros/s/…/exec`)을 복사한다.
7. 멧돌의 `~/.dori/dori.env` 에 아래 두 줄을 넣고 저장한다. 값은 6번의 주소와 2번의 비밀값이다.

   ```
   DORI_GCAL_URL=<웹 앱 URL>
   DORI_GCAL_SECRET=<2번의 비밀값>
   ```

코드를 고친 뒤 다시 붙여 넣었을 때는 **배포** → **배포 관리** → ✏ → 버전 **새 버전** → **배포**를 누른다. 주소는 그대로다.

**비밀값이 샜을 때:** 스크립트 속성 `DORI_SECRET` 값을 새로 바꾸고, `dori.env` 의 `DORI_GCAL_SECRET` 도 같은 값으로 바꾼다. 주소까지 샜으면 **배포 관리**에서 그 배포를 **보관 처리**하고 새 배포를 만들어 새 주소를 `DORI_GCAL_URL` 에 넣는다.

## 도리가 쓰는 법

```
dori gcal read   --from 2026-11-12T00:00+09:00 --to 2026-11-13T00:00+09:00
dori gcal create --title "도리 시험" --start 2026-11-12T10:00+09:00 --end 2026-11-12T10:30+09:00 --reminder 10 --approval Q12
dori gcal update <일정 id> --title "새 제목" --approval Q12
dori gcal delete <일정 id> --approval https://discord.com/channels/<서버>/<채널>/<메시지>
```

- 읽기 결과는 한 줄에 일정 하나(JSON): `id`, `title`, `start`, `end`, `location`, `dori`(도리 표시 여부). `id` 는 고치기와 지우기에 쓴다.
- `--approval` 은 내가 답한 카드 id(`dori questions` 에서 answered 인 것) 또는 내 승인 메시지의 디스코드 링크다. 아직 답하지 않은 카드는 거절된다.
- 쓰기마다 `<stateDir>/gcal/writes.jsonl` 에 한 줄(언제, 무엇을, 어떤 승인 근거로, 결과)이 남는다. 멧돌이면 `~/.dori/state/gcal/writes.jsonl` 이다. 비밀값과 주소는 적히지 않는다.
- 웹앱은 POST 에 302 로 답하고, 도구는 그 주소를 GET 으로 따라가 결과를 읽는다(Apps Script 의 동작).

## 고장일 때

| 출력 | 뜻 |
|---|---|
| `GCAL_NOT_CONFIGURED` | `dori.env` 에 두 값이 없다 |
| `GCAL_REFUSED web app: not_configured` | 스크립트 속성 `DORI_SECRET` 이 비어 있다 |
| `GCAL_REFUSED web app: unauthorized` | 두 비밀값이 다르다 |
| `GCAL_REFUSED web app: not_dori` | 도리 표시가 없는 일정이라 고치거나 지울 수 없다 |
| `GCAL_FAIL web app answered an HTML page` | 액세스가 "모든 사용자"가 아니거나, 주소가 `/exec` 로 끝나는 배포 주소가 아니다 |
