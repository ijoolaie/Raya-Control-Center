#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <string>

static bool writeFile(const std::wstring& path, const char* data) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const DWORD size = static_cast<DWORD>(strlen(data));
    const bool ok = WriteFile(h, data, size, &written, nullptr) && written == size &&
        FlushFileBuffers(h);
    CloseHandle(h);
    return ok;
}
static bool equalsFile(const std::wstring& path, const char* expected) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    char buf[256]{};
    DWORD read = 0;
    const bool ok = ReadFile(h, buf, sizeof(buf), &read, nullptr) &&
        read == strlen(expected) && memcmp(buf, expected, read) == 0;
    CloseHandle(h);
    return ok;
}
int wmain() {
    wchar_t temp[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temp)) return 10;
    const std::wstring root = std::wstring(temp) + L"raya-move-write-through-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    if (!CreateDirectoryW(root.c_str(), nullptr)) return 11;
    const auto path = [&](const wchar_t* n) { return root + L"\\" + n; };

    bool ok = true;
    // Collision: no MOVEFILE_REPLACE_EXISTING flag is supplied.
    ok = ok && writeFile(path(L"stage-collision.bin"), "stage-data");
    ok = ok && writeFile(path(L"target-collision.bin"), "original-target");
    SetLastError(ERROR_SUCCESS);
    const BOOL collisionMove = MoveFileExW(path(L"stage-collision.bin").c_str(),
        path(L"target-collision.bin").c_str(), MOVEFILE_WRITE_THROUGH);
    const DWORD collisionError = collisionMove ? ERROR_SUCCESS : GetLastError();
    const bool collisionPreserved = !collisionMove &&
        equalsFile(path(L"stage-collision.bin"), "stage-data") &&
        equalsFile(path(L"target-collision.bin"), "original-target");
    std::wprintf(L"no-replace-collision=%ls error=%lu source-and-target-preserved=%ls\n",
        collisionPreserved ? L"PASS" : L"FAIL", collisionError,
        collisionPreserved ? L"yes" : L"no");

    // Successful same-volume rename with write-through flag.
    ok = ok && writeFile(path(L"stage-success.bin"), "write-through-payload");
    const BOOL successMove = MoveFileExW(path(L"stage-success.bin").c_str(),
        path(L"target-success.bin").c_str(), MOVEFILE_WRITE_THROUGH);
    const DWORD successError = successMove ? ERROR_SUCCESS : GetLastError();
    const bool successVerified = successMove &&
        GetFileAttributesW(path(L"stage-success.bin").c_str()) == INVALID_FILE_ATTRIBUTES &&
        equalsFile(path(L"target-success.bin"), "write-through-payload");
    std::wprintf(L"write-through-same-volume-rename=%ls error=%lu content-and-name=%ls\n",
        successVerified ? L"PASS" : L"FAIL", successError,
        successVerified ? L"verified" : L"mismatch");

    // Cleanup only names created in this unique directory.
    DeleteFileW(path(L"stage-collision.bin").c_str());
    DeleteFileW(path(L"target-collision.bin").c_str());
    DeleteFileW(path(L"stage-success.bin").c_str());
    DeleteFileW(path(L"target-success.bin").c_str());
    const bool cleaned = RemoveDirectoryW(root.c_str()) != FALSE;
    std::wprintf(L"cleanup=%ls\n", cleaned ? L"PASS" : L"FAIL");
    return ok && collisionPreserved && successVerified && cleaned ? 0 : 12;
}