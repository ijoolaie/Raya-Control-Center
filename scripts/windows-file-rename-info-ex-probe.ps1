$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$src=Join-Path $root 'experiments\windows-file-rename-info-ex-probe.cpp'
$pf=[Environment]::GetFolderPath('ProgramFilesX86')
$vcvars=Join-Path $pf 'Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if(-not(Test-Path $vcvars)){ $vcvars=(Get-ChildItem (Join-Path $pf 'Microsoft Visual Studio') -Filter vcvars64.bat -Recurse -ErrorAction SilentlyContinue|Select-Object -First 1).FullName }
if(-not $vcvars){throw 'MSVC vcvars64.bat not found'}
$tag=[guid]::NewGuid().ToString('N'); $exe=Join-Path $env:TEMP "raya-file-rename-ex-$tag.exe"; $obj=Join-Path $env:TEMP "raya-file-rename-ex-$tag.obj"
try {
 $cmd='"'+$vcvars+'" >nul && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE "'+$src+'" /Fo:"'+$obj+'" /Fe:"'+$exe+'"'
 & cmd.exe /d /s /c $cmd
 if($LASTEXITCODE -ne 0){throw "Build failed: $LASTEXITCODE"}
 for($i=1;$i -le 10;$i++){ "=== run $i/10 ==="; & $exe; if($LASTEXITCODE -ne 0){throw "Probe failed on run $i ($LASTEXITCODE)"} }
 'PASS: 10 FileRenameInfoEx probe runs.'
} finally { Remove-Item $exe,$obj -Force -ErrorAction SilentlyContinue }