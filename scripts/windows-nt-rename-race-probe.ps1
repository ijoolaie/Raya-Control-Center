param([ValidateRange(1,20)][int]$Runs = 5)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'experiments\windows-nt-rename-race-probe.cpp'
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vcvars = Join-Path $programFilesX86 'Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "MSVC environment not found: $vcvars" }
$tag = [Guid]::NewGuid().ToString('N')
$exe = Join-Path $env:TEMP "raya-nt-race-$tag.exe"
$obj = Join-Path $env:TEMP "raya-nt-race-$tag.obj"
try {
  $build = '"' + $vcvars + '" >nul && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE "' + $source + '" /Fo:"' + $obj + '" /Fe:"' + $exe + '"'
  & cmd.exe /d /s /c $build
  if ($LASTEXITCODE -ne 0) { throw "MSVC compilation failed: $LASTEXITCODE" }
  for ($i=1; $i -le $Runs; $i++) {
    Write-Output "--- NT rename race run $i/$Runs ---"
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "NT rename race probe failed on run $i (exit $LASTEXITCODE)" }
  }
  Write-Output "PASS: $Runs runs."
} finally { Remove-Item $exe,$obj -Force -ErrorAction SilentlyContinue }
