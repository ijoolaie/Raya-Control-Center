#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <cstddef>

using NtSetInformationFileFn = NTSTATUS (NTAPI*)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
using NtWaitForSingleObjectFn = NTSTATUS (NTAPI*)(HANDLE, BOOLEAN, PLARGE_INTEGER);

struct RenameInfoEx {
    ULONG Flags;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
};

struct Evidence {
    NTSTATUS immediate;
    NTSTATUS iosbStatus;
    ULONG_PTR information;
    bool iosbChanged;
    bool waitAttempted;
    DWORD waitResult;
    bool completionObserved;
};

static Evidence runRename(HANDLE source, HANDLE root, const std::wstring& name) {
    const ULONG nameBytes = static_cast<ULONG>(name.size() * sizeof(WCHAR));
    const ULONG offset = static_cast<ULONG>(offsetof(RenameInfoEx, FileName));
    const ULONG bytes = offset + nameBytes;
    std::vector<BYTE> buffer(bytes, 0);
    auto* info = reinterpret_cast<RenameInfoEx*>(buffer.data());
    info->Flags = 0;
    info->RootDirectory = root;
    info->FileNameLength = nameBytes;
    memcpy(info->FileName, name.data(), nameBytes);

    IO_STATUS_BLOCK iosb{};
    memset(&iosb, 0xCC, sizeof(iosb));
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto setInfo = reinterpret_cast<NtSetInformationFileFn>(
        ntdll ? GetProcAddress(ntdll, "NtSetInformationFile") : nullptr);
    auto wait = reinterpret_cast<NtWaitForSingleObjectFn>(
        ntdll ? GetProcAddress(ntdll, "NtWaitForSingleObject") : nullptr);
    if (!setInfo || !wait) {
        return {static_cast<NTSTATUS>(0xC0000002L),
            static_cast<NTSTATUS>(0xCCCCCCCCu), 0, false, false, WAIT_FAILED, false};
    }

    const NTSTATUS immediate = setInfo(source, &iosb, info, bytes,
        static_cast<FILE_INFORMATION_CLASS>(65));
    bool attempted = false;
    DWORD waitResult = WAIT_FAILED;
    bool observed = immediate != static_cast<NTSTATUS>(0x00000103L); // not STATUS_PENDING
    if (immediate == static_cast<NTSTATUS>(0x00000103L)) {
        attempted = true;
        LARGE_INTEGER timeout{};
        timeout.QuadPart = -10LL * 1000LL * 1000LL * 10LL; // 10 seconds, relative
        const NTSTATUS waitStatus = wait(source, FALSE, &timeout);
        waitResult = waitStatus == 0 ? WAIT_OBJECT_0 :
            (waitStatus == static_cast<NTSTATUS>(0x00000102L) ? WAIT_TIMEOUT : WAIT_FAILED);
        observed = waitStatus == 0;
    }

    const bool changed = iosb.Status != static_cast<NTSTATUS>(0xCCCCCCCCu) ||
        iosb.Information != static_cast<ULONG_PTR>(0xCCCCCCCCCCCCCCCCull);
    return {immediate, iosb.Status, iosb.Information, changed,
        attempted, waitResult, observed};
}

static bool readEquals(const std::wstring& path, const char* expected, DWORD length) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    char actual[128]{};
    DWORD read = 0;
    const bool ok = length <= sizeof(actual) &&
        ReadFile(h, actual, length, &read, nullptr) && read == length &&
        memcmp(actual, expected, length) == 0;
    CloseHandle(h);
    return ok;
}

int wmain() {
    wchar_t temp[MAX_PATH]{}, dir[MAX_PATH]{}, stage[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 2;
    swprintf_s(dir, L"%sRayaNtAsync-%lu", temp, GetCurrentProcessId());
    swprintf_s(stage, L"%s\\stage", dir);
    if (!CreateDirectoryW(dir, nullptr) || !CreateDirectoryW(stage, nullptr)) {
        RemoveDirectoryW(dir); return 2;
    }
    const std::wstring source = std::wstring(stage) + L"\\source.bin";
    const std::wstring target = std::wstring(dir) + L"\\target.bin";
    const char payload[] = "async-native-rename-probe";
    int failures = 0;

    HANDLE root = CreateFileW(dir, FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
        FILE_ADD_FILE | FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE |
        FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    HANDLE seed = CreateFileW(source.c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    DWORD written = 0;
    const bool seeded = seed != INVALID_HANDLE_VALUE &&
        WriteFile(seed, payload, sizeof(payload), &written, nullptr) &&
        written == sizeof(payload) && FlushFileBuffers(seed);
    if (seed != INVALID_HANDLE_VALUE) CloseHandle(seed);
    HANDLE file = seeded ? CreateFileW(source.c_str(), GENERIC_READ | GENERIC_WRITE |
        DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE |
        FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, nullptr) : INVALID_HANDLE_VALUE;
    if (root == INVALID_HANDLE_VALUE || file == INVALID_HANDLE_VALUE) {
        if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        DeleteFileW(source.c_str()); RemoveDirectoryW(stage); RemoveDirectoryW(dir); return 2;
    }

    const bool ready = seeded;
    Evidence result{};
    if (ready) result = runRename(file, root, L"target.bin");
    else ++failures;

    const bool pending = result.immediate == static_cast<NTSTATUS>(0x00000103L);
    const bool terminal = result.immediate == 0 ||
        (pending && result.completionObserved && result.iosbStatus == 0);
    const bool post = terminal && result.iosbChanged &&
        GetFileAttributesW(source.c_str()) == INVALID_FILE_ATTRIBUTES &&
        readEquals(target, payload, sizeof(payload));
    if (!post) ++failures;

    printf("immediate=0x%08lX iosb=0x%08lX information=%llu iosbChanged=%s pending=%s waitAttempted=%s waitResult=%lu completionObserved=%s postconditions=%s\n",
        static_cast<ULONG>(result.immediate), static_cast<ULONG>(result.iosbStatus),
        static_cast<unsigned long long>(result.information),
        result.iosbChanged ? "yes" : "no", pending ? "yes" : "no",
        result.waitAttempted ? "yes" : "no", result.waitResult,
        result.completionObserved ? "yes" : "no", post ? "PASS" : "FAIL");

    CloseHandle(file);
    CloseHandle(root);
    DeleteFileW(source.c_str()); DeleteFileW(target.c_str());
    RemoveDirectoryW(stage); RemoveDirectoryW(dir);
    printf("SUMMARY async-handle rename probe failures=%d\n", failures);
    return failures ? 1 : 0;
}
