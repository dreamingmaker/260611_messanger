# 개발 가이드 (이어서 개발하는 분들께)

이 문서는 이 프로젝트를 **이어받아 개발**하는 사람을 위한 안내입니다. 사용자용 설명은 `README.md` 를 보세요.

## 한눈에 보는 구조

- **완전 P2P, 중앙서버 없음.** 각 PC가 `peer.js`(노드)를 실행하고, 브라우저는 자기 노드의 `localhost` UI 에만 접속합니다.
- 노드끼리: **UDP 멀티캐스트로 자동 발견 → TCP 메시(mesh) 연결 → gossip 전파 → anti-entropy 동기화(최종 일관성)**.
- 빌드 단계 없음(순수 HTML/CSS/JS 클라이언트). 서버 의존성은 `express`, `socket.io` 뿐.

## 파일 맵

| 파일 | 역할 |
|---|---|
| `peer.js` | 노드 본체: 발견(dgram)·메시(net)·레코드 저장·HTTP+Socket.IO UI 서버·파일 전송·LLM 요약 |
| `public/index.html` | UI 마크업 |
| `public/app.js` | 브라우저 클라이언트(상태/렌더/소켓). 프레임워크 없음 |
| `public/style.css` | 스타일 |
| `start.bat` / `start.command` | Windows / macOS 실행 도우미 |
| `.env.example` | 환경변수 예시(복사해서 `.env` 로) |
| `build-dist.ps1` | 배포 zip 빌드(Windows PowerShell) |

## 데이터 모델 — 모든 것은 "레코드(record)"

`store.records` 는 `id → record` 맵이고 `data/store.json` 에 저장됩니다. 타입별:

| type | 의미 | 주요 필드 |
|---|---|---|
| `user` | 고정 신원(명부) | `uid, name, color` (신원당 1개, TOFU) |
| `channel` | 채널 | `name` |
| `msg` | 메시지 | `channel, topic, author{id,name,color}, text, image?, file?, poll?, intake?, mentions?` |
| `del` | 삭제(회수) 표식 | `target, dm?` (원작성자만) |
| `edit` | 메시지 수정 | `target, text, dm?` (원작성자만, 최신 우선) |
| `reset` | 주제 대화 리셋 | `channel, topic` |
| `react` | 이모지 리액션 | `target, emoji, dm?` (토글=패리티) |
| `vote` | 투표 응답 | `target, opt, dm?` (단일=최신/복수=패리티) |
| `submit` | 수합 제출 | `target, text/opt, dm?` (사람당 최신) |
| `docver` | 문서함 버전 | `docId, ver, title, note, file{...}, text(diff용)` |

### 전파 규칙 — `audienceOf(rec)`
- `null` 반환 → **공개**: `floodToPeers` 로 전원에게 gossip.
- 배열 반환 → **DM 등 한정**: 그 참여자에게만 직접 전송 + anti-entropy 도 그 대상만.
- `del/edit/react/vote/submit` 은 자기 `dm` 필드를 **믿지 않고** `ingest` 에서 **대상 메시지 기준**으로 권한·수신대상을 재검증/정규화합니다(위조·누출 방지).

### 한 기능의 데이터 흐름
```
클라(app.js) socket.emit('xxx', ...)
  → peer.js  socket.on('xxx')  (검증) → newRecord(...) → publish(rec)
     → 공개면 floodToPeers / DM 이면 참여자에게 send
        → 상대 노드 ingest(rec)  (타입검증 + 대상기준 권한/정규화 + dedup)
           → uiBroadcastRecord → 각 브라우저 socket.on('record')
              → recs[r.id]=r → 디스패치(onMsg/onReact/.../rerenderIfCurrent) → 렌더
```

## 새 기능 추가 레시피
1. **peer.js 소켓 핸들러**: 입력 검증 → `newRecord({type:'...', ...})` → `publish()`.
2. **`audienceOf`**: DM 스코프가 필요하면 그 타입을 추가(대상의 `dm` 기준).
3. **`ingest`**: 타입 검증 분기 추가. 대상 참조형(target)이면 "대상 존재/권한/정규화" 블록에 추가.
4. **app.js**: `socket.on('record')` 디스패치에 분기 추가 + `build*()` 집계 + 렌더 함수.
5. **검증**: 멀티노드 + 브라우저(아래) → `node --check` → 제어바이트 스캔.

