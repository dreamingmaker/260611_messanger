#!/bin/bash
# 맥용 실행 스크립트 (더블클릭 또는 터미널에서 ./start.command)
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[오류] Node.js가 설치되어 있지 않습니다."
  echo "       https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  echo ""
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "최초 실행: 필요한 라이브러리를 설치합니다..."
  npm install || { echo "[오류] 설치 실패"; read -n 1 -s -r; exit 1; }
fi

echo ""
echo "내 메신저 노드를 시작합니다. 이 창을 닫으면 종료됩니다."
echo "브라우저가 자동으로 열립니다. (열리는 주소는 화면에 표시됩니다)"
echo ""
export OPEN=1
node peer.js
