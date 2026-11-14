#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string>
#include <vector>

static DWORD renameAttempt(HANDLE source, FILE_INFO_BY_HANDLE_CLASS cls,
    HANDLE root, const std::wstring& name, bool extended) {
    DWORD nameBytes = static_cast<DWORD>(name.size() * sizeof(wchar_t));
    DWORD bytes = static_cast<DWORD>(sizeof(FILE_RENAME_INFO) + nameBytes);
    std::vector<BYTE> buffer(bytes);
    auto* info = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    ZeroMemory(info, bytes);
    if (extended) info->Flags = 0;
    else info->ReplaceIfExists = FALSE;
    info->RootDirectory = root;
    info->FileNameLength = nameBytes;
    memcpy(info->FileName, name.data(), nameBytes);
    if (SetFileInformationByHandle(source, cls, info, bytes)) return ERROR_SUCCESS;
    return GetLastError();
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
    wchar_t temp[MAX_PATH]{}, dir[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 2;
    swprintf_s(dir, L"%sRayaRenameMatrix-%lu", temp, GetCurrentProcessId());
    if (!CreateDirectoryW(dir, nullptr)) return 2;
    wchar_t stageDir[MAX_PATH]{};
    swprintf_s(stageDir, L"%s\\stage", dir);
    if (!CreateDirectoryW(stageDir, nullptr)) { RemoveDirectoryW(dir); return 2; }
    HANDLE root = CreateFileW(dir, FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (root == INVALID_HANDLE_VALUE) { RemoveDirectoryW(stageDir); RemoveDirectoryW(dir); return 2; }

    struct Case { const wchar_t* label; FILE_INFO_BY_HANDLE_CLASS cls; bool extended; bool relative; };
    Case cases[] = {
        {L"legacy-relative", FileRenameInfo, false, true},
        {L"ex-relative", FileRenameInfoEx, true, true},
        {L"legacy-absolute", FileRenameInfo, false, false},
        {L"ex-absolute", FileRenameInfoEx, true, false}
    };
    int failures = 0;
    for (const auto& c : cases) {
        wchar_t sourcePath[MAX_PATH]{}, targetName[MAX_PATH]{}, targetPath[MAX_PATH]{};
        swprintf_s(sourcePath, L"%s\\src-%s.bin", stageDir, c.label);
        swprintf_s(targetName, L"dst-%s.bin", c.label);
        swprintf_s(targetPath, L"%s\\%s", dir, targetName);
        HANDLE source = INVALID_HANDLE_VALUE;
        bool made = makeFile(sourcePath, source);
        std::wstring target = c.relative ? targetName : std::wstring(targetPath);
        DWORD error = made ? renameAttempt(source, c.cls, c.relative ? root : nullptr, target, c.extended) : GetLastError();
        bool success = error == ERROR_SUCCESS;
        if (!success) ++failures;
        printf("%ls=%s error=%lu\\n", c.label, success ? "PASS" : "FAIL", error);
        if (source != INVALID_HANDLE_VALUE) CloseHandle(source);
        DeleteFileW(sourcePath);
        DeleteFileW(targetPath);
    }
    CloseHandle(root);
    RemoveDirectoryW(stageDir);
    RemoveDirectoryW(dir);
    printf("failures=%d\\n", failures);
    return failures ? 1 : 0;
}
