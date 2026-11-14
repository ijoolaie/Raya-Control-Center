#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>

static void report(const wchar_t* label, HANDLE handle) {
    if (handle == INVALID_HANDLE_VALUE) {
        std::wprintf(L"%ls open=FAIL error=%lu\n", label, GetLastError());
        return;
    }
    SetLastError(ERROR_SUCCESS);
    const BOOL ok = FlushFileBuffers(handle);
    const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
    std::wprintf(L"%ls flush=%ls error=%lu\n", label, ok ? L"SUCCESS" : L"FAIL", error);
    CloseHandle(handle);
}

int wmain() {
    wchar_t temp[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 10;
    wchar_t path[MAX_PATH]{};
    if (swprintf_s(path, L"%lsraya-dirflush-contract-%ls", temp, L"probe") < 0) return 11;
    if (!CreateDirectoryW(path, nullptr)) return 12;

    HANDLE observed = CreateFileW(path,
        FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_DELETE_CHILD | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    report(L"prototype-access-mask", observed);

    HANDLE readOnly = CreateFileW(path, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    report(L"read-attributes-only", readOnly);

    HANDLE genericWrite = CreateFileW(path, GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    report(L"generic-write", genericWrite);

    if (!RemoveDirectoryW(path)) {
        std::wprintf(L"cleanup=FAIL error=%lu\n", GetLastError());
        return 13;
    }
    std::wprintf(L"cleanup=PASS\n");
    return 0;
}