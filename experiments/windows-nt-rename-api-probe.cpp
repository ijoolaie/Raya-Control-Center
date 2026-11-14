#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <stdio.h>
#include <string>
#include <vector>

using NtSetInformationFileFn = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

struct RenameBuffer {
    BOOLEAN ReplaceIfExists;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
};

static NTSTATUS renameNt(HANDLE source, ULONG infoClass, HANDLE root, const std::wstring& name) {
    const ULONG nameBytes = static_cast<ULONG>(name.size() * sizeof(WCHAR));
    const ULONG offset = static_cast<ULONG>(offsetof(RenameBuffer, FileName));
    const ULONG bytes = offset + nameBytes;
    std::vector<BYTE> buffer(bytes);
    auto* info = reinterpret_cast<RenameBuffer*>(buffer.data());
    ZeroMemory(info, bytes);
    info->ReplaceIfExists = FALSE;
    info->RootDirectory = root;
    info->FileNameLength = nameBytes;
    memcpy(info->FileName, name.data(), nameBytes);
    IO_STATUS_BLOCK iosb{};
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto fn = reinterpret_cast<NtSetInformationFileFn>(GetProcAddress(ntdll, "NtSetInformationFile"));
    if (!fn) return static_cast<NTSTATUS>(0xC0000002L);
    NTSTATUS status = fn(source, &iosb, info, bytes, static_cast<FILE_INFORMATION_CLASS>(infoClass));
    return NT_SUCCESS(status) ? iosb.Status : status;
}
static bool makeFile(const std::wstring& path, HANDLE& out) {
    out = CreateFileW(path.c_str(), GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (out == INVALID_HANDLE_VALUE) return false;
    const char data[] = "probe";
    DWORD n = 0;
    return WriteFile(out, data, sizeof(data), &n, nullptr) && FlushFileBuffers(out);
}
int wmain() {
    wchar_t temp[MAX_PATH]{}, dir[MAX_PATH]{}, stageDir[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 2;
    swprintf_s(dir, L"%sRayaNtRename-%lu", temp, GetCurrentProcessId());
    if (!CreateDirectoryW(dir, nullptr)) return 2;
    swprintf_s(stageDir, L"%s\\stage", dir);
    if (!CreateDirectoryW(stageDir, nullptr)) { RemoveDirectoryW(dir); return 2; }
    HANDLE root = CreateFileW(dir, FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (root == INVALID_HANDLE_VALUE) { RemoveDirectoryW(stageDir); RemoveDirectoryW(dir); return 2; }

    struct Case { const wchar_t* label; ULONG cls; bool relative; };
    Case cases[] = {
        {L"nt-legacy-relative", 10, true},
        {L"nt-ex-relative", 65, true},
        {L"nt-legacy-absolute", 10, false},
        {L"nt-ex-absolute", 65, false}
    };
    int failures = 0;
    for (const auto& c : cases) {
        wchar_t sourcePath[MAX_PATH]{}, targetName[MAX_PATH]{}, targetPath[MAX_PATH]{};
        swprintf_s(sourcePath, L"%s\\src-%s.bin", stageDir, c.label);
        swprintf_s(targetName, L"dst-%s.bin", c.label);
        swprintf_s(targetPath, L"%s\\%s", dir, targetName);
        HANDLE source = INVALID_HANDLE_VALUE;
        bool made = makeFile(sourcePath, source);
        std::wstring target = c.relative ? targetName : std::wstring(L"\\??\\") + targetPath;
        NTSTATUS status = made ? renameNt(source, c.cls, c.relative ? root : nullptr, target) : static_cast<NTSTATUS>(0xC0000001L);
        bool success = status >= 0;
        if (!success) ++failures;
        printf("%ls=%s NTSTATUS=0x%08lX\n", c.label, success ? "PASS" : "FAIL", static_cast<ULONG>(status));
        if (source != INVALID_HANDLE_VALUE) CloseHandle(source);
        DeleteFileW(sourcePath);
        DeleteFileW(targetPath);
    }
    struct CollisionCase { const wchar_t* label; ULONG cls; };
    CollisionCase collisions[] = {
        {L"nt-legacy-collision", 10},
        {L"nt-ex-collision", 65}
    };
    for (const auto& c : collisions) {
        wchar_t sourcePath[MAX_PATH]{}, targetName[MAX_PATH]{}, targetPath[MAX_PATH]{};
        swprintf_s(sourcePath, L"%s\\collision-src-%s.bin", stageDir, c.label);
        swprintf_s(targetName, L"collision-dst-%s.bin", c.label);
        swprintf_s(targetPath, L"%s\\%s", dir, targetName);
        HANDLE source = INVALID_HANDLE_VALUE;
        HANDLE target = INVALID_HANDLE_VALUE;
        bool sourceMade = makeFile(sourcePath, source);
        target = CreateFileW(targetPath, GENERIC_WRITE | GENERIC_READ,
            FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        const char guard[] = "keep-existing-target";
        DWORD written = 0;
        bool targetMade = target != INVALID_HANDLE_VALUE &&
            WriteFile(target, guard, sizeof(guard), &written, nullptr) &&
            written == sizeof(guard) && FlushFileBuffers(target);
        if (target != INVALID_HANDLE_VALUE) CloseHandle(target);
        NTSTATUS status = (sourceMade && targetMade)
            ? renameNt(source, c.cls, root, targetName)
            : static_cast<NTSTATUS>(0xC0000001L);
        if (source != INVALID_HANDLE_VALUE) CloseHandle(source);
        HANDLE verify = CreateFileW(targetPath, GENERIC_READ, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        char actual[sizeof(guard)]{};
        DWORD read = 0;
        bool targetPreserved = verify != INVALID_HANDLE_VALUE &&
            ReadFile(verify, actual, sizeof(actual), &read, nullptr) &&
            read == sizeof(guard) && memcmp(actual, guard, sizeof(guard)) == 0;
        if (verify != INVALID_HANDLE_VALUE) CloseHandle(verify);
        bool sourcePreserved = GetFileAttributesW(sourcePath) != INVALID_FILE_ATTRIBUTES;
        bool refused = status < 0 && sourcePreserved && targetPreserved;
        if (!refused) ++failures;
        printf("%ls=%s NTSTATUS=0x%08lX source-preserved=%s target-preserved=%s\n",
            c.label, refused ? "PASS" : "FAIL", static_cast<ULONG>(status),
            sourcePreserved ? "yes" : "no", targetPreserved ? "yes" : "no");
        DeleteFileW(sourcePath);
        DeleteFileW(targetPath);
    }
    CloseHandle(root);
    RemoveDirectoryW(stageDir);
    RemoveDirectoryW(dir);
    printf("failures=%d\n", failures);
    return failures ? 1 : 0;
}
