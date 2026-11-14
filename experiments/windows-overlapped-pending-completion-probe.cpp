#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <string>

int wmain() {
    const std::wstring pipeName =
        L"\\\\.\\pipe\\RayaOverlappedPending-" + std::to_wstring(GetCurrentProcessId());
    HANDLE server = CreateNamedPipeW(
        pipeName.c_str(),
        PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1, 4096, 4096, 0, nullptr);
    if (server == INVALID_HANDLE_VALUE) {
        printf("CreateNamedPipe failed: %lu\n", GetLastError());
        return 2;
    }

    HANDLE client = CreateFileW(pipeName.c_str(), GENERIC_WRITE, 0, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (client == INVALID_HANDLE_VALUE) {
        printf("CreateFile client failed: %lu\n", GetLastError());
        CloseHandle(server);
        return 2;
    }

    OVERLAPPED connectOv{};
    connectOv.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!connectOv.hEvent) {
        CloseHandle(client); CloseHandle(server); return 2;
    }
    BOOL connected = ConnectNamedPipe(server, &connectOv);
    DWORD connectError = connected ? ERROR_SUCCESS : GetLastError();
    if (!connected && connectError != ERROR_PIPE_CONNECTED &&
        connectError != ERROR_IO_PENDING) {
        printf("ConnectNamedPipe failed: %lu\n", connectError);
        CloseHandle(connectOv.hEvent); CloseHandle(client); CloseHandle(server);
        return 2;
    }
    if (connectError == ERROR_IO_PENDING) {
        if (WaitForSingleObject(connectOv.hEvent, 5000) != WAIT_OBJECT_0) {
            printf("connect wait failed\n");
            CancelIoEx(server, &connectOv);
            CloseHandle(connectOv.hEvent); CloseHandle(client); CloseHandle(server);
            return 2;
        }
        DWORD ignored = 0;
        if (!GetOverlappedResult(server, &connectOv, &ignored, FALSE)) {
            printf("connect completion failed: %lu\n", GetLastError());
            CloseHandle(connectOv.hEvent); CloseHandle(client); CloseHandle(server);
            return 2;
        }
    }
    CloseHandle(connectOv.hEvent);

    OVERLAPPED readOv{};
    readOv.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!readOv.hEvent) {
        CloseHandle(client); CloseHandle(server); return 2;
    }
    char buffer[64]{};
    DWORD immediateBytes = 0;
    BOOL readNow = ReadFile(server, buffer, sizeof(buffer), &immediateBytes, &readOv);
    DWORD readError = readNow ? ERROR_SUCCESS : GetLastError();
    const bool pending = !readNow && readError == ERROR_IO_PENDING;
    printf("ReadFile immediate=%s error=%lu pending=%s bytes=%lu\n",
        readNow ? "TRUE" : "FALSE", readError, pending ? "yes" : "no",
        immediateBytes);
    if (!pending) {
        printf("Expected a real pending read; aborting without claiming async evidence.\n");
        CloseHandle(readOv.hEvent); CloseHandle(client); CloseHandle(server);
        return 1;
    }

    const char payload[] = "pending-completion-observed";
    DWORD written = 0;
    const bool writeOk = WriteFile(client, payload, sizeof(payload), &written, nullptr) &&
        written == sizeof(payload);
    if (!writeOk) {
        printf("client write failed: %lu\n", GetLastError());
        CancelIoEx(server, &readOv);
        WaitForSingleObject(readOv.hEvent, 5000);
        CloseHandle(readOv.hEvent); CloseHandle(client); CloseHandle(server);
        return 1;
    }

    const DWORD wait = WaitForSingleObject(readOv.hEvent, 5000);
    DWORD completedBytes = 0;
    const BOOL completionOk = wait == WAIT_OBJECT_0 &&
        GetOverlappedResult(server, &readOv, &completedBytes, FALSE);
    const bool contentOk = completionOk && completedBytes == sizeof(payload) &&
        memcmp(buffer, payload, sizeof(payload)) == 0;
    printf("completion wait=%lu getOverlappedResult=%s bytes=%lu content=%s status=%lu\n",
        wait, completionOk ? "success" : "failure", completedBytes,
        contentOk ? "PASS" : "FAIL", completionOk ? ERROR_SUCCESS : GetLastError());

    CloseHandle(readOv.hEvent);
    CloseHandle(client);
    CloseHandle(server);
    printf("SUMMARY pending_observed=%s completion_observed=%s result=%s\n",
        pending ? "yes" : "no", completionOk ? "yes" : "no",
        contentOk ? "PASS" : "FAIL");
    return contentOk ? 0 : 1;
}
