# 배포 zip 빌드 (Windows PowerShell)
#   사내메신저_배포.zip      (Windows: start.bat)
#   사내메신저_배포_맥.zip   (macOS: start.command + 맥-실행방법.txt)
# node_modules 까지 포함(받는 사람 npm install 불필요). 엔트리는 정방향 슬래시로 넣어
# PowerShell Compress-Archive 의 역슬래시(경로) 버그를 피한다.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

function New-Zip($zipPath, $rootDir, $files) {
  if (Test-Path $zipPath) { [System.IO.File]::Delete($zipPath) }
  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($rootDir.Length).TrimStart('\', '/').Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $zip.Dispose() }
}

# 공통 포함 파일: 소스 + node_modules(테스트 전용 socket.io-client 제외)
$common = @()
foreach ($n in 'peer.js', 'package.json', 'package-lock.json', 'README.md') { $common += Get-Item (Join-Path $root $n) }
$common += Get-ChildItem (Join-Path $root 'public') -File
$common += (Get-ChildItem (Join-Path $root 'node_modules') -Recurse -File | Where-Object { $_.FullName -notlike '*\node_modules\socket.io-client\*' })

New-Zip (Join-Path $root '사내메신저_배포.zip')    $root ($common + (Get-Item (Join-Path $root 'start.bat')))
New-Zip (Join-Path $root '사내메신저_배포_맥.zip') $root ($common + (Get-Item (Join-Path $root 'start.command')) + (Get-Item (Join-Path $root '맥-실행방법.txt')))

foreach ($n in '사내메신저_배포.zip', '사내메신저_배포_맥.zip') {
  $fi = Get-Item (Join-Path $root $n); "{0}  {1:N2} MB" -f $fi.Name, ($fi.Length / 1MB)
}
Write-Output 'done'
