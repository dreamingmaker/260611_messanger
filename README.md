# 🤠 로프 카우보이 — 모바일 앱

올가미(로프)를 돌려 던지는 **2D 납치/구출 3v3 팀전** 게임의 **모바일 앱 버전**입니다.
웹 버전과 동일한 순수 HTML5 Canvas 게임 엔진을 [Capacitor](https://capacitorjs.com/)로 감싸
**Android / iOS 네이티브 앱**으로 빌드합니다. (원본 웹 버전: `260611_messanger` 저장소의 `game/` 폴더)

## 게임 규칙

- **3 대 3 팀전** — 레드(당신 + AI 2) vs 블루(AI 3).
- 🎯 **납치**: 올가미로 활동 중인 **적**을 맞히면 **우리 감옥**으로 끌어옵니다.
- 🛟 **구출**: 적 감옥에 끌려가거나 갇힌 **우리 팀**을 올가미로 맞히면 풀려납니다.
- 🧗 **넘기(2.5D)**: 벽의 **노란 고리**에 올가미를 걸면 포물선으로 **벽을 넘어갑니다**.
- 📦 **상자 끌기**: 상자에 올가미를 걸면 내 쪽으로 끌어옵니다.
- 🏆 **승리**: 적 3명을 **동시에** 가두거나, 2분 종료 시 더 많이 가둔 팀이 승리.

## 조작 (모바일)

- 왼쪽 **가상 조이스틱** — 이동 + 조준
- 오른쪽 **올가미 버튼** — 던지기 (길게 누르면 충전 → 더 멀리·빠르게)
- **가로 모드** 권장 (앱은 가로로 고정됩니다)

---

## 빌드 방법

### 방법 A. GitHub Actions로 APK 자동 빌드 (가장 쉬움 — 로컬 설치 불필요)

이 저장소에는 `.github/workflows/android-build.yml` 이 포함되어 있습니다.

1. `main` 브랜치에 푸시하거나, GitHub **Actions** 탭에서 **Build Android APK** 워크플로를 **Run workflow** 로 수동 실행.
2. 실행이 끝나면 그 실행 페이지 하단 **Artifacts** 에서 `cowboy-rope-debug-apk` 를 내려받습니다.
3. 압축을 풀면 `app-debug.apk` — Android 기기에 복사해 설치(설정에서 "출처를 알 수 없는 앱 설치" 허용 필요).

> 디버그 APK는 테스트/사이드로딩용입니다. 스토어 배포용 서명 AAB는 키스토어 설정이 추가로 필요합니다.

### 방법 B. 로컬에서 빌드

준비물: **Node.js 18+**, **Android Studio**(SDK 포함), (iOS는 **macOS + Xcode**).

```bash
npm install

# 안드로이드
npm run init:android     # = npx cap add android  (최초 1회, android/ 생성)
npm run sync             # 웹 자산을 네이티브로 동기화
npm run open:android     # Android Studio 로 열어 ▶ 실행 / APK 빌드
#  또는 CLI 로 디버그 APK:
npm run build:apk        # android/app/build/outputs/apk/debug/app-debug.apk

# iOS (macOS 만)
npm run init:ios
npm run sync
npm run open:ios         # Xcode 로 실행
```

가로모드 고정은 Actions 워크플로가 매니페스트를 자동 패치합니다. 로컬 빌드 시 가로로 고정하려면
`android/app/src/main/AndroidManifest.xml` 의 `<activity ...>` 에
`android:screenOrientation="sensorLandscape"` 를 추가하세요.

### 방법 C. 그냥 브라우저로 미리보기

```bash
npm run serve     # http://localhost:8080  (모바일 브라우저로도 접속해 바로 플레이)
```

---

## 구조

```
www/                 게임 본체 (Capacitor webDir)
  index.html         화면/UI + 가로전환 안내
  style.css          서부 테마 + 모바일 보정
  game.js            게임 엔진 (입력·물리·AI·렌더, 순수 Canvas)
capacitor.config.json  앱 ID/이름/배경색
package.json           스크립트 + Capacitor 의존성
.github/workflows/     APK 자동 빌드 (GitHub Actions)
android/ , ios/        네이티브 프로젝트 (npx cap add 로 생성, git 미추적)
```

웹 게임 로직을 고치려면 `www/` 안의 파일만 수정하고 `npm run sync` 하면 됩니다.
