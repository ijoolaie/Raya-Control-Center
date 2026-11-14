#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <stdio.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>

using NtSetInformationFileFn = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
struct RenameBuffer { BOOLEAN ReplaceIfExists; HANDLE RootDirectory; ULONG FileNameLength; WCHAR FileName[1]; };

static NTSTATUS renameNt(HANDLE source, HANDLE root, const std::wstring& name) {
    const ULONG n = static_cast<ULONG>(name.size() * sizeof(WCHAR));
    const ULONG offset = static_cast<ULONG>(offsetof(RenameBuffer, FileName));
    const ULONG bytes = offset + n;
    std::vector<BYTE> b(bytes);
    auto* p = reinterpret_cast<RenameBuffer*>(b.data());
    ZeroMemory(p, bytes); p->ReplaceIfExists = FALSE; p->RootDirectory = root; p->FileNameLength = n;
    memcpy(p->FileName, name.data(), n);
    IO_STATUS_BLOCK iosb{};
    auto fn = reinterpret_cast<NtSetInformationFileFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
    if (!fn) return static_cast<NTSTATUS>(0xC0000002L);
    NTSTATUS s = fn(source, &iosb, p, bytes, static_cast<FILE_INFORMATION_CLASS>(65));
    return s >= 0 ? iosb.Status : s;
}
static bool writeFile(const std::wstring& p, const char* data) {
    HANDLE h = CreateFileW(p.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD n=0; bool ok=WriteFile(h,data,(DWORD)strlen(data),&n,nullptr)&&n==strlen(data)&&FlushFileBuffers(h);
    CloseHandle(h); return ok;
}
static std::string readFile(const std::wstring& p) {
    HANDLE h=CreateFileW(p.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(h==INVALID_HANDLE_VALUE)return {};
    char b[128]{}; DWORD n=0; ReadFile(h,b,sizeof(b),&n,nullptr); CloseHandle(h); return std::string(b,n);
}
int wmain() {
    wchar_t temp[MAX_PATH]{}, base[MAX_PATH]{}, rootPath[MAX_PATH]{}, stage[MAX_PATH]{}, moved[MAX_PATH]{}, decoy[MAX_PATH]{};
    if(!GetTempPathW(MAX_PATH,temp))return 2;
    swprintf_s(base,L"%sRayaNtRace-%lu",temp,GetCurrentProcessId());
    if(!CreateDirectoryW(base,nullptr))return 2;
    int failures=0, checks=0;
    // Race: a competing CREATE_NEW and a no-replace rename target the same name.
    swprintf_s(rootPath,L"%s\\race",base); swprintf_s(stage,L"%s\\stage",base);
    if(!CreateDirectoryW(rootPath,nullptr)||!CreateDirectoryW(stage,nullptr))return 2;
    HANDLE root=CreateFileW(rootPath,FILE_TRAVERSE|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    if(root==INVALID_HANDLE_VALUE)return 2;
    for(int i=0;i<100;i++){
        wchar_t src[MAX_PATH]{},dst[MAX_PATH]{},dstName[MAX_PATH]{};
        swprintf_s(src,L"%s\\s-%d",stage,i); swprintf_s(dst,L"%s\\d-%d",rootPath,i); swprintf_s(dstName,L"d-%d",i);
        if(!writeFile(src,"source")){++failures;continue;}
        HANDLE sh=CreateFileW(src,GENERIC_READ|DELETE|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(sh==INVALID_HANDLE_VALUE){++failures;DeleteFileW(src);continue;}
        HANDLE gate=CreateEventW(nullptr,TRUE,FALSE,nullptr);
        std::atomic<bool> creatorWon{false};
        std::thread creator([&](){WaitForSingleObject(gate,INFINITE);creatorWon=writeFile(dst,"racer");});
        SetEvent(gate);
        NTSTATUS st=renameNt(sh,root,dstName);
        creator.join(); CloseHandle(gate); CloseHandle(sh);
        std::string value=readFile(dst);
        bool valid=(st>=0 && value=="source" && !creatorWon.load()) ||
                   (st==static_cast<NTSTATUS>(0xC0000035L) && value=="racer" && creatorWon.load());
        if(!valid)++failures;
        ++checks;
        DeleteFileW(src); DeleteFileW(dst);
    }
    CloseHandle(root);
    // Retained directory handle must continue to address the original directory after path swap.
    swprintf_s(rootPath,L"%s\\anchor",base); swprintf_s(moved,L"%s\\anchor-moved",base); swprintf_s(decoy,L"%s\\anchor-decoy",base);
    CreateDirectoryW(rootPath,nullptr);
    swprintf_s(stage,L"%s\\stage-anchor",base); CreateDirectoryW(stage,nullptr);
    root=CreateFileW(rootPath,FILE_TRAVERSE|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    wchar_t src[MAX_PATH]{},movedSource[MAX_PATH]{},dstOriginal[MAX_PATH]{},dstDecoy[MAX_PATH]{};
    swprintf_s(src,L"%s\\source",stage); swprintf_s(movedSource,L"%s\\source-moved",stage); writeFile(src,"anchored-source");
    HANDLE sh=CreateFileW(src,GENERIC_READ|DELETE|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
    bool movedOk=MoveFileExW(rootPath,moved,0)!=0 && CreateDirectoryW(rootPath,nullptr)!=0;
    HANDLE decoyHandle=CreateFileW(rootPath,FILE_TRAVERSE|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    bool sourcePathSwapped=sh!=INVALID_HANDLE_VALUE && MoveFileExW(src,movedSource,0)!=0 && writeFile(src,"source-decoy");
    NTSTATUS anchoredStatus=(movedOk&&sourcePathSwapped&&root!=INVALID_HANDLE_VALUE&&sh!=INVALID_HANDLE_VALUE)?renameNt(sh,root,L"anchored-result"):static_cast<NTSTATUS>(0xC0000001L);
    swprintf_s(dstOriginal,L"%s\\anchored-result",moved); swprintf_s(dstDecoy,L"%s\\anchored-result",rootPath);
    bool anchorPass=anchoredStatus>=0 && sourcePathSwapped && readFile(dstOriginal)=="anchored-source" && readFile(src)=="source-decoy" && GetFileAttributesW(movedSource)==INVALID_FILE_ATTRIBUTES && GetFileAttributesW(dstDecoy)==INVALID_FILE_ATTRIBUTES;
    if(!anchorPass)++failures; ++checks;
    printf("concurrent-no-replace-races=%d failures=%d\n",100,failures);
    printf("retained-parent-and-source-path-swap=%s NTSTATUS=0x%08lX\n",anchorPass?"PASS":"FAIL",static_cast<ULONG>(anchoredStatus));
    if(sh!=INVALID_HANDLE_VALUE)CloseHandle(sh); if(root!=INVALID_HANDLE_VALUE)CloseHandle(root); if(decoyHandle!=INVALID_HANDLE_VALUE)CloseHandle(decoyHandle);
    DeleteFileW(src); DeleteFileW(movedSource); DeleteFileW(dstOriginal); DeleteFileW(dstDecoy);
    RemoveDirectoryW(stage); RemoveDirectoryW(moved); RemoveDirectoryW(rootPath);
    std::wstring raceStage = std::wstring(base) + L"\\stage";
    std::wstring raceRoot = std::wstring(base) + L"\\race";
    RemoveDirectoryW(raceStage.c_str());
    RemoveDirectoryW(raceRoot.c_str());
    RemoveDirectoryW(base);
    printf("checks=%d failures=%d\n",checks,failures);
    return failures?1:0;
}
