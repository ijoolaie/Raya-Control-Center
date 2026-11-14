#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
struct Identity { ULONGLONG volume; BYTE id[16]; };
static bool identity(HANDLE h, Identity& out) {
    FILE_ID_INFO info{};
    if (!GetFileInformationByHandleEx(h, FileIdInfo, &info, sizeof(info))) return false;
    out.volume = info.VolumeSerialNumber;
    memcpy(out.id, info.FileId.Identifier, sizeof(out.id));
    return true;
}
static bool same(const Identity& a, const Identity& b) {
    return a.volume == b.volume && memcmp(a.id, b.id, sizeof(a.id)) == 0;
}
static bool unlinkOwned(HANDLE entry, const Identity& expected) {
    Identity actual{};
    if (!identity(entry, actual) || !same(actual, expected)) return false;
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    return SetFileInformationByHandle(entry, FileDispositionInfo, &disposition, sizeof(disposition)) != FALSE;
}
int wmain() {
    wchar_t temp[MAX_PATH]{}, dir[MAX_PATH]{}, path[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 2;
    swprintf_s(dir, L"%sRayaUnlinkProbe-%lu", temp, GetCurrentProcessId());
    swprintf_s(path, L"%s\\entry.bin", dir);
    if (!CreateDirectoryW(dir, nullptr)) return 2;
    HANDLE root = CreateFileW(dir, FILE_READ_ATTRIBUTES | FILE_DELETE_CHILD,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    HANDLE seed = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    bool setup = root != INVALID_HANDLE_VALUE && seed != INVALID_HANDLE_VALUE;
    if (seed != INVALID_HANDLE_VALUE) CloseHandle(seed);
    HANDLE entry = setup ? CreateFileW(path, DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr) : INVALID_HANDLE_VALUE;
    Identity actual{};
    bool opened = entry != INVALID_HANDLE_VALUE && identity(entry, actual);
    Identity wrong = actual;
    wrong.id[0] ^= 0x80;
    bool mismatchRefused = opened && !unlinkOwned(entry, wrong) &&
        GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
    bool marked = mismatchRefused && unlinkOwned(entry, actual);
    if (entry != INVALID_HANDLE_VALUE) CloseHandle(entry);
    bool absent = GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND;
    printf("setup=%s handle-identity=%s mismatch-refused=%s disposition-by-handle=%s pathname-absent=%s\\n",
        setup ? "PASS" : "FAIL", opened ? "PASS" : "FAIL",
        mismatchRefused ? "PASS" : "FAIL", marked ? "PASS" : "FAIL", absent ? "PASS" : "FAIL");
    if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
    DeleteFileW(path);
    RemoveDirectoryW(dir);
    return setup && opened && mismatchRefused && marked && absent ? 0 : 1;
}
