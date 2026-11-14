#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string>
#include <vector>
#include <stddef.h>

static int failures = 0;
static void check(bool ok, const char* label) {
    printf("%s: %s\n", ok ? "PASS" : "FAIL", label);
    if (!ok) ++failures;
}
static bool writeFile(const std::wstring& p, const char* s) {
    HANDLE h=CreateFileW(p.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(h==INVALID_HANDLE_VALUE)return false;
    DWORD n=0; bool ok=WriteFile(h,s,(DWORD)strlen(s),&n,nullptr)&&n==strlen(s);
    ok=FlushFileBuffers(h)&&ok; CloseHandle(h); return ok;
}
static std::string readFile(const std::wstring& p) {
    HANDLE h=CreateFileW(p.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(h==INVALID_HANDLE_VALUE)return {};
    char b[256]{}; DWORD n=0; ReadFile(h,b,sizeof(b),&n,nullptr); CloseHandle(h); return std::string(b,n);
}
static bool renameEx(HANDLE source,HANDLE parent,const std::wstring& name,DWORD& error) {
    DWORD bytes=(DWORD)(offsetof(FILE_RENAME_INFO,FileName)+name.size()*sizeof(WCHAR));
    std::vector<BYTE> buffer(bytes+sizeof(WCHAR));
    auto* info=reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    info->Flags=0; info->RootDirectory=parent;
    info->FileNameLength=(DWORD)(name.size()*sizeof(WCHAR));
    memcpy(info->FileName,name.data(),info->FileNameLength);
    SetLastError(ERROR_SUCCESS);
    BOOL ok=SetFileInformationByHandle(source,FileRenameInfoEx,info,bytes);
    error=ok?ERROR_SUCCESS:GetLastError(); return ok!=FALSE;
}
static HANDLE openParent(const std::wstring& p) {
    return CreateFileW(p.c_str(),FILE_LIST_DIRECTORY|FILE_ADD_FILE|FILE_READ_ATTRIBUTES|SYNCHRONIZE,
      FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
}
static HANDLE openSource(const std::wstring& p) {
    return CreateFileW(p.c_str(),DELETE|GENERIC_READ|FILE_READ_ATTRIBUTES|SYNCHRONIZE,
      FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
}
int wmain() {
    wchar_t temp[MAX_PATH]{}; if(!GetTempPathW(MAX_PATH,temp))return 2;
    std::wstring base=std::wstring(temp)+L"raya-file-rename-info-ex-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64());
    std::wstring dir=base+L"\\dir";
    if(!CreateDirectoryW(base.c_str(),nullptr)||!CreateDirectoryW(dir.c_str(),nullptr))return 3;
    std::wstring stage=dir+L"\\stage", target=dir+L"\\target", collision=dir+L"\\collision";
    int rc=0;
    do {
      check(writeFile(stage,"stage-bytes"),"create and flush stage");
      check(writeFile(collision,"preserve-me"),"create collision target");
      HANDLE parent=openParent(dir), sh=openSource(stage);
      check(parent!=INVALID_HANDLE_VALUE&&sh!=INVALID_HANDLE_VALUE,"open retained parent and source handles");
      if(parent==INVALID_HANDLE_VALUE||sh==INVALID_HANDLE_VALUE){rc=4;if(parent!=INVALID_HANDLE_VALUE)CloseHandle(parent);if(sh!=INVALID_HANDLE_VALUE)CloseHandle(sh);break;}
      DWORD e=0; bool ok=renameEx(sh,parent,L"target",e);
      printf("relative FileRenameInfoEx error=%lu\n",e);
      check(!ok&&e==ERROR_INVALID_PARAMETER,"relative RootDirectory request rejected with ERROR_INVALID_PARAMETER");
      check(readFile(stage)=="stage-bytes"&&GetFileAttributesW(target.c_str())==INVALID_FILE_ATTRIBUTES,"rejected relative request leaves source and destination namespace unchanged");
      HANDLE ch=openSource(collision); DWORD ce=0; bool cok=renameEx(ch,parent,L"collision",ce);
      printf("relative collision request error=%lu\n",ce);
      check(!cok&&ce==ERROR_INVALID_PARAMETER,"relative collision request rejected at API boundary");
      check(readFile(collision)=="preserve-me"&&readFile(stage)=="stage-bytes","both original files preserved");
      CloseHandle(ch);CloseHandle(sh);CloseHandle(parent);
    }while(false);
    DeleteFileW(stage.c_str());DeleteFileW(target.c_str());DeleteFileW(collision.c_str());
    RemoveDirectoryW(dir.c_str());RemoveDirectoryW(base.c_str());
    if(failures){printf("FAILURES=%d\n",failures);return 1;}
    puts("PASS: FileRenameInfoEx relative-root limitation reproduced.");return rc;
}