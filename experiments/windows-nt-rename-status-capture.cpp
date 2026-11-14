#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using NtSetInformationFileFn = NTSTATUS (NTAPI*)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

struct RenameInfoEx {
    ULONG Flags;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
};

struct CapturedResult {
    NTSTATUS syscallStatus;
    NTSTATUS iosbStatus;
    ULONG_PTR information;
    bool iosbChanged;
};

static CapturedResult renameCapture(
    HANDLE source, HANDLE root, const std::wstring& name) {
    const ULONG nameBytes = static_cast<ULONG>(name.size() * sizeof(WCHAR));
    const ULONG offset = static_cast<ULONG>(offsetof(RenameInfoEx, FileName));
    const ULONG bytes = offset + nameBytes;
    std::vector<BYTE> buffer(bytes, 0);
    auto* info = reinterpret_cast<RenameInfoEx*>(buffer.data());
    info->Flags = 0; // FileRenameInformationEx: no replace
    info->RootDirectory = root;
    info->FileNameLength = nameBytes;
    memcpy(info->FileName, name.data(), nameBytes);

    IO_STATUS_BLOCK iosb{};
    memset(&iosb, 0xCC, sizeof(iosb));
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto fn = reinterpret_cast<NtSetInformationFileFn>(
        ntdll ? GetProcAddress(ntdll, "NtSetInformationFile") : nullptr);
    if (!fn) {
        return {static_cast<NTSTATUS>(0xC0000002L),
                static_cast<NTSTATUS>(0xCCCCCCCCu), 0, false};
    }

    const NTSTATUS immediate = fn(
        source, &iosb, info, bytes,
        static_cast<FILE_INFORMATION_CLASS>(65));
    const bool changed = iosb.Status != static_cast<NTSTATUS>(0xCCCCCCCCu) ||
        iosb.Information != static_cast<ULONG_PTR>(0xCCCCCCCCCCCCCCCCull);
    return {immediate, iosb.Status, iosb.Information, changed};
}

static bool writeFile(const std::wstring& path, const char* bytes, DWORD length) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE | GENERIC_READ | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const bool ok = WriteFile(h, bytes, length, &written, nullptr) &&
        written == length && FlushFileBuffers(h);
    CloseHandle(h);
    return ok;
}

static bool readEquals(const std::wstring& path, const char* expected, DWORD length) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    char actual[128]{};
    DWORD read = 0;
    const bool ok = length <= sizeof(actual) &&
        ReadFile(h, actual, length, &read, nullptr) &&
        read == length && memcmp(actual, expected, length) == 0;
    CloseHandle(h);
    return ok;
}

static bool exists(const std::wstring& path) {
    return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

int wmain() {
    wchar_t temp[MAX_PATH]{}, dir[MAX_PATH]{}, stage[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 2;
    swprintf_s(dir, L"%sRayaNtStatusCapture-%lu", temp, GetCurrentProcessId());
    swprintf_s(stage, L"%s\\stage", dir);
    if (!CreateDirectoryW(dir, nullptr) || !CreateDirectoryW(stage, nullptr)) {
        RemoveDirectoryW(dir);
        return 2;
    }

    HANDLE root = CreateFileW(dir, FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
        FILE_ADD_FILE | FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (root == INVALID_HANDLE_VALUE) {
        RemoveDirectoryW(stage); RemoveDirectoryW(dir); return 2;
    }

    const std::wstring source = std::wstring(stage) + L"\\source.bin";
    const std::wstring target = std::wstring(dir) + L"\\target.bin";
    const std::wstring collisionSource = std::wstring(stage) + L"\\collision-source.bin";
    const std::wstring collisionTarget = std::wstring(dir) + L"\\collision-target.bin";
    const char sourceBytes[] = "native-status-capture-source";
    const char targetBytes[] = "existing-target-must-survive";
    int failures = 0;

    HANDLE sourceHandle = CreateFileW(source.c_str(), GENERIC_READ | GENERIC_WRITE |
        DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE |
        FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    DWORD written = 0;
    bool sourceReady = sourceHandle != INVALID_HANDLE_VALUE &&
        WriteFile(sourceHandle, sourceBytes, sizeof(sourceBytes), &written, nullptr) &&
        written == sizeof(sourceBytes) && FlushFileBuffers(sourceHandle);
    CapturedResult success{};
    if (sourceReady) success = renameCapture(sourceHandle, root, L"target.bin");
    else ++failures;

    const bool successPostconditions = sourceReady &&
        success.syscallStatus == 0 && success.iosbStatus == 0 &&
        success.iosbChanged && exists(target) && !exists(source) &&
        readEquals(target, sourceBytes, sizeof(sourceBytes));
    if (!successPostconditions) ++failures;
    printf("success syscall=0x%08lX iosb=0x%08lX information=%llu iosbChanged=%s postconditions=%s\n",
        static_cast<ULONG>(success.syscallStatus),
        static_cast<ULONG>(success.iosbStatus),
        static_cast<unsigned long long>(success.information),
        success.iosbChanged ? "yes" : "no",
        successPostconditions ? "PASS" : "FAIL");
    if (sourceHandle != INVALID_HANDLE_VALUE) CloseHandle(sourceHandle);

    bool collisionReady = writeFile(collisionSource, sourceBytes, sizeof(sourceBytes)) &&
        writeFile(collisionTarget, targetBytes, sizeof(targetBytes));
    HANDLE collisionHandle = CreateFileW(collisionSource.c_str(), DELETE |
        FILE_READ_ATTRIBUTES | GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE |
        FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    CapturedResult collision{};
    if (collisionReady && collisionHandle != INVALID_HANDLE_VALUE)
        collision = renameCapture(collisionHandle, root, L"collision-target.bin");
    else ++failures;

    const bool collisionPostconditions = collisionReady &&
        collisionHandle != INVALID_HANDLE_VALUE &&
        static_cast<ULONG>(collision.syscallStatus) == 0xC0000035u &&
        static_cast<ULONG>(collision.iosbStatus) == 0xCCCCCCCCu &&
        !collision.iosbChanged &&
        collision.information == static_cast<ULONG_PTR>(0xCCCCCCCCCCCCCCCCull) &&
        exists(collisionSource) &&
        readEquals(collisionTarget, targetBytes, sizeof(targetBytes));
    if (!collisionPostconditions) ++failures;
    printf("collision syscall=0x%08lX iosb=0x%08lX information=%llu iosbChanged=%s postconditions=%s\n",
        static_cast<ULONG>(collision.syscallStatus),
        static_cast<ULONG>(collision.iosbStatus),
        static_cast<unsigned long long>(collision.information),
        collision.iosbChanged ? "yes" : "no",
        collisionPostconditions ? "PASS" : "FAIL");
    if (collisionHandle != INVALID_HANDLE_VALUE) CloseHandle(collisionHandle);

    CloseHandle(root);
    DeleteFileW(source.c_str()); DeleteFileW(target.c_str());
    DeleteFileW(collisionSource.c_str()); DeleteFileW(collisionTarget.c_str());
    RemoveDirectoryW(stage); RemoveDirectoryW(dir);
    printf("SUMMARY cases=2 failures=%d\n", failures);
    return failures ? 1 : 0;
}