## ⚠ 반드시 알아야 할 함정 — 편집 도구 이스케이프

이 저장소는 종종 자동 편집 도구로 수정됩니다. 그 도구의 파일 내용에서 **백슬래시 이스케이프가 JSON 디코드**됩니다:
`\\n` → 실제 줄바꿈, `\\t` → 탭, `\\u0000` → NUL 바이트, `\\/` → `/`.

그래서 **정규식/문자열에 `\\n` `\\t` `\\uXXXX` `\\.` `\\s` 등을 직접 쓰면 깨질 수 있습니다.** 회피책:
- 줄바꿈/탭은 `String.fromCharCode(10)` / `String.fromCharCode(9)` (코드의 `DOC_NL`, `stripCtrl` 참고).
- 문자 비교(`c === '@'`)나 `new RegExp('...')` 사용.
- 수정 후 **항상** `node --check peer.js && node --check public/app.js` 와 제어바이트 스캔을 돌리세요.

제어바이트 스캔(PowerShell):
```powershell
foreach ($f in 'peer.js','public\app.js') {
  $b=[IO.File]::ReadAllBytes((Join-Path (Get-Location) $f)); $bad=0
  foreach($x in $b){ if($x -lt 0x20 -and $x -ne 9 -and $x -ne 10 -and $x -ne 13){$bad++} }
  "$f control=$bad"
}
```

## 테스트 방법

- **멀티노드(P2P 동작)**: 노드를 여러 개 **각각 백그라운드 프로세스**로 띄우고(포트·DATA_DIR·DISCOVERY_PORT 다르게), `socket.io-client` 클라이언트 스크립트 **1개**로 검증합니다.
  - ⚠ 한 스크립트에서 노드(네트워크 바인딩 프로세스)를 2개 이상 spawn 하면 죽습니다 — 노드는 따로 띄우세요.
  - 예: `PORT=5001 DATA_DIR=t/a DISCOVERY_PORT=51400 node peer.js`
  - 테스트 스크립트는 `_` 로 시작(`_*.js`)하면 `.gitignore` 됩니다.
- **브라우저 UI**: 노드 1개 + 브라우저에서 `http://localhost:34567`.
- 검증 후 임시 데이터/스크립트는 지우고 `npm prune` 하세요.

## 빌드(배포 zip)
`build-dist.ps1` 실행 → `사내메신저_배포.zip`(Windows), `사내메신저_배포_맥.zip`(macOS) 생성.
node_modules 까지 포함(받는 사람이 npm install 불필요), 엔트리는 **정방향 슬래시**(PowerShell `Compress-Archive` 의 역슬래시 버그 회피)로 넣습니다.

## 보안 모델(현재)
- **같은 사내망 신뢰** 가정. 신원은 "이름 고정형"(최초 1회 설정 후 잠금, 영구 노드ID). **레코드 서명 없음** → 악의적 위조까지는 막지 않음.
- 삭제/수정은 **원작성자만**(받는 쪽 `ingest` 에서도 검증). DM 및 DM 의 리액션/수정/삭제/투표/수합, 대용량 파일은 **당사자에게만** 전달.

## 로드맵(다음 단계 후보)
- **문서 diff 확장**: 현재 `.hwpx/.docx/텍스트`만 내용(+/-) 비교. **구형 `.hwp`(바이너리) diff** 는 미지원 → 파서/변환 필요.
- **일정 조율(when2meet)**: 가용시간 수합 → 공통시간 자동 도출(수합 엔진 확장).
- **작업/담당 추적**: 액션아이템에 담당자·상태·마감.
- **읽음/확인(ack) 추적**: "누가 봤나/확인했나".
- **권한·역할**: 채널 리셋/삭제 등 통제(현재는 누구나 자기 글만).
- **항상 켠 앵커 노드**: 문서·수합의 durability 보강(여전히 P2P).
- **서명 기반 신원**: 키쌍으로 위조 원천 차단.
- **오프라인 알림**, **답글/인용**, **핀/북마크**.
