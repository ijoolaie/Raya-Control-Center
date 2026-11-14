param([ValidateRange(1,100)][int]$Runs = 5)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'experiments\windows-nt-rename-status-capture.cpp'
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vcvars = Join-Path $programFilesX86 'Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "MSVC environment not found: $vcvars" }
$tag = [Guid]::NewGuid().ToString('N')
$exe = Join-Path $env:TEMP "raya-nt-status-capture-$tag.exe"
$obj = Join-Path $env:TEMP "raya-nt-status-capture-$tag.obj"
try {
  $build = '"' + $vcvars + '" >nul && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE "' + $source + '" /Fo:"' + $obj + '" /Fe:"' + $exe + '"'
  & cmd.exe /d /s /c $build
  if ($LASTEXITCODE -ne 0) { throw "MSVC compilation failed: $LASTEXITCODE" }
  for ($i=1; $i -le $Runs; $i++) {
    Write-Output "--- Native status capture run $i/$Runs ---"
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "Native status capture failed on run $i (exit $LASTEXITCODE)" }
  }
  Write-Output "PASS: $Runs runs."
} finally { Remove-Item $exe,$obj -Force -ErrorAction SilentlyContinue }
