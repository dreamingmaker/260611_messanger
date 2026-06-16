@echo off
chcp 65001 >nul
title P2P 사내 메신저 노드
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [오류] Node.js 가 설치되어 있지 않습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 최초 실행: 필요한 라이브러리를 설치합니다...
  call npm install
  if errorlevel 1 (
    echo.
    echo [오류] 라이브러리 설치에 실패했습니다.
    pause
    exit /b 1
  )
)

echo.
echo 내 메신저 노드를 시작합니다. 이 창을 닫으면 종료됩니다.
echo 브라우저가 자동으로 열립니다. (열리는 주소는 아래 창에 표시됩니다)
echo.
set OPEN=1
node peer.js
pause
