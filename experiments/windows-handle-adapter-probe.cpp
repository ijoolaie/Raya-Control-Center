#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#include <strsafe.h>
#include <string.h>

static int failures = 0;
static int assertions = 0;

static void require(bool condition, const wchar_t* label) {
    ++assertions;
    if (condition) {
        wprintf(L"PASS: %ls\n", label);
    } else {
        ++failures;
        wprintf(L"FAIL: %ls (winerr=%lu)\n", label, GetLastError());
    }
}

static bool file_id(HANDLE h, FILE_ID_INFO* out) {
    return GetFileInformationByHandleEx(h, FileIdInfo, out, sizeof(*out)) != 0;
}

static bool same_id(const FILE_ID_INFO& a, const FILE_ID_INFO& b) {
    if (a.VolumeSerialNumber != b.VolumeSerialNumber) return false;
    for (int i = 0; i < 16; ++i) if (a.FileId.Identifier[i] != b.FileId.Identifier[i]) return false;
    return true;
}

int wmain() {
    wchar_t temp[MAX_PATH] = {};
    wchar_t root[MAX_PATH] = {};
    wchar_t original[MAX_PATH] = {};
    wchar_t held[MAX_PATH] = {};
    wchar_t source[MAX_PATH] = {};
    wchar_t target[MAX_PATH] = {};
    GetTempPathW(MAX_PATH, temp);
    if (FAILED(StringCchPrintfW(root, MAX_PATH, L"%lsRayaWinHandleProbe-%lu", temp, GetCurrentProcessId()))) return 2;
    if (!CreateDirectoryW(root, nullptr)) { wprintf(L"setup failed %lu\n", GetLastError()); return 2; }
    StringCchPrintfW(original, MAX_PATH, L"%ls\\entry.bin", root);
    StringCchPrintfW(held, MAX_PATH, L"%ls\\held.bin", root);
    StringCchPrintfW(source, MAX_PATH, L"%ls\\source.bin", root);
    StringCchPrintfW(target, MAX_PATH, L"%ls\\target.bin", root);

    HANDLE h = CreateFileW(original, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(h != INVALID_HANDLE_VALUE, L"create original file");
    if (h == INVALID_HANDLE_VALUE) return 2;
    const char initial[] = "original-object";
    DWORD written = 0;
    require(WriteFile(h, initial, sizeof(initial) - 1, &written, nullptr) && written == sizeof(initial) - 1,
        L"write original contents");
    require(FlushFileBuffers(h) != 0, L"flush original file handle");
    FILE_ID_INFO originalId = {};
    require(file_id(h, &originalId), L"query handle-derived FileIdInfo");

    require(MoveFileExW(original, held, MOVEFILE_WRITE_THROUGH) != 0,
        L"rename original entry while retaining its handle");
    HANDLE replacement = CreateFileW(original, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(replacement != INVALID_HANDLE_VALUE, L"create replacement at original pathname");
    FILE_ID_INFO replacementId = {};
    if (replacement != INVALID_HANDLE_VALUE) {
        require(file_id(replacement, &replacementId), L"query replacement FileIdInfo");
        require(!same_id(originalId, replacementId), L"replacement pathname has a different file identity");
        FILE_ID_INFO retainedId = {};
        require(file_id(h, &retainedId) && same_id(originalId, retainedId),
            L"retained handle remains bound to original file identity");

        // A retained writable handle remains capable of mutating the renamed
        // original object; replacing the old pathname does not revoke it.
        LARGE_INTEGER zero = {};
        const char retainedWrite[] = "retained-handle-write";
        require(SetFilePointerEx(h, zero, nullptr, FILE_BEGIN) != 0
            && WriteFile(h, retainedWrite, sizeof(retainedWrite) - 1, &written, nullptr)
            && written == sizeof(retainedWrite) - 1,
            L"retained writable handle can mutate renamed original object");
        HANDLE heldRead = CreateFileW(held, GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        char heldData[64] = {};
        DWORD heldBytes = 0;
        bool heldMatches = heldRead != INVALID_HANDLE_VALUE
            && ReadFile(heldRead, heldData, sizeof(heldData), &heldBytes, nullptr)
            && heldBytes == sizeof(retainedWrite) - 1
            && memcmp(heldData, retainedWrite, heldBytes) == 0;
        require(heldMatches, L"renamed pathname exposes mutation through retained handle");
        if (heldRead != INVALID_HANDLE_VALUE) CloseHandle(heldRead);
        CloseHandle(replacement);
    }

    HANDLE src = CreateFileW(source, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    HANDLE dst = CreateFileW(target, GENERIC_READ | GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(src != INVALID_HANDLE_VALUE && dst != INVALID_HANDLE_VALUE, L"create no-replace test entries");
    if (src != INVALID_HANDLE_VALUE && dst != INVALID_HANDLE_VALUE) {
        const char a[] = "source";
        const char b[] = "keep-target";
        WriteFile(src, a, sizeof(a) - 1, &written, nullptr);
        WriteFile(dst, b, sizeof(b) - 1, &written, nullptr);
        CloseHandle(src);
        CloseHandle(dst);
        SetLastError(ERROR_SUCCESS);
        BOOL moved = MoveFileExW(source, target, MOVEFILE_WRITE_THROUGH);
        DWORD err = GetLastError();
        require(!moved && (err == ERROR_ALREADY_EXISTS || err == ERROR_FILE_EXISTS),
            L"MoveFileEx without replace refuses existing destination");
        HANDLE verify = CreateFileW(target, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        char data[32] = {};
        DWORD got = 0;
        bool intact = verify != INVALID_HANDLE_VALUE && ReadFile(verify, data, sizeof(data), &got, nullptr)
            && got == sizeof(b) - 1 && memcmp(data, b, got) == 0;
        require(intact, L"no-replace collision preserves existing destination bytes");
        if (verify != INVALID_HANDLE_VALUE) CloseHandle(verify);
    }

    HANDLE dir = CreateFileW(root, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    bool dirFlush = dir != INVALID_HANDLE_VALUE && FlushFileBuffers(dir) != 0;
    DWORD dirErr = GetLastError();
    wprintf(L"INFO: directory FlushFileBuffers supported=%ls error=%lu\n", dirFlush ? L"true" : L"false", dirErr);
    if (dir != INVALID_HANDLE_VALUE) CloseHandle(dir);

    CloseHandle(h);
    DeleteFileW(original);
    DeleteFileW(held);
    DeleteFileW(source);
    DeleteFileW(target);
    RemoveDirectoryW(root);
    wprintf(L"RESULT: assertions=%d failures=%d directoryFlush=%ls\n",
        assertions, failures, dirFlush ? L"supported" : L"unsupported");
    return failures ? 1 : 0;
}
