#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <stdio.h>
#include <string>
#include <vector>
#include <algorithm>
#include <thread>
#include <atomic>
#include <set>

#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

using NtCreateFileFn = NTSTATUS (NTAPI*)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtSetInformationFileFn = NTSTATUS (NTAPI*)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

struct FileIdentity {
    ULONGLONG volumeSerial;
    BYTE fileId[16];
};

struct DirectoryEntry {
    std::wstring name;
    BYTE fileId[16];
    ULONGLONG volumeSerial;
    DWORD attributes;
};

static bool identityOf(HANDLE h, FileIdentity& out) {
    FILE_ID_INFO info{};
    if (!GetFileInformationByHandleEx(h, FileIdInfo, &info, sizeof(info))) return false;
    out.volumeSerial = info.VolumeSerialNumber;
    memcpy(out.fileId, info.FileId.Identifier, sizeof(out.fileId));
    return true;
}

static bool sameIdentity(const FileIdentity& a, const FileIdentity& b) {
    return a.volumeSerial == b.volumeSerial &&
        memcmp(a.fileId, b.fileId, sizeof(a.fileId)) == 0;
}

static bool validSingleComponentName(const std::wstring& name) {
    return !name.empty() &&
        name.size() <= (USHRT_MAX / sizeof(WCHAR)) &&
        name.find_first_of(L"\\\\/:") == std::wstring::npos &&
        name.find(L'\0') == std::wstring::npos &&
        name != L"." && name != L"..";
}
static bool parseDirectoryRecords(const BYTE* buffer, size_t bufferBytes, size_t maxEntries, ULONGLONG volumeSerial, std::vector<DirectoryEntry>& entries) {
    if (!buffer || bufferBytes == 0 || maxEntries == 0) return false;
    const size_t nameOffset = FIELD_OFFSET(FILE_ID_EXTD_DIR_INFO, FileName);
    size_t offset = 0;
    for (;;) {
        if (offset > bufferBytes || nameOffset > bufferBytes - offset) { entries.clear(); return false; }
        const size_t remaining = bufferBytes - offset;
        const auto* item = reinterpret_cast<const FILE_ID_EXTD_DIR_INFO*>(buffer + offset);
        const ULONG nextOffset = item->NextEntryOffset;
        if ((item->FileNameLength % sizeof(WCHAR)) != 0 || item->FileNameLength > remaining - nameOffset ||
            (nextOffset != 0 && (nextOffset < nameOffset || nextOffset > remaining ||
             nextOffset % alignof(FILE_ID_EXTD_DIR_INFO) != 0 || item->FileNameLength > nextOffset - nameOffset))) {
            entries.clear(); return false;
        }
        const size_t chars = item->FileNameLength / sizeof(WCHAR);
        std::wstring name(item->FileName, chars);
        if (name.find(L'\0') != std::wstring::npos ||
            (name != L"." && name != L".." && (name.empty() || name.find_first_of(L"\\\\/:") != std::wstring::npos))) {
            entries.clear(); return false;
        }
        if (name != L"." && name != L"..") {
            DirectoryEntry entry{}; entry.name = std::move(name);
            memcpy(entry.fileId, item->FileId.Identifier, sizeof(entry.fileId));
            entry.volumeSerial = volumeSerial; entry.attributes = item->FileAttributes;
            entries.push_back(std::move(entry));
            if (entries.size() > maxEntries) { entries.clear(); return false; }
        }
        if (nextOffset == 0) return true;
        offset += nextOffset;
    }
}
static bool appendUniqueDirectoryBatch(std::vector<DirectoryEntry>& accumulated, const std::vector<DirectoryEntry>& batch, size_t maxEntries) {
    if (accumulated.size() > maxEntries || batch.size() > maxEntries - accumulated.size()) return false;
    std::set<std::wstring> names;
    for (const auto& entry : accumulated) {
        if (!names.insert(entry.name).second) return false;
    }
    for (const auto& entry : batch) {
        if (!names.insert(entry.name).second) return false;
    }
    accumulated.insert(accumulated.end(), batch.begin(), batch.end());
    return true;
}
static bool directoryParserMalformedInputTests() {
    constexpr size_t capacity = 512;
    const size_t nameOffset = FIELD_OFFSET(FILE_ID_EXTD_DIR_INFO, FileName);
    auto makeRecord = [](BYTE* data, size_t bytes, ULONG next, const WCHAR* name, USHORT chars) {
        ZeroMemory(data, bytes);
        auto* item = reinterpret_cast<FILE_ID_EXTD_DIR_INFO*>(data);
        item->NextEntryOffset = next;
        item->FileNameLength = static_cast<ULONG>(chars * sizeof(WCHAR));
        item->FileAttributes = FILE_ATTRIBUTE_NORMAL;
        item->FileId.Identifier[0] = 0x5a;
        if (chars) memcpy(item->FileName, name, chars * sizeof(WCHAR));
    };
    auto parse = [](const BYTE* data, size_t bytes, size_t limit = 8) {
        std::vector<DirectoryEntry> entries;
        return parseDirectoryRecords(data, bytes, limit, 7, entries);
    };
    alignas(FILE_ID_EXTD_DIR_INFO) BYTE buffer[capacity]{};
    const WCHAR good[] = L"x";
    makeRecord(buffer, capacity, 0, good, 1);
    if (!parse(buffer, nameOffset + sizeof(WCHAR))) return false;
    if (parse(buffer, nameOffset - 1)) return false; // truncated fixed header
    auto* first = reinterpret_cast<FILE_ID_EXTD_DIR_INFO*>(buffer);
    first->FileNameLength = 1; if (parse(buffer, capacity)) return false; // odd UTF-16 byte count
    first->FileNameLength = 0xFFFFFFFEu; if (parse(buffer, capacity)) return false; // length overflow/out of bounds
    first->FileNameLength = sizeof(WCHAR);
    first->NextEntryOffset = static_cast<ULONG>(nameOffset - alignof(FILE_ID_EXTD_DIR_INFO));
    if (parse(buffer, capacity)) return false; // offset before filename payload
    first->NextEntryOffset = static_cast<ULONG>(capacity + alignof(FILE_ID_EXTD_DIR_INFO));
    if (parse(buffer, capacity)) return false; // offset beyond supplied buffer
    first->NextEntryOffset = static_cast<ULONG>(nameOffset + sizeof(WCHAR) + 1);
    if (parse(buffer, capacity)) return false; // unaligned offset
    const size_t alignedShortOffset = (nameOffset + sizeof(WCHAR) + alignof(FILE_ID_EXTD_DIR_INFO) - 1) & ~(alignof(FILE_ID_EXTD_DIR_INFO) - 1);
    first->NextEntryOffset = static_cast<ULONG>(alignedShortOffset);
    if (parse(buffer, alignedShortOffset + nameOffset - 1)) return false; // aligned next record with truncated fixed header
    first->NextEntryOffset = 0;
    const WCHAR embedded[] = { L'a', L'\0', L'b' };
    makeRecord(buffer, capacity, 0, embedded, 3);
    if (parse(buffer, nameOffset + sizeof(embedded))) return false; // embedded NUL
    const WCHAR slash[] = L"a/b"; makeRecord(buffer, capacity, 0, slash, 3);
    if (parse(buffer, nameOffset + sizeof(slash) - sizeof(WCHAR))) return false; // separator
    const WCHAR empty[] = L""; makeRecord(buffer, capacity, 0, empty, 0);
    if (parse(buffer, nameOffset)) return false; // empty component
    makeRecord(buffer, capacity, 0, good, 1);
    if (parse(buffer, nameOffset + sizeof(WCHAR), 0)) return false; // zero entry budget
    // Two valid records, then enforce the aggregate entry bound.
    const size_t stride = (nameOffset + sizeof(WCHAR) + alignof(FILE_ID_EXTD_DIR_INFO) - 1) & ~(alignof(FILE_ID_EXTD_DIR_INFO) - 1);
    ZeroMemory(buffer, capacity);
    makeRecord(buffer, capacity, static_cast<ULONG>(stride), good, 1);
    makeRecord(buffer + stride, capacity - stride, 0, good, 1);
    if (!parse(buffer, stride + nameOffset + sizeof(WCHAR), 2)) return false;
    if (parse(buffer, stride + nameOffset + sizeof(WCHAR), 1)) return false;
    // A final record with a payload truncated at the supplied boundary.
    makeRecord(buffer, capacity, 0, good, 1);
    if (parse(buffer, nameOffset)) return false;
    // Simulate separate kernel batches while the directory namespace is changing.
    auto makeEntry = [](const wchar_t* name, BYTE id) {
        DirectoryEntry entry{}; entry.name = name; entry.fileId[0] = id; entry.volumeSerial = 7; return entry;
    };
    std::vector<DirectoryEntry> accumulated{ makeEntry(L"alpha.bin", 1) };
    std::vector<DirectoryEntry> distinctBatch{ makeEntry(L"beta.bin", 2) };
    if (!appendUniqueDirectoryBatch(accumulated, distinctBatch, 4) || accumulated.size() != 2) return false;
    std::vector<DirectoryEntry> repeatedAcrossBatch{ makeEntry(L"alpha.bin", 3) };
    if (appendUniqueDirectoryBatch(accumulated, repeatedAcrossBatch, 4) || accumulated.size() != 2) return false;
    std::vector<DirectoryEntry> repeatedWithinBatch{ makeEntry(L"gamma.bin", 4), makeEntry(L"gamma.bin", 5) };
    if (appendUniqueDirectoryBatch(accumulated, repeatedWithinBatch, 4) || accumulated.size() != 2) return false;
    std::vector<DirectoryEntry> overflowBatch{ makeEntry(L"gamma.bin", 4), makeEntry(L"delta.bin", 5), makeEntry(L"epsilon.bin", 6) };
    if (appendUniqueDirectoryBatch(accumulated, overflowBatch, 4) || accumulated.size() != 2) return false;
    std::vector<DirectoryEntry> emptyBatch;
    if (!appendUniqueDirectoryBatch(accumulated, emptyBatch, 4) || accumulated.size() != 2) return false;
    return true;
}
class NativeContext {
public:
    NativeContext() = default;
    NativeContext(const NativeContext&) = delete;
    NativeContext& operator=(const NativeContext&) = delete;
    ~NativeContext() { close(); }

    bool openRoot(const std::wstring& path) {
        close();
        root_ = CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_DELETE_CHILD | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (root_ == INVALID_HANDLE_VALUE) { root_ = nullptr; return false; }
        FILE_ATTRIBUTE_TAG_INFO tag{};
        if (!GetFileInformationByHandleEx(root_, FileAttributeTagInfo, &tag, sizeof(tag)) ||
            !(tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
            (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
            !identityOf(root_, rootIdentity_)) {
            close();
            return false;
        }
        return true;
    }

    bool openChildReadOnly(const std::wstring& name, HANDLE& child, FileIdentity& identity) {
        child = INVALID_HANDLE_VALUE;
        if (!root_ || !validSingleComponentName(name) || !sameParent()) return false;

        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        auto ntCreateFile = reinterpret_cast<NtCreateFileFn>(
            ntdll ? GetProcAddress(ntdll, "NtCreateFile") : nullptr);
        if (!ntCreateFile) return false;

        UNICODE_STRING relativeName{};
        relativeName.Buffer = const_cast<PWSTR>(name.c_str());
        relativeName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
        relativeName.MaximumLength = relativeName.Length;
        OBJECT_ATTRIBUTES attributes{};
        InitializeObjectAttributes(&attributes, &relativeName,
            OBJ_CASE_INSENSITIVE, root_, nullptr);

        IO_STATUS_BLOCK iosb{};
        HANDLE opened = INVALID_HANDLE_VALUE;
        NTSTATUS status = ntCreateFile(&opened, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &attributes, &iosb, nullptr, FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT |
            FILE_SYNCHRONOUS_IO_NONALERT, nullptr, 0);
        if (!NT_SUCCESS(status)) return false;

        FILE_ATTRIBUTE_TAG_INFO tag{};
        FileIdentity observed{};
        bool valid = GetFileInformationByHandleEx(opened, FileAttributeTagInfo, &tag, sizeof(tag)) &&
            !(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            !(tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
            identityOf(opened, observed) && sameParent();
        if (!valid) { CloseHandle(opened); return false; }
        child = opened;
        identity = observed;
        return true;
    }

    bool openChildForDelete(const std::wstring& name, HANDLE& child, FileIdentity& identity) {
        child = INVALID_HANDLE_VALUE;
        if (!root_ || !validSingleComponentName(name) || !sameParent()) return false;
        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        auto ntCreateFile = reinterpret_cast<NtCreateFileFn>(
            ntdll ? GetProcAddress(ntdll, "NtCreateFile") : nullptr);
        if (!ntCreateFile) return false;
        UNICODE_STRING relativeName{};
        relativeName.Buffer = const_cast<PWSTR>(name.c_str());
        relativeName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
        relativeName.MaximumLength = relativeName.Length;
        OBJECT_ATTRIBUTES attributes{};
        InitializeObjectAttributes(&attributes, &relativeName, OBJ_CASE_INSENSITIVE, root_, nullptr);
        IO_STATUS_BLOCK iosb{};
        HANDLE opened = INVALID_HANDLE_VALUE;
        NTSTATUS status = ntCreateFile(&opened, DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &attributes, &iosb, nullptr, FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT |
            FILE_SYNCHRONOUS_IO_NONALERT, nullptr, 0);
        if (!NT_SUCCESS(status)) return false;
        FILE_ATTRIBUTE_TAG_INFO tag{};
        FileIdentity observed{};
        const bool valid = GetFileInformationByHandleEx(opened, FileAttributeTagInfo, &tag, sizeof(tag)) &&
            !(tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
            identityOf(opened, observed) && sameParent();
        if (!valid) { CloseHandle(opened); return false; }
        child = opened;
        identity = observed;
        return true;
    }

    // Enumerate names from the retained directory handle only. Returned names
    // are untrusted metadata; callers must open each entry relative to this root.
    bool enumerateChildren(size_t maxEntries, std::vector<DirectoryEntry>& entries) const {
        entries.clear();
        if (!root_ || maxEntries == 0 || !sameParent()) return false;

        alignas(FILE_ID_EXTD_DIR_INFO) BYTE buffer[64 * 1024];
        bool restart = true;
        while (true) {
            const FILE_INFO_BY_HANDLE_CLASS infoClass = restart
                ? FileIdExtdDirectoryRestartInfo : FileIdExtdDirectoryInfo;
            restart = false;
            if (!GetFileInformationByHandleEx(root_, infoClass,
                buffer, sizeof(buffer))) {
                const DWORD error = GetLastError();
                if (error == ERROR_NO_MORE_FILES) return sameParent();
                entries.clear();
                return false;
            }

            std::vector<DirectoryEntry> batch;
            if (!parseDirectoryRecords(buffer, sizeof(buffer), maxEntries, rootIdentity_.volumeSerial, batch) ||
                !appendUniqueDirectoryBatch(entries, batch, maxEntries)) {
                entries.clear();
                return false;
            }
        }
        return sameParent();
    }

    // Bind later opens to the complete 128-bit ID and volume token from enumeration.
    bool openEnumeratedChildReadOnly(const DirectoryEntry& entry, HANDLE& child, FileIdentity& identity) {
        child = INVALID_HANDLE_VALUE;
        if (entry.volumeSerial != rootIdentity_.volumeSerial || (entry.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return false;
        if (!openChildReadOnly(entry.name, child, identity)) return false;
        if (identity.volumeSerial != entry.volumeSerial || memcmp(identity.fileId, entry.fileId, sizeof(entry.fileId)) != 0) { CloseHandle(child); child = INVALID_HANDLE_VALUE; return false; }
        return true;
    }

    // Hash bytes read from the already-open handle. The caller supplies a strict
    // byte ceiling; identity and size are checked before and after the read.
    bool readAndHash(HANDLE entry, const FileIdentity& expected,
        ULONGLONG maxBytes, ULONGLONG& bytesRead, std::vector<BYTE>& digest) const {
        bytesRead = 0;
        digest.clear();
        if (!entry || !sameParent()) return false;

        FileIdentity before{};
        FILE_ATTRIBUTE_TAG_INFO tag{};
        LARGE_INTEGER initialSize{};
        if (!identityOf(entry, before) || !sameIdentity(before, expected) ||
            !GetFileInformationByHandleEx(entry, FileAttributeTagInfo, &tag, sizeof(tag)) ||
            (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
            !GetFileSizeEx(entry, &initialSize) || initialSize.QuadPart < 0 ||
            static_cast<ULONGLONG>(initialSize.QuadPart) > maxBytes) return false;

        BCRYPT_ALG_HANDLE algorithm = nullptr;
        BCRYPT_HASH_HANDLE hash = nullptr;
        DWORD objectBytes = 0, returned = 0, hashBytes = 0;
        std::vector<BYTE> hashObject;
        bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
            nullptr, 0) == 0;
        if (ok) ok = BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&objectBytes), sizeof(objectBytes), &returned, 0) == 0;
        if (ok) ok = BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hashBytes), sizeof(hashBytes), &returned, 0) == 0;
        if (ok && (objectBytes == 0 || hashBytes != 32)) ok = false;
        if (ok) {
            hashObject.resize(objectBytes);
            digest.resize(hashBytes);
            ok = BCryptCreateHash(algorithm, &hash, hashObject.data(), objectBytes,
                nullptr, 0, 0) == 0;
        }

        LARGE_INTEGER zero{};
        if (ok) ok = SetFilePointerEx(entry, zero, nullptr, FILE_BEGIN) != FALSE;
        BYTE buffer[64 * 1024];
        while (ok) {
            DWORD count = 0;
            if (!ReadFile(entry, buffer, sizeof(buffer), &count, nullptr)) {
                ok = false;
                break;
            }
            if (count == 0) break;
            if (static_cast<ULONGLONG>(count) > maxBytes - bytesRead ||
                BCryptHashData(hash, buffer, count, 0) != 0) {
                ok = false;
                break;
            }
            bytesRead += count;
        }
        if (ok) ok = BCryptFinishHash(hash, digest.data(), hashBytes, 0) == 0;

        LARGE_INTEGER finalSize{};
        FileIdentity after{};
        if (ok) ok = GetFileSizeEx(entry, &finalSize) &&
            finalSize.QuadPart == initialSize.QuadPart &&
            bytesRead == static_cast<ULONGLONG>(initialSize.QuadPart) &&
            identityOf(entry, after) && sameIdentity(after, expected) && sameParent();

        if (hash) BCryptDestroyHash(hash);
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        if (!ok) {
            digest.clear();
            bytesRead = 0;
        }
        return ok;
    }

    bool flushFile(HANDLE entry, const FileIdentity& expected) const {
        lastOperationError_ = ERROR_SUCCESS;
        lastFlushMayHaveCompleted_ = false;
        if (!root_ || !entry || !sameParent()) {
            lastOperationError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        FileIdentity before{};
        if (!identityOf(entry, before) || !sameIdentity(before, expected)) {
            lastOperationError_ = ERROR_INVALID_DATA;
            return false;
        }
        lastFlushMayHaveCompleted_ = true;
        if (injectFlushCallFailureForProbe_) {
            lastOperationError_ = ERROR_GEN_FAILURE;
            return false;
        }
        if (!FlushFileBuffers(entry)) {
            lastOperationError_ = GetLastError();
            return false;
        }
        if (injectPostFlushFailureForProbe_ || !sameParent()) {
            lastOperationError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        FileIdentity after{};
        if (!identityOf(entry, after) || !sameIdentity(after, expected)) {
            lastOperationError_ = ERROR_INVALID_DATA;
            return false;
        }
        lastFlushMayHaveCompleted_ = false;
        return true;
    }
    bool lastFlushMayHaveCompleted() const { return lastFlushMayHaveCompleted_; }
    void injectFlushCallFailureForProbe(bool enabled) { injectFlushCallFailureForProbe_ = enabled; }
    void injectPostFlushFailureForProbe(bool enabled) { injectPostFlushFailureForProbe_ = enabled; }

    bool closeOwned(HANDLE& entry) const {
        lastCloseError_ = ERROR_SUCCESS;
        lastCloseMayHaveCompleted_ = false;
        if (!entry || entry == INVALID_HANDLE_VALUE) {
            lastCloseError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        lastCloseMayHaveCompleted_ = true;
        if (injectCloseFailureForProbe_) {
            lastCloseError_ = ERROR_GEN_FAILURE;
            return false;
        }
        if (!CloseHandle(entry)) {
            lastCloseError_ = GetLastError();
            return false;
        }
        entry = INVALID_HANDLE_VALUE;
        lastCloseMayHaveCompleted_ = false;
        return true;
    }
    DWORD lastCloseError() const { return lastCloseError_; }
    bool lastCloseMayHaveCompleted() const { return lastCloseMayHaveCompleted_; }
    void injectCloseFailureForProbe(bool enabled) { injectCloseFailureForProbe_ = enabled; }
    DWORD lastOperationError() const { return lastOperationError_; }

    bool sameParent() const {
        if (!root_) return false;
        FileIdentity current{};
        return identityOf(root_, current) && sameIdentity(rootIdentity_, current);
    }

    // Experimental only: ask Windows to flush the retained directory handle.
    // This does not imply the filesystem/driver honors directory-entry durability.
    bool flushParentDirectoryForProbe() const {
        lastDirectoryFlushError_ = ERROR_SUCCESS;
        lastDirectoryFlushMayHaveCompleted_ = false;
        if (!root_ || !sameParent()) {
            lastDirectoryFlushError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        lastDirectoryFlushMayHaveCompleted_ = true;
        if (!FlushFileBuffers(root_)) {
            lastDirectoryFlushError_ = GetLastError();
            return false;
        }
        if (!sameParent()) {
            lastDirectoryFlushError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        lastDirectoryFlushMayHaveCompleted_ = false;
        return true;
    }
    DWORD lastDirectoryFlushError() const { return lastDirectoryFlushError_; }
    bool lastDirectoryFlushMayHaveCompleted() const { return lastDirectoryFlushMayHaveCompleted_; }

    // Rename an already-open stage handle into this retained directory.
    // FILE_RENAME_FLAG_FAIL_IF_EXISTS makes publication no-replace.
    bool publishNoReplace(HANDLE stage, const std::wstring& targetName,
        const FileIdentity& expectedStage) const {
        lastImmediateStatus_ = static_cast<NTSTATUS>(0xCCCCCCCC);
        lastIosbStatus_ = static_cast<NTSTATUS>(0xCCCCCCCC);
        lastIosbInformation_ = static_cast<ULONG_PTR>(0xCCCCCCCC);
        lastIosbChanged_ = false;
        lastPublishMayHaveCompleted_ = false;
        if (!root_ || !stage || !validSingleComponentName(targetName) || !sameParent()) return false;

        FileIdentity actual{};
        if (!identityOf(stage, actual) || !sameIdentity(actual, expectedStage)) return false;

        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        auto ntSetInformationFile = reinterpret_cast<NtSetInformationFileFn>(
            ntdll ? GetProcAddress(ntdll, "NtSetInformationFile") : nullptr);
        if (!ntSetInformationFile) return false;

        const ULONG nameBytes = static_cast<ULONG>(targetName.size() * sizeof(wchar_t));
        const size_t allocationBytes = offsetof(FILE_RENAME_INFO, FileName) + nameBytes;
        std::vector<BYTE> storage(allocationBytes);
        auto* info = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
        ZeroMemory(storage.data(), storage.size());
        // FileRenameInformationEx (class 65): zero flags means no replacement.
        info->Flags = 0;
        info->RootDirectory = root_;
        info->FileNameLength = nameBytes;
        memcpy(info->FileName, targetName.data(), nameBytes);

        IO_STATUS_BLOCK iosb{};
        iosb.Status = static_cast<NTSTATUS>(0xCCCCCCCC);
        iosb.Information = static_cast<ULONG_PTR>(0xCCCCCCCC);
        const NTSTATUS immediate = ntSetInformationFile(
            stage, &iosb, info, static_cast<ULONG>(allocationBytes),
            static_cast<FILE_INFORMATION_CLASS>(65));
        lastImmediateStatus_ = immediate;
        lastIosbStatus_ = iosb.Status;
        lastIosbInformation_ = iosb.Information;
        lastIosbChanged_ = iosb.Status != static_cast<NTSTATUS>(0xCCCCCCCC) ||
            iosb.Information != static_cast<ULONG_PTR>(0xCCCCCCCC);
        lastPublishMayHaveCompleted_ = true;
        if (immediate == static_cast<NTSTATUS>(0xC0000035)) {
            lastPublishMayHaveCompleted_ = false;
            return false;
        }
        if (immediate < 0) return false;

        // This prototype accepts synchronous completion only. Pending is not success,
        // and may already have reached the kernel: preserve an ambiguous outcome.
        if (immediate == static_cast<NTSTATUS>(0x00000103)) {
            lastPublishMayHaveCompleted_ = true;
            return false;
        }
        if (iosb.Status != static_cast<NTSTATUS>(0)) return false;

        lastPublishMayHaveCompleted_ = true;
        if (injectPostPublishParentFailure_ || !sameParent()) return false;
        FileIdentity after{};
        if (!identityOf(stage, after) || !sameIdentity(after, expectedStage)) return false;
        lastPublishMayHaveCompleted_ = false;
        return true;
    }

    NTSTATUS lastImmediateStatus() const { return lastImmediateStatus_; }
    NTSTATUS lastIosbStatus() const { return lastIosbStatus_; }
    ULONG_PTR lastIosbInformation() const { return lastIosbInformation_; }
    bool lastIosbChanged() const { return lastIosbChanged_; }
    bool lastPublishMayHaveCompleted() const { return lastPublishMayHaveCompleted_; }
    void injectPostPublishParentFailureForProbe(bool enabled) { injectPostPublishParentFailure_ = enabled; }
    // Mark deletion by the already-open handle, only after matching the
    // caller's expected identity. A failed post-check is possibly-completed.
    bool unlinkOwned(HANDLE entry, const FileIdentity& expected) const {
        lastOperationError_ = ERROR_SUCCESS;
        lastUnlinkMayHaveCompleted_ = false;
        if (!root_ || !entry || !sameParent()) {
            lastOperationError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        FileIdentity actual{};
        if (!identityOf(entry, actual) || !sameIdentity(actual, expected)) {
            lastOperationError_ = ERROR_INVALID_DATA;
            return false;
        }
        FILE_DISPOSITION_INFO disposition{};
        disposition.DeleteFile = TRUE;
        // Once the native disposition boundary is reached, failures remain
        // possibly-completed; a FALSE result is not used as a cleanup/retry grant.
        lastUnlinkMayHaveCompleted_ = true;
        if (injectDispositionCallFailureForProbe_) {
            // Synthetic uncertainty injection; this does not invoke the OS API.
            lastOperationError_ = ERROR_GEN_FAILURE;
            return false;
        }
        if (!SetFileInformationByHandle(entry, FileDispositionInfo,
            &disposition, sizeof(disposition))) {
            lastOperationError_ = GetLastError();
            return false;
        }
        if (injectPostDispositionParentFailure_ || !sameParent()) {
            lastOperationError_ = ERROR_INVALID_HANDLE;
            return false;
        }
        lastUnlinkMayHaveCompleted_ = false;
        return true;
    }
    bool lastUnlinkMayHaveCompleted() const { return lastUnlinkMayHaveCompleted_; }
    void injectPostDispositionParentFailureForProbe(bool enabled) { injectPostDispositionParentFailure_ = enabled; }
    void injectDispositionCallFailureForProbe(bool enabled) { injectDispositionCallFailureForProbe_ = enabled; }

    void close() {
        if (root_) { CloseHandle(root_); root_ = nullptr; }
        ZeroMemory(&rootIdentity_, sizeof(rootIdentity_));
    }

private:
    HANDLE root_ = nullptr;
    FileIdentity rootIdentity_{};
    mutable DWORD lastOperationError_ = ERROR_SUCCESS;
    mutable bool lastFlushMayHaveCompleted_ = false;
    mutable DWORD lastDirectoryFlushError_ = ERROR_SUCCESS;
    mutable bool lastDirectoryFlushMayHaveCompleted_ = false;
    mutable DWORD lastCloseError_ = ERROR_SUCCESS;
    mutable bool lastCloseMayHaveCompleted_ = false;
    bool injectFlushCallFailureForProbe_ = false;
    bool injectPostFlushFailureForProbe_ = false;
    bool injectCloseFailureForProbe_ = false;
    mutable bool lastUnlinkMayHaveCompleted_ = false;
    bool injectPostDispositionParentFailure_ = false;
    bool injectDispositionCallFailureForProbe_ = false;
    mutable NTSTATUS lastImmediateStatus_ = static_cast<NTSTATUS>(0xCCCCCCCC);
    mutable NTSTATUS lastIosbStatus_ = static_cast<NTSTATUS>(0xCCCCCCCC);
    mutable ULONG_PTR lastIosbInformation_ = static_cast<ULONG_PTR>(0xCCCCCCCC);
    mutable bool lastIosbChanged_ = false;
    mutable bool lastPublishMayHaveCompleted_ = false;
    bool injectPostPublishParentFailure_ = false;
};

static bool concurrentEnumerationProbe(NativeContext& context, const std::wstring& root) {
    wchar_t racePath[MAX_PATH]{};
    swprintf_s(racePath, L"%s\\race-entry.bin", root.c_str());
    std::atomic<bool> stop{false};
    std::atomic<unsigned long> created{0};
    std::thread mutator([&]() {
        while (!stop.load()) {
            HANDLE file = CreateFileW(racePath, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (file != INVALID_HANDLE_VALUE) {
                const char value[] = "racing-entry";
                DWORD written = 0;
                if (WriteFile(file, value, sizeof(value) - 1, &written, nullptr) && written == sizeof(value) - 1) {
                    FlushFileBuffers(file);
                    created.fetch_add(1);
                }
                CloseHandle(file);
                DeleteFileW(racePath);
            } else {
                Sleep(0);
            }
        }
    });

    unsigned long successfulEnumerations = 0;
    unsigned long tokenConflicts = 0;
    bool safe = true;
    for (unsigned int i = 0; i < 250; ++i) {
        std::vector<DirectoryEntry> entries;
        if (context.enumerateChildren(128, entries)) {
            ++successfulEnumerations;
            for (const auto& entry : entries) {
                if (entry.name != L"race-entry.bin") continue;
                HANDLE opened = INVALID_HANDLE_VALUE;
                FileIdentity observed{};
                if (context.openEnumeratedChildReadOnly(entry, opened, observed)) {
                    FileIdentity token{};
                    token.volumeSerial = entry.volumeSerial;
                    memcpy(token.fileId, entry.fileId, sizeof(token.fileId));
                    if (!sameIdentity(observed, token)) safe = false;
                    CloseHandle(opened);
                } else {
                    ++tokenConflicts;
                }
            }
        }
        Sleep(0);
    }
    stop.store(true);
    mutator.join();
    DeleteFileW(racePath);
    printf("namespace-churn-created=%lu enumeration-successes=%lu token-open-conflicts=%lu safe=%s\\n", created.load(), successfulEnumerations, tokenConflicts, safe ? "yes" : "no");
    return safe && successfulEnumerations > 0 && created.load() > 0;
}

static int runNativeMultiProcessWorker(const std::wstring& root, unsigned int workerId, unsigned int iterations) {
    NativeContext context;
    if (!context.openRoot(root)) return 10;
    unsigned long published = 0;
    unsigned long tokenOpened = 0;
    unsigned long enumerations = 0;
    for (unsigned int i = 0; i < iterations; ++i) {
        wchar_t stageName[96]{}, targetName[96]{}, stagePath[MAX_PATH]{};
        swprintf_s(stageName, L"mp-%u-%u.stage", workerId, i);
        swprintf_s(targetName, L"mp-%u-%u.bin", workerId, i);
        swprintf_s(stagePath, L"%s\\%s", root.c_str(), stageName);
        HANDLE stage = CreateFileW(stagePath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL, nullptr);
        if (stage == INVALID_HANDLE_VALUE) return 11;
        const char payload[] = "native-multiprocess-payload";
        DWORD written = 0;
        const bool staged = WriteFile(stage, payload, sizeof(payload) - 1, &written, nullptr) &&
            written == sizeof(payload) - 1 && FlushFileBuffers(stage);
        FileIdentity expected{};
        const bool identified = staged && identityOf(stage, expected);
        const bool renamed = identified && context.publishNoReplace(stage, targetName, expected);
        if (!renamed) { CloseHandle(stage); return 12; }
        ++published;
        std::vector<DirectoryEntry> entries;
        if (!context.enumerateChildren(4096, entries)) { CloseHandle(stage); return 13; }
        ++enumerations;
        auto found = std::find_if(entries.begin(), entries.end(), [&](const DirectoryEntry& entry) {
            return entry.name == targetName;
        });
        if (found == entries.end()) { CloseHandle(stage); return 14; }
        HANDLE opened = INVALID_HANDLE_VALUE;
        FileIdentity observed{};
        if (!context.openEnumeratedChildReadOnly(*found, opened, observed) ||
            !sameIdentity(observed, expected)) {
            if (opened != INVALID_HANDLE_VALUE) CloseHandle(opened);
            CloseHandle(stage);
            return 15;
        }
        ++tokenOpened;
        CloseHandle(opened);
        if (!context.unlinkOwned(stage, expected)) { CloseHandle(stage); return 16; }
        CloseHandle(stage);
    }
    printf("native-worker=%u published=%lu token-opened=%lu enumerations=%lu\\n",
        workerId, published, tokenOpened, enumerations);
    return published == iterations && tokenOpened == iterations ? 0 : 17;
}

static int runNativeCrashWorker(const std::wstring& root, const std::wstring& failpoint) {
    NativeContext context;
    if (!context.openRoot(root)) return 30;
    const wchar_t* stageName = L"crash.stage";
    const wchar_t* targetName = L"crash.bin";
    wchar_t stagePath[MAX_PATH]{};
    swprintf_s(stagePath, L"%s\\%s", root.c_str(), stageName);
    HANDLE stage = CreateFileW(stagePath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (stage == INVALID_HANDLE_VALUE) return 31;
    const char payload[] = "native-crash-transition";
    DWORD written = 0;
    if (!WriteFile(stage, payload, sizeof(payload) - 1, &written, nullptr) ||
        written != sizeof(payload) - 1 || !FlushFileBuffers(stage)) return 32;
    FileIdentity expected{};
    if (!identityOf(stage, expected)) return 33;
    if (failpoint == L"after-stage-flush") ExitProcess(81);
    if (failpoint == L"after-stage-close") {
        if (!context.closeOwned(stage)) return 39;
        ExitProcess(84);
    }
    if (!context.publishNoReplace(stage, targetName, expected)) return 34;
    if (failpoint == L"after-publish") ExitProcess(82);
    std::vector<DirectoryEntry> entries;
    if (!context.enumerateChildren(8, entries)) return 35;
    auto found = std::find_if(entries.begin(), entries.end(), [&](const DirectoryEntry& entry) {
        return entry.name == targetName;
    });
    if (found == entries.end()) return 36;
    HANDLE opened = INVALID_HANDLE_VALUE;
    FileIdentity observed{};
    if (!context.openEnumeratedChildReadOnly(*found, opened, observed) ||
        !sameIdentity(observed, expected)) return 37;
    if (failpoint == L"after-token-open") ExitProcess(83);
    CloseHandle(opened);
    if (!context.unlinkOwned(stage, expected)) return 38;
    CloseHandle(stage);
    return 0;
}

static bool runNativeCrashRecoveryProbe(const std::wstring& root) {
    wchar_t executable[MAX_PATH]{};
    if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) return false;
    const wchar_t* failpoints[] = { L"after-stage-flush", L"after-stage-close", L"after-publish", L"after-token-open" };
    const DWORD expectedCodes[] = { 81, 84, 82, 83 };
    const wchar_t* expectedNames[] = { L"crash.stage", L"crash.stage", L"crash.bin", L"crash.bin" };
    bool allSafe = true;
    for (unsigned int i = 0; i < 4; ++i) {
        wchar_t caseRoot[MAX_PATH]{};
        swprintf_s(caseRoot, L"%s\\crash-case-%u", root.c_str(), i + 1);
        if (!CreateDirectoryW(caseRoot, nullptr)) return false;
        wchar_t commandLine[2048]{};
        swprintf_s(commandLine, L"\"%s\" --native-crash-worker \"%s\" %s",
            executable, caseRoot, failpoints[i]);
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(nullptr, commandLine, nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
            nullptr, nullptr, &startup, &process)) { RemoveDirectoryW(caseRoot); return false; }
        WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exitCode = 0;
        const bool exitedAtPoint = GetExitCodeProcess(process.hProcess, &exitCode) &&
            exitCode == expectedCodes[i];
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);

        NativeContext inspector;
        std::vector<DirectoryEntry> entries;
        bool oneExpectedEntry = exitedAtPoint && inspector.openRoot(caseRoot) &&
            inspector.enumerateChildren(8, entries) && entries.size() == 1 &&
            entries[0].name == expectedNames[i];
        HANDLE recovered = INVALID_HANDLE_VALUE;
        FileIdentity recoveredId{};
        bool identityBound = oneExpectedEntry &&
            inspector.openEnumeratedChildReadOnly(entries[0], recovered, recoveredId);
        ULONGLONG bytes = 0;
        std::vector<BYTE> digest;
        bool contentValid = identityBound &&
            inspector.readAndHash(recovered, recoveredId, 1024, bytes, digest) &&
            bytes == sizeof("native-crash-transition") - 1;
        if (recovered != INVALID_HANDLE_VALUE) CloseHandle(recovered);
        HANDLE deleteHandle = INVALID_HANDLE_VALUE;
        FileIdentity deleteIdentity{};
        bool deleteHandleBound = contentValid &&
            inspector.openChildForDelete(expectedNames[i], deleteHandle, deleteIdentity) &&
            sameIdentity(deleteIdentity, recoveredId);
        bool cleaned = deleteHandleBound && inspector.unlinkOwned(deleteHandle, deleteIdentity);
        if (deleteHandle != INVALID_HANDLE_VALUE) CloseHandle(deleteHandle);
        std::vector<DirectoryEntry> after;
        bool emptyAfterRecovery = inspector.enumerateChildren(8, after) && after.empty();
        inspector.close();
        RemoveDirectoryW(caseRoot);
        const bool passed = exitedAtPoint && oneExpectedEntry && identityBound &&
            contentValid && cleaned && emptyAfterRecovery;
        printf("native-crash-point=%ls exit=%lu expected-entry=%s identity=%s content=%s operator-cleanup=%s empty-after=%s result=%s\\n",
            failpoints[i], static_cast<unsigned long>(exitCode),
            oneExpectedEntry ? "yes" : "no", identityBound ? "yes" : "no",
            contentValid ? "yes" : "no", cleaned ? "yes" : "no",
            emptyAfterRecovery ? "yes" : "no", passed ? "PASS" : "FAIL");
        allSafe = allSafe && passed;
    }
    return allSafe;
}

static bool runNativeMultiProcessProbe(const std::wstring& root, unsigned int workers, unsigned int iterations) {
    std::vector<PROCESS_INFORMATION> processes;
    wchar_t executable[MAX_PATH]{};
    if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) return false;
    for (unsigned int id = 1; id <= workers; ++id) {
        wchar_t commandLine[2048]{};
        swprintf_s(commandLine, L"\"%s\" --native-worker \"%s\" %u %u",
            executable, root.c_str(), id, iterations);
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(nullptr, commandLine, nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
            nullptr, nullptr, &startup, &process)) {
            for (auto& started : processes) {
                TerminateProcess(started.hProcess, 99);
                CloseHandle(started.hThread);
                CloseHandle(started.hProcess);
            }
            return false;
        }
        processes.push_back(process);
    }
    bool allPassed = true;
    for (auto& process : processes) {
        WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exitCode = 0;
        if (!GetExitCodeProcess(process.hProcess, &exitCode) || exitCode != 0) allPassed = false;
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    return allPassed;
}

static int runNativeUnlinkSwapWorker(const std::wstring& root) {
    wchar_t target[MAX_PATH]{}, moved[MAX_PATH]{};
    swprintf_s(target, L"%s\\unlink-target.bin", root.c_str());
    swprintf_s(moved, L"%s\\original-moved.bin", root.c_str());
    if (!MoveFileExW(target, moved, MOVEFILE_WRITE_THROUGH)) return 71;
    HANDLE decoy = CreateFileW(target, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (decoy == INVALID_HANDLE_VALUE) return 72;
    const char bytes[] = "replacement-decoy";
    DWORD written = 0;
    const bool ok = WriteFile(decoy, bytes, sizeof(bytes) - 1, &written, nullptr) &&
        written == sizeof(bytes) - 1 && FlushFileBuffers(decoy);
    CloseHandle(decoy);
    return ok ? 0 : 73;
}

static int runNativeDeleteWithObserverWorker(const std::wstring& root) {
    NativeContext context;
    HANDLE owned = INVALID_HANDLE_VALUE;
    FileIdentity identity{};
    if (!context.openRoot(root) ||
        !context.openChildForDelete(L"observer-target.bin", owned, identity)) return 81;
    const bool deleted = context.unlinkOwned(owned, identity);
    CloseHandle(owned);
    context.close();
    return deleted ? 0 : 82;
}

static bool runNativeDeleteWithObserverProbe(const std::wstring& root) {
    wchar_t caseRoot[MAX_PATH]{}, target[MAX_PATH]{};
    swprintf_s(caseRoot, L"%s\\observer-delete", root.c_str());
    swprintf_s(target, L"%s\\observer-target.bin", caseRoot);
    if (!CreateDirectoryW(caseRoot, nullptr)) return false;
    HANDLE seed = CreateFileW(target, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    const char payload[] = "observer-retains-object";
    DWORD written = 0;
    bool seeded = seed != INVALID_HANDLE_VALUE &&
        WriteFile(seed, payload, sizeof(payload) - 1, &written, nullptr) &&
        written == sizeof(payload) - 1 && FlushFileBuffers(seed);
    if (seed != INVALID_HANDLE_VALUE) CloseHandle(seed);
    HANDLE observer = seeded ? CreateFileW(target, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) : INVALID_HANDLE_VALUE;
    FileIdentity before{};
    bool observerOpened = observer != INVALID_HANDLE_VALUE && identityOf(observer, before);
    wchar_t executable[MAX_PATH]{};
    bool launched = observerOpened && GetModuleFileNameW(nullptr, executable, MAX_PATH) != 0;
    PROCESS_INFORMATION process{};
    if (launched) {
        wchar_t commandLine[2048]{};
        swprintf_s(commandLine, L"\"%s\" --native-delete-observer-worker \"%s\"",
            executable, caseRoot);
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        launched = CreateProcessW(nullptr, commandLine, nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process) != FALSE;
    }
    bool workerDone = launched && WaitForSingleObject(process.hProcess, 10000) == WAIT_OBJECT_0;
    DWORD workerExit = 0;
    if (workerDone) workerDone = GetExitCodeProcess(process.hProcess, &workerExit) && workerExit == 0;
    if (launched) {
        if (!workerDone) TerminateProcess(process.hProcess, 98);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    FileIdentity after{};
    char observed[64]{};
    DWORD read = 0;
    bool observerUsable = workerDone && identityOf(observer, after) &&
        sameIdentity(before, after) && SetFilePointer(observer, 0, nullptr, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
        ReadFile(observer, observed, sizeof(observed), &read, nullptr) &&
        read == sizeof(payload) - 1 && memcmp(observed, payload, read) == 0;
    SetLastError(NO_ERROR);
    HANDLE reopened = CreateFileW(target, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    const DWORD reopenError = reopened == INVALID_HANDLE_VALUE ? GetLastError() : NO_ERROR;
    bool nameUnavailableWhileObserverOpen = reopened == INVALID_HANDLE_VALUE &&
        (reopenError == ERROR_ACCESS_DENIED || reopenError == ERROR_FILE_NOT_FOUND);
    if (reopened != INVALID_HANDLE_VALUE) CloseHandle(reopened);
    if (observer != INVALID_HANDLE_VALUE) CloseHandle(observer);
    bool nameAbsentAfterLastClose = GetFileAttributesW(target) == INVALID_FILE_ATTRIBUTES &&
        GetLastError() == ERROR_FILE_NOT_FOUND;
    printf("native-delete-with-cross-process-observer=%s worker=%s observer-usable=%s name-unavailable-before-last-close=%s name-absent-after-last-close=%s\\n",
        workerDone ? "PASS" : "FAIL", workerDone ? "PASS" : "FAIL",
        observerUsable ? "PASS" : "FAIL", nameUnavailableWhileObserverOpen ? "PASS" : "FAIL",
        nameAbsentAfterLastClose ? "PASS" : "FAIL");
    DeleteFileW(target);
    RemoveDirectoryW(caseRoot);
    return seeded && observerOpened && workerDone && observerUsable &&
        nameUnavailableWhileObserverOpen && nameAbsentAfterLastClose;
}

static bool runNativeUnlinkSwapProbe(const std::wstring& root) {
    wchar_t caseRoot[MAX_PATH]{}, target[MAX_PATH]{}, moved[MAX_PATH]{};
    swprintf_s(caseRoot, L"%s\\unlink-swap", root.c_str());
    swprintf_s(target, L"%s\\unlink-target.bin", caseRoot);
    swprintf_s(moved, L"%s\\original-moved.bin", caseRoot);
    if (!CreateDirectoryW(caseRoot, nullptr)) return false;
    HANDLE seed = CreateFileW(target, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    const char original[] = "original-object";
    DWORD written = 0;
    bool seeded = seed != INVALID_HANDLE_VALUE &&
        WriteFile(seed, original, sizeof(original) - 1, &written, nullptr) &&
        written == sizeof(original) - 1 && FlushFileBuffers(seed);
    if (seed != INVALID_HANDLE_VALUE) CloseHandle(seed);
    NativeContext context;
    HANDLE retained = INVALID_HANDLE_VALUE;
    FileIdentity expected{};
    bool retainedOpen = seeded && context.openRoot(caseRoot) &&
        context.openChildForDelete(L"unlink-target.bin", retained, expected);
    wchar_t executable[MAX_PATH]{};
    bool launched = retainedOpen && GetModuleFileNameW(nullptr, executable, MAX_PATH) != 0;
    PROCESS_INFORMATION process{};
    if (launched) {
        wchar_t commandLine[2048]{};
        swprintf_s(commandLine, L"\"%s\" --native-unlink-swap-worker \"%s\"",
            executable, caseRoot);
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        launched = CreateProcessW(nullptr, commandLine, nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process) != FALSE;
    }
    bool workerDone = launched && WaitForSingleObject(process.hProcess, 10000) == WAIT_OBJECT_0;
    DWORD workerExit = 0;
    if (workerDone) workerDone = GetExitCodeProcess(process.hProcess, &workerExit) && workerExit == 0;
    if (launched) {
        if (!workerDone) TerminateProcess(process.hProcess, 98);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    bool unlinkAccepted = workerDone && retainedOpen && context.unlinkOwned(retained, expected);
    if (retained != INVALID_HANDLE_VALUE) CloseHandle(retained);
    HANDLE decoy = CreateFileW(target, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    char observed[32]{};
    DWORD read = 0;
    bool decoyPreserved = decoy != INVALID_HANDLE_VALUE &&
        ReadFile(decoy, observed, sizeof(observed), &read, nullptr) &&
        read == sizeof("replacement-decoy") - 1 &&
        memcmp(observed, "replacement-decoy", read) == 0;
    if (decoy != INVALID_HANDLE_VALUE) CloseHandle(decoy);
    bool originalRemoved = GetFileAttributesW(moved) == INVALID_FILE_ATTRIBUTES &&
        GetLastError() == ERROR_FILE_NOT_FOUND;
    printf("native-unlink-cross-process-swap=%s worker=%s retained-handle-unlink=%s replacement-preserved=%s original-name-removed=%s\\n",
        workerDone ? "PASS" : "FAIL", workerDone ? "PASS" : "FAIL",
        unlinkAccepted ? "PASS" : "FAIL", decoyPreserved ? "PASS" : "FAIL",
        originalRemoved ? "PASS" : "FAIL");
    context.close();
    DeleteFileW(target);
    DeleteFileW(moved);
    RemoveDirectoryW(caseRoot);
    return seeded && retainedOpen && workerDone && unlinkAccepted && decoyPreserved && originalRemoved;
}

static int runPublishRaceWorker(const std::wstring& root, unsigned int id, const std::wstring& eventName) {
    NativeContext context;
    if (!context.openRoot(root)) return 40;
    wchar_t stageName[96]{}, stagePath[MAX_PATH]{};
    swprintf_s(stageName, L"race-%u.stage", id);
    swprintf_s(stagePath, L"%s\\%s", root.c_str(), stageName);
    HANDLE stage = CreateFileW(stagePath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (stage == INVALID_HANDLE_VALUE) return 41;
    char payload[32]{};
    sprintf_s(payload, "race-worker-%u", id);
    DWORD written = 0;
    bool ready = WriteFile(stage, payload, static_cast<DWORD>(strlen(payload)), &written, nullptr) &&
        written == strlen(payload) && FlushFileBuffers(stage);
    FileIdentity expected{};
    ready = ready && identityOf(stage, expected);
    HANDLE gate = OpenEventW(SYNCHRONIZE, FALSE, eventName.c_str());
    if (!ready || !gate) { if (gate) CloseHandle(gate); CloseHandle(stage); return 42; }
    const DWORD wait = WaitForSingleObject(gate, 10000);
    CloseHandle(gate);
    if (wait != WAIT_OBJECT_0) { CloseHandle(stage); return 43; }
    const bool published = context.publishNoReplace(stage, L"race-winner.bin", expected);
    const NTSTATUS immediate = context.lastImmediateStatus();
    const NTSTATUS iosb = context.lastIosbStatus();
    if (published && immediate == static_cast<NTSTATUS>(0) && iosb == static_cast<NTSTATUS>(0)) { CloseHandle(stage); return 0; }
    if (!published && immediate == static_cast<NTSTATUS>(0xC0000035)) {
        const bool loserStageRemoved = context.unlinkOwned(stage, expected);
        CloseHandle(stage);
        return loserStageRemoved ? 20 : 45;
    }
    CloseHandle(stage);
    return 44;
}

static int runPublishDeleteWorker(const std::wstring& root, bool publisher, const std::wstring& eventName) {
    NativeContext context;
    if (!context.openRoot(root)) return 50;
    HANDLE entry = INVALID_HANDLE_VALUE;
    FileIdentity expected{};
    wchar_t stagePath[MAX_PATH]{};
    if (publisher) {
        swprintf_s(stagePath, L"%s\\publish-delete.stage", root.c_str());
        entry = CreateFileW(stagePath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL, nullptr);
        const char payload[] = "publish-delete-race";
        DWORD written = 0;
        if (entry == INVALID_HANDLE_VALUE || !WriteFile(entry, payload, sizeof(payload) - 1, &written, nullptr) ||
            written != sizeof(payload) - 1 || !FlushFileBuffers(entry) || !identityOf(entry, expected)) {
            if (entry != INVALID_HANDLE_VALUE) CloseHandle(entry);
            return 51;
        }
    } else if (!context.openChildForDelete(L"publish-delete-target.bin", entry, expected)) {
        return 52;
    }
    HANDLE gate = OpenEventW(SYNCHRONIZE, FALSE, eventName.c_str());
    if (!gate) { CloseHandle(entry); return 53; }
    const DWORD wait = WaitForSingleObject(gate, 10000);
    CloseHandle(gate);
    if (wait != WAIT_OBJECT_0) { CloseHandle(entry); return 54; }
    if (publisher) {
        const bool published = context.publishNoReplace(entry, L"publish-delete-target.bin", expected);
        const NTSTATUS immediate = context.lastImmediateStatus();
        const NTSTATUS iosb = context.lastIosbStatus();
        const bool ambiguous = context.lastPublishMayHaveCompleted();
        printf("publish-delete-worker immediate=0x%08lX iosb=0x%08lX ambiguous=%s\\n",
            static_cast<unsigned long>(immediate), static_cast<unsigned long>(iosb), ambiguous ? "yes" : "no");
        if (published && immediate == 0 && iosb == 0) { CloseHandle(entry); return 0; }
        if (!published && immediate == static_cast<NTSTATUS>(0xC0000035) && !ambiguous) {
            const bool removed = context.unlinkOwned(entry, expected);
            CloseHandle(entry);
            return removed ? 20 : 55;
        }
        CloseHandle(entry);
        return ambiguous ? 22 : 56;
    }
    const bool removed = context.unlinkOwned(entry, expected);
    const bool ambiguous = context.lastUnlinkMayHaveCompleted();
    printf("delete-worker success=%s win32-error=%lu ambiguous=%s\\n",
        removed ? "yes" : "no", static_cast<unsigned long>(context.lastOperationError()), ambiguous ? "yes" : "no");
    CloseHandle(entry);
    return removed ? 0 : (ambiguous ? 32 : 31);
}

static bool runPublishRaceProbe(const std::wstring& root) {
    wchar_t eventName[128]{};
    swprintf_s(eventName, L"Local\\RayaPublishRace-%lu", GetCurrentProcessId());
    HANDLE gate = CreateEventW(nullptr, TRUE, FALSE, eventName);
    if (!gate) return false;
    wchar_t executable[MAX_PATH]{};
    if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) { CloseHandle(gate); return false; }
    PROCESS_INFORMATION processes[2]{};
    bool launched[2]{};
    for (unsigned int i = 0; i < 2; ++i) {
        wchar_t command[2048]{};
        swprintf_s(command, L"\"%s\" --publish-race-worker \"%s\" %u \"%s\"",
            executable, root.c_str(), i + 1, eventName);
        STARTUPINFOW startup{}; startup.cb = sizeof(startup);
        launched[i] = CreateProcessW(nullptr, command, nullptr, nullptr, FALSE, 0, nullptr, nullptr,
            &startup, &processes[i]) != FALSE;
        if (!launched[i]) break;
    }
    bool completed = launched[0] && launched[1];
    if (completed) SetEvent(gate);
    DWORD exits[2]{};
    for (unsigned int i = 0; i < 2; ++i) {
        if (launched[i]) {
            if (WaitForSingleObject(processes[i].hProcess, 15000) != WAIT_OBJECT_0 ||
                !GetExitCodeProcess(processes[i].hProcess, &exits[i])) completed = false;
            CloseHandle(processes[i].hThread); CloseHandle(processes[i].hProcess);
        }
    }
    CloseHandle(gate);
    const bool oneWinner = (exits[0] == 0 && exits[1] == 20) || (exits[1] == 0 && exits[0] == 20);
    wchar_t target[MAX_PATH]{}, stage1[MAX_PATH]{}, stage2[MAX_PATH]{};
    swprintf_s(target, L"%s\\race-winner.bin", root.c_str());
    swprintf_s(stage1, L"%s\\race-1.stage", root.c_str());
    swprintf_s(stage2, L"%s\\race-2.stage", root.c_str());
    HANDLE winner = CreateFileW(target, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    char bytes[32]{}; DWORD read = 0;
    const bool contentValid = winner != INVALID_HANDLE_VALUE && ReadFile(winner, bytes, sizeof(bytes), &read, nullptr) &&
        (std::string(bytes, read) == "race-worker-1" || std::string(bytes, read) == "race-worker-2");
    if (winner != INVALID_HANDLE_VALUE) CloseHandle(winner);
    const bool stagesGone = GetFileAttributesW(stage1) == INVALID_FILE_ATTRIBUTES &&
        GetFileAttributesW(stage2) == INVALID_FILE_ATTRIBUTES;
    printf("publish-same-name-race=%s exits=%lu,%lu exactly-one-winner=%s target-content-valid=%s stages-gone=%s\\n",
        completed && oneWinner && contentValid && stagesGone ? "PASS" : "FAIL",
        static_cast<unsigned long>(exits[0]), static_cast<unsigned long>(exits[1]),
        oneWinner ? "yes" : "no", contentValid ? "yes" : "no", stagesGone ? "yes" : "no");
    DeleteFileW(target); DeleteFileW(stage1); DeleteFileW(stage2);
    return completed && oneWinner && contentValid && stagesGone;
}

static bool runOrderedPublishDeleteProbe(const std::wstring& root) {
    NativeContext context;
    if (!context.openRoot(root)) return false;
    auto seed = [&](const wchar_t* name, const char* payload) {
        wchar_t full[MAX_PATH]{};
        swprintf_s(full, L"%s\\%s", root.c_str(), name);
        HANDLE h = CreateFileW(full, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) return false;
        DWORD n = 0;
        const bool ok = WriteFile(h, payload, static_cast<DWORD>(strlen(payload)), &n, nullptr) &&
            n == strlen(payload) && FlushFileBuffers(h);
        CloseHandle(h);
        return ok;
    };
    auto createStage = [&](const wchar_t* name, HANDLE& h, FileIdentity& id) {
        wchar_t full[MAX_PATH]{};
        swprintf_s(full, L"%s\\%s", root.c_str(), name);
        h = CreateFileW(full, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL, nullptr);
        const char payload[] = "ordered-publication";
        DWORD n = 0;
        return h != INVALID_HANDLE_VALUE &&
            WriteFile(h, payload, sizeof(payload) - 1, &n, nullptr) && n == sizeof(payload) - 1 &&
            FlushFileBuffers(h) && identityOf(h, id);
    };
    bool publishFirst = seed(L"ordered-publish-first.target", "original");
    HANDLE stageA = INVALID_HANDLE_VALUE, targetA = INVALID_HANDLE_VALUE;
    FileIdentity stageAId{}, targetAId{};
    publishFirst = publishFirst && createStage(L"ordered-publish-first.stage", stageA, stageAId) &&
        context.openChildForDelete(L"ordered-publish-first.target", targetA, targetAId);
    const bool publishCollision = publishFirst &&
        !context.publishNoReplace(stageA, L"ordered-publish-first.target", stageAId) &&
        context.lastImmediateStatus() == static_cast<NTSTATUS>(0xC0000035) &&
        !context.lastPublishMayHaveCompleted();
    const bool deleteAfterCollision = publishCollision && context.unlinkOwned(targetA, targetAId) &&
        !context.lastUnlinkMayHaveCompleted();
    if (targetA != INVALID_HANDLE_VALUE) CloseHandle(targetA);
    const bool cleanupStageA = stageA != INVALID_HANDLE_VALUE &&
        context.unlinkOwned(stageA, stageAId);
    if (stageA != INVALID_HANDLE_VALUE) CloseHandle(stageA);
    const bool firstAbsent = GetFileAttributesW((root + L"\\ordered-publish-first.target").c_str()) == INVALID_FILE_ATTRIBUTES &&
        GetLastError() == ERROR_FILE_NOT_FOUND;

    bool deleteFirst = seed(L"ordered-delete-first.target", "original");
    HANDLE stageB = INVALID_HANDLE_VALUE, targetB = INVALID_HANDLE_VALUE;
    FileIdentity stageBId{}, targetBId{};
    deleteFirst = deleteFirst && createStage(L"ordered-delete-first.stage", stageB, stageBId) &&
        context.openChildForDelete(L"ordered-delete-first.target", targetB, targetBId);
    const bool deleteBeforePublish = deleteFirst && context.unlinkOwned(targetB, targetBId) &&
        !context.lastUnlinkMayHaveCompleted();
    if (targetB != INVALID_HANDLE_VALUE) { CloseHandle(targetB); targetB = INVALID_HANDLE_VALUE; }
    const bool publishAfterDelete = deleteBeforePublish &&
        context.publishNoReplace(stageB, L"ordered-delete-first.target", stageBId) &&
        context.lastImmediateStatus() == 0 && context.lastIosbStatus() == 0 &&
        !context.lastPublishMayHaveCompleted();
    if (stageB != INVALID_HANDLE_VALUE) CloseHandle(stageB);
    HANDLE finalB = CreateFileW((root + L"\\ordered-delete-first.target").c_str(),
        GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    bool secondValid = false;
    if (finalB != INVALID_HANDLE_VALUE) {
        char bytes[64]{}; DWORD n = 0;
        FileIdentity finalId{};
        secondValid = ReadFile(finalB, bytes, sizeof(bytes), &n, nullptr) &&
            std::string(bytes, n) == "ordered-publication" &&
            identityOf(finalB, finalId) && sameIdentity(finalId, stageBId);
        CloseHandle(finalB);
    }
    printf("ordered-publish-then-delete=%s collision=%s delete=%s final-absent=%s\\n",
        publishCollision && deleteAfterCollision && cleanupStageA && firstAbsent ? "PASS" : "FAIL",
        publishCollision ? "yes" : "no", deleteAfterCollision ? "yes" : "no", firstAbsent ? "yes" : "no");
    printf("ordered-delete-then-publish=%s delete=%s publish=%s identity-and-content=%s\\n",
        deleteBeforePublish && publishAfterDelete && secondValid ? "PASS" : "FAIL",
        deleteBeforePublish ? "yes" : "no", publishAfterDelete ? "yes" : "no", secondValid ? "yes" : "no");
    context.close();
    DeleteFileW((root + L"\\ordered-publish-first.target").c_str());
    DeleteFileW((root + L"\\ordered-publish-first.stage").c_str());
    DeleteFileW((root + L"\\ordered-delete-first.target").c_str());
    DeleteFileW((root + L"\\ordered-delete-first.stage").c_str());
    return publishCollision && deleteAfterCollision && cleanupStageA && firstAbsent &&
        deleteBeforePublish && publishAfterDelete && secondValid;
}

static bool runPublishDeleteRaceProbe(const std::wstring& root) {
    wchar_t target[MAX_PATH]{}, stage[MAX_PATH]{}, eventName[128]{}, executable[MAX_PATH]{};
    swprintf_s(target, L"%s\\publish-delete-target.bin", root.c_str());
    swprintf_s(stage, L"%s\\publish-delete.stage", root.c_str());
    swprintf_s(eventName, L"Local\\RayaPublishDelete-%lu", GetCurrentProcessId());
    HANDLE seed = CreateFileW(target, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const char original[] = "pre-existing-target";
    DWORD written = 0;
    const bool seeded = seed != INVALID_HANDLE_VALUE &&
        WriteFile(seed, original, sizeof(original) - 1, &written, nullptr) &&
        written == sizeof(original) - 1 && FlushFileBuffers(seed);
    if (seed != INVALID_HANDLE_VALUE) CloseHandle(seed);
    if (!seeded) return false;
    HANDLE gate = CreateEventW(nullptr, TRUE, FALSE, eventName);
    if (!gate || !GetModuleFileNameW(nullptr, executable, MAX_PATH)) {
        if (gate) CloseHandle(gate);
        DeleteFileW(target);
        return false;
    }
    PROCESS_INFORMATION processes[2]{};
    bool launched[2]{};
    const wchar_t* roles[2] = { L"publish", L"delete" };
    for (unsigned int i = 0; i < 2; ++i) {
        wchar_t command[2048]{};
        swprintf_s(command, L"\"%s\" --publish-delete-worker \"%s\" %s \"%s\"",
            executable, root.c_str(), roles[i], eventName);
        STARTUPINFOW startup{}; startup.cb = sizeof(startup);
        launched[i] = CreateProcessW(nullptr, command, nullptr, nullptr, FALSE, 0, nullptr, nullptr,
            &startup, &processes[i]) != FALSE;
        if (!launched[i]) break;
    }
    bool completed = launched[0] && launched[1];
    if (completed) SetEvent(gate);
    DWORD exits[2]{};
    for (unsigned int i = 0; i < 2; ++i) {
        if (launched[i]) {
            if (WaitForSingleObject(processes[i].hProcess, 15000) != WAIT_OBJECT_0 ||
                !GetExitCodeProcess(processes[i].hProcess, &exits[i])) completed = false;
            CloseHandle(processes[i].hThread);
            CloseHandle(processes[i].hProcess);
        }
    }
    CloseHandle(gate);
    const bool workersOk = exits[1] == 0 && (exits[0] == 0 || exits[0] == 20);
    HANDLE final = CreateFileW(target, GENERIC_READ | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    bool finalValid = false;
    bool finalAbsent = final == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND;
    if (final != INVALID_HANDLE_VALUE) {
        char bytes[64]{};
        DWORD count = 0;
        finalValid = ReadFile(final, bytes, sizeof(bytes), &count, nullptr) &&
            std::string(bytes, count) == "publish-delete-race";
        CloseHandle(final);
    }
    const bool outcomeConsistent = (exits[0] == 0 && finalValid) ||
        (exits[0] == 20 && finalAbsent);
    const bool stageGone = GetFileAttributesW(stage) == INVALID_FILE_ATTRIBUTES &&
        GetLastError() == ERROR_FILE_NOT_FOUND;
    printf("publish-vs-delete-race=%s publisher-exit=%lu deleter-exit=%lu final-published=%s final-absent=%s stage-gone=%s\\n",
        completed && workersOk && outcomeConsistent && stageGone ? "PASS" : "FAIL",
        static_cast<unsigned long>(exits[0]), static_cast<unsigned long>(exits[1]),
        finalValid ? "yes" : "no", finalAbsent ? "yes" : "no", stageGone ? "yes" : "no");
    DeleteFileW(target);
    DeleteFileW(stage);
    return completed && workersOk && outcomeConsistent && stageGone;
}

int wmain(int argc, wchar_t** argv) {
    if (argc == 5 && wcscmp(argv[1], L"--publish-delete-worker") == 0)
        return runPublishDeleteWorker(argv[2], wcscmp(argv[3], L"publish") == 0, argv[4]);
    if (argc == 5 && wcscmp(argv[1], L"--publish-race-worker") == 0)
        return runPublishRaceWorker(argv[2], static_cast<unsigned int>(_wtoi(argv[3])), argv[4]);
    if (argc == 3 && wcscmp(argv[1], L"--native-delete-observer-worker") == 0) {
        return runNativeDeleteWithObserverWorker(argv[2]);
    }
    if (argc == 3 && wcscmp(argv[1], L"--native-unlink-swap-worker") == 0) {
        return runNativeUnlinkSwapWorker(argv[2]);
    }
    if (argc == 4 && wcscmp(argv[1], L"--native-crash-worker") == 0) {
        return runNativeCrashWorker(argv[2], argv[3]);
    }
    if (argc == 5 && wcscmp(argv[1], L"--native-worker") == 0) {
        return runNativeMultiProcessWorker(argv[2],
            static_cast<unsigned int>(_wtoi(argv[3])),
            static_cast<unsigned int>(_wtoi(argv[4])));
    }
    wchar_t temp[MAX_PATH]{};
    wchar_t root[MAX_PATH]{};
    wchar_t file[MAX_PATH]{};
    GetTempPathW(MAX_PATH, temp);
    swprintf_s(root, L"%sRayaNativeAdapter-%lu", temp, GetCurrentProcessId());
    swprintf_s(file, L"%s\\probe.bin", root);
    if (!CreateDirectoryW(root, nullptr)) return 2;
    const bool publishRaceSafe = runPublishRaceProbe(root);
    if (!publishRaceSafe) { RemoveDirectoryW(root); return 5; }
    const bool publishDeleteRaceSafe = runPublishDeleteRaceProbe(root);
    if (!publishDeleteRaceSafe) { RemoveDirectoryW(root); return 6; }
    const bool orderedPublishDeleteSafe = runOrderedPublishDeleteProbe(root);
    if (!orderedPublishDeleteSafe) { RemoveDirectoryW(root); return 7; }
    const bool nativeMultiProcessSafe = runNativeMultiProcessProbe(root, 4, 100);
    printf("native-multiprocess=%s workers=4 iterations-per-worker=100\\n", nativeMultiProcessSafe ? "PASS" : "FAIL");
    if (!nativeMultiProcessSafe) { RemoveDirectoryW(root); return 3; }
    const bool nativeCrashRecoverySafe = runNativeCrashRecoveryProbe(root);
    printf("native-crash-recovery=%s failpoints=4\\n", nativeCrashRecoverySafe ? "PASS" : "FAIL");
    if (!nativeCrashRecoverySafe) { RemoveDirectoryW(root); return 4; }
    const bool nativeUnlinkSwapSafe = runNativeUnlinkSwapProbe(root);
    if (!nativeUnlinkSwapSafe) { RemoveDirectoryW(root); return 5; }
    const bool nativeDeleteObserverSafe = runNativeDeleteWithObserverProbe(root);
    if (!nativeDeleteObserverSafe) { RemoveDirectoryW(root); return 6; }

    HANDLE created = CreateFileW(file, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (created == INVALID_HANDLE_VALUE) { RemoveDirectoryW(root); return 2; }
    const char payload[] = "handle-relative-open";
    DWORD written = 0;
    bool seeded = WriteFile(created, payload, sizeof(payload) - 1, &written, nullptr) &&
        written == sizeof(payload) - 1 && FlushFileBuffers(created);
    CloseHandle(created);
    if (!seeded) { DeleteFileW(file); RemoveDirectoryW(root); return 2; }

    NativeContext context;
    wchar_t directoryPath[MAX_PATH]{};
    swprintf_s(directoryPath, L"%s\\child-dir", root);
    bool directorySeeded = CreateDirectoryW(directoryPath, nullptr) != FALSE;
    if (!directorySeeded) { DeleteFileW(file); RemoveDirectoryW(root); return 2; }
    wchar_t symlinkPath[MAX_PATH]{};
    wchar_t externalTargetPath[MAX_PATH]{};
    swprintf_s(symlinkPath, L"%s\\probe-link.bin", root);
    swprintf_s(externalTargetPath, L"%sRayaNativeAdapter-target-%lu.bin", temp, GetCurrentProcessId());
    HANDLE externalTarget = CreateFileW(externalTargetPath, GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const char externalBytes[] = "outside-target";
    DWORD externalWritten = 0;
    bool externalTargetSeeded = externalTarget != INVALID_HANDLE_VALUE &&
        WriteFile(externalTarget, externalBytes, sizeof(externalBytes) - 1, &externalWritten, nullptr) &&
        externalWritten == sizeof(externalBytes) - 1 && FlushFileBuffers(externalTarget);
    if (externalTarget != INVALID_HANDLE_VALUE) CloseHandle(externalTarget);
    if (!externalTargetSeeded) { DeleteFileW(file); RemoveDirectoryW(directoryPath); RemoveDirectoryW(root); return 2; }
    bool symlinkSeeded = CreateSymbolicLinkW(symlinkPath, externalTargetPath, 0x2) != FALSE;
    if (!symlinkSeeded) symlinkSeeded = CreateSymbolicLinkW(symlinkPath, externalTargetPath, 0) != FALSE;
    DWORD symlinkError = symlinkSeeded ? ERROR_SUCCESS : GetLastError();
    HANDLE child = INVALID_HANDLE_VALUE;
    FileIdentity childId{};
    const bool malformedDirectoryRecordsRejected = directoryParserMalformedInputTests();
    printf("malformed-directory-records=%s\\n", malformedDirectoryRecordsRejected ? "PASS" : "FAIL");
    bool rootOpened = context.openRoot(root);
    std::wstring overlongName((USHRT_MAX / sizeof(WCHAR)) + 1, L'x');
    std::wstring embeddedNullName(L"bad"); embeddedNullName.push_back(L'\0'); embeddedNullName += L"tail";
    HANDLE invalidNameHandle = INVALID_HANDLE_VALUE;
    FileIdentity invalidNameIdentity{};
    const bool invalidNamesRejected =
        !context.openChildReadOnly(L"", invalidNameHandle, invalidNameIdentity) &&
        !context.openChildReadOnly(L".", invalidNameHandle, invalidNameIdentity) &&
        !context.openChildReadOnly(L"..", invalidNameHandle, invalidNameIdentity) &&
        !context.openChildReadOnly(L"sub\\component", invalidNameHandle, invalidNameIdentity) &&
        !context.openChildReadOnly(L"stream:name", invalidNameHandle, invalidNameIdentity) &&
        !context.openChildReadOnly(embeddedNullName, invalidNameHandle, invalidNameIdentity) &&
        !context.openChildReadOnly(overlongName, invalidNameHandle, invalidNameIdentity) &&
        !context.openChildForDelete(overlongName, invalidNameHandle, invalidNameIdentity) &&
        invalidNameHandle == INVALID_HANDLE_VALUE;
    printf("single-component-name-validation=%s (empty/dot/traversal/separator/ADS/NUL/USHORT-overflow)\\n",
        invalidNamesRejected ? "PASS" : "FAIL");
    const bool directoryFlushSucceeded = rootOpened && context.flushParentDirectoryForProbe();
    const DWORD directoryFlushError = context.lastDirectoryFlushError();
    const bool directoryFlushAmbiguous = context.lastDirectoryFlushMayHaveCompleted();
    printf("directory-handle-flush=%s win32-error=%lu possibly-completed=%s (experimental capability probe only)\\n",
        directoryFlushSucceeded ? "SUCCESS" : "UNSUPPORTED-OR-FAILED",
        static_cast<unsigned long>(directoryFlushError), directoryFlushAmbiguous ? "yes" : "no");
    bool concurrentEnumerationSafe = rootOpened && concurrentEnumerationProbe(context, root);
    bool childOpened = rootOpened && context.openChildReadOnly(L"probe.bin", child, childId);
    bool parentStable = context.sameParent();
    std::vector<DirectoryEntry> enumeratedNames;
    bool enumerated = rootOpened && context.enumerateChildren(8, enumeratedNames);
    bool sawProbe = false, sawDirectory = false, sawSymlink = false;
    const DirectoryEntry* symlinkRecord = nullptr;
    for (const auto& entry : enumeratedNames) {
        if (entry.name == L"probe.bin") sawProbe = true;
        if (entry.name == L"child-dir") sawDirectory = true;
        if (entry.name == L"probe-link.bin") { sawSymlink = true; symlinkRecord = &entry; }
    }
    bool enumerationVerified = enumerated &&
        enumeratedNames.size() == (symlinkSeeded ? 3u : 2u) &&
        sawProbe && sawDirectory && (sawSymlink == symlinkSeeded);
    bool symlinkNoFollow = !symlinkSeeded;
    bool symlinkTokenRejected = !symlinkSeeded;
    if (symlinkSeeded && symlinkRecord) {
        HANDLE symlinkHandle = INVALID_HANDLE_VALUE;
        FileIdentity symlinkIdentity{};
        symlinkNoFollow = !context.openChildReadOnly(L"probe-link.bin", symlinkHandle, symlinkIdentity) &&
            symlinkHandle == INVALID_HANDLE_VALUE;
        HANDLE tokenHandle = INVALID_HANDLE_VALUE;
        FileIdentity tokenIdentity{};
        symlinkTokenRejected = (symlinkRecord->attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 &&
            !context.openEnumeratedChildReadOnly(*symlinkRecord, tokenHandle, tokenIdentity) &&
            tokenHandle == INVALID_HANDLE_VALUE;
    }
    HANDLE enumeratedChild = INVALID_HANDLE_VALUE;
    FileIdentity enumeratedChildId{};
    auto probeRecord = std::find_if(enumeratedNames.begin(), enumeratedNames.end(), [](const DirectoryEntry& entry) { return entry.name == L"probe.bin"; });
    bool enumeratedIdentityBound = probeRecord != enumeratedNames.end() && context.openEnumeratedChildReadOnly(*probeRecord, enumeratedChild, enumeratedChildId) && sameIdentity(enumeratedChildId, childId);
    DirectoryEntry wrongIdRecord = probeRecord != enumeratedNames.end() ? *probeRecord : DirectoryEntry{};
    wrongIdRecord.fileId[15] ^= 0x80;
    HANDLE wrongIdHandle = INVALID_HANDLE_VALUE;
    FileIdentity wrongIdIdentity{};
    bool fullIdMismatchRejected = probeRecord != enumeratedNames.end() && !context.openEnumeratedChildReadOnly(wrongIdRecord, wrongIdHandle, wrongIdIdentity) && wrongIdHandle == INVALID_HANDLE_VALUE;
    DirectoryEntry wrongVolumeRecord = probeRecord != enumeratedNames.end() ? *probeRecord : DirectoryEntry{};
    wrongVolumeRecord.volumeSerial ^= 1;
    HANDLE wrongVolumeHandle = INVALID_HANDLE_VALUE;
    FileIdentity wrongVolumeIdentity{};
    bool volumeMismatchRejected = probeRecord != enumeratedNames.end() && !context.openEnumeratedChildReadOnly(wrongVolumeRecord, wrongVolumeHandle, wrongVolumeIdentity) && wrongVolumeHandle == INVALID_HANDLE_VALUE;
    if (enumeratedChild != INVALID_HANDLE_VALUE) CloseHandle(enumeratedChild);
    wchar_t originalPath[MAX_PATH]{};
    swprintf_s(originalPath, L"%s\\probe-original.bin", root);
    bool enumeratedOriginalMoved = MoveFileExW(file, originalPath, MOVEFILE_WRITE_THROUGH) != FALSE;
    HANDLE decoy = INVALID_HANDLE_VALUE;
    const char decoyBytes[] = "substitute";
    DWORD decoyCount = 0;
    if (enumeratedOriginalMoved) decoy = CreateFileW(file, GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    bool decoyCreated = decoy != INVALID_HANDLE_VALUE &&
        WriteFile(decoy, decoyBytes, sizeof(decoyBytes) - 1, &decoyCount, nullptr) &&
        decoyCount == sizeof(decoyBytes) - 1 && FlushFileBuffers(decoy);
    if (decoy != INVALID_HANDLE_VALUE) CloseHandle(decoy);
    HANDLE rejectedSubstitute = INVALID_HANDLE_VALUE;
    FileIdentity rejectedIdentity{};
    bool enumeratedSubstitutionRejected = decoyCreated &&
        !context.openEnumeratedChildReadOnly(*probeRecord, rejectedSubstitute, rejectedIdentity) &&
        rejectedSubstitute == INVALID_HANDLE_VALUE;
    std::vector<DirectoryEntry> boundedNames;
    bool enumerationBoundEnforced = !context.enumerateChildren(1, boundedNames) && boundedNames.empty();
    HANDLE directoryEntry = INVALID_HANDLE_VALUE;
    FileIdentity directoryIdentity{};
    bool directoryRejected = rootOpened &&
        !context.openChildReadOnly(L"child-dir", directoryEntry, directoryIdentity);
    ULONGLONG contentBytes = 0;
    std::vector<BYTE> contentDigest;
    bool contentHashed = childOpened &&
        context.readAndHash(child, childId, 1024 * 1024, contentBytes, contentDigest);
    const BYTE expectedDigest[32] = {
        0xdf, 0x47, 0x97, 0xa0, 0xa7, 0xf3, 0xb2, 0xb1,
        0xe6, 0x8e, 0x64, 0x80, 0x96, 0x2a, 0x56, 0x54,
        0x9e, 0xfb, 0xc1, 0x37, 0x55, 0x6c, 0x3b, 0x83,
        0x39, 0x78, 0x32, 0x71, 0x8a, 0x32, 0xc4, 0x3e
    };
    bool contentVerified = contentHashed &&
        contentBytes == sizeof("handle-relative-open") - 1 &&
        contentDigest.size() == sizeof(expectedDigest) &&
        memcmp(contentDigest.data(), expectedDigest, sizeof(expectedDigest)) == 0;

    wchar_t stagePath[MAX_PATH]{};
    wchar_t targetPath[MAX_PATH]{};
    wchar_t collisionPath[MAX_PATH]{};
    swprintf_s(stagePath, L"%s\\stage.bin", root);
    swprintf_s(targetPath, L"%s\\published.bin", root);
    swprintf_s(collisionPath, L"%s\\collision.bin", root);

    HANDLE stage = CreateFileW(stagePath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    const char staged[] = "published-through-handle";
    DWORD stageWritten = 0;
    bool stageReady = stage != INVALID_HANDLE_VALUE &&
        WriteFile(stage, staged, sizeof(staged) - 1, &stageWritten, nullptr) &&
        stageWritten == sizeof(staged) - 1 && FlushFileBuffers(stage);
    FileIdentity stageId{};
    bool stageIdentity = stageReady && identityOf(stage, stageId);
    bool published = stageIdentity && context.publishNoReplace(stage, L"published.bin", stageId);
    const bool postPublishDirectoryFlush = published && context.flushParentDirectoryForProbe() &&
        !context.lastDirectoryFlushMayHaveCompleted();
    const DWORD postPublishDirectoryFlushError = context.lastDirectoryFlushError();
    printf("post-publish-directory-flush=%s win32-error=%lu possibly-completed=%s\\n",
        postPublishDirectoryFlush ? "PASS" : "FAIL", static_cast<unsigned long>(postPublishDirectoryFlushError),
        context.lastDirectoryFlushMayHaveCompleted() ? "yes" : "no");
    const NTSTATUS publishImmediate = context.lastImmediateStatus();
    const NTSTATUS publishIosb = context.lastIosbStatus();
    const bool publishIosbChanged = context.lastIosbChanged();
    if (stage != INVALID_HANDLE_VALUE) CloseHandle(stage);

    HANDLE collision = CreateFileW(collisionPath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    FileIdentity collisionId{};
    bool collisionReady = collision != INVALID_HANDLE_VALUE && identityOf(collision, collisionId);
    bool noReplace = collisionReady && !context.publishNoReplace(collision, L"published.bin", collisionId);
    const NTSTATUS collisionImmediate = context.lastImmediateStatus();
    const NTSTATUS collisionIosb = context.lastIosbStatus();
    const bool collisionIosbChanged = context.lastIosbChanged();
    const bool statusEvidence =
        publishImmediate == static_cast<NTSTATUS>(0) &&
        publishIosb == static_cast<NTSTATUS>(0) && publishIosbChanged &&
        collisionImmediate == static_cast<NTSTATUS>(0xC0000035) &&
        collisionIosb == static_cast<NTSTATUS>(0xCCCCCCCC) &&
        !collisionIosbChanged;
    wchar_t ambiguousStagePath[MAX_PATH]{};
    wchar_t ambiguousTargetPath[MAX_PATH]{};
    swprintf_s(ambiguousStagePath, L"%s\\ambiguous-stage.bin", root);
    swprintf_s(ambiguousTargetPath, L"%s\\ambiguous-published.bin", root);
    HANDLE ambiguousStage = CreateFileW(ambiguousStagePath, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const char ambiguousPublishPayload[] = "publish-postcondition-failpoint";
    DWORD ambiguousStageWritten = 0;
    const bool ambiguousStageReady = ambiguousStage != INVALID_HANDLE_VALUE &&
        WriteFile(ambiguousStage, ambiguousPublishPayload, sizeof(ambiguousPublishPayload) - 1, &ambiguousStageWritten, nullptr) &&
        ambiguousStageWritten == sizeof(ambiguousPublishPayload) - 1 && FlushFileBuffers(ambiguousStage);
    FileIdentity ambiguousStageId{};
    const bool ambiguousStageIdentified = ambiguousStageReady && identityOf(ambiguousStage, ambiguousStageId);
    context.injectPostPublishParentFailureForProbe(true);
    const bool ambiguousPublishReturnedFailure = ambiguousStageIdentified &&
        !context.publishNoReplace(ambiguousStage, L"ambiguous-published.bin", ambiguousStageId);
    const bool ambiguousPublishFlag = context.lastPublishMayHaveCompleted();
    const NTSTATUS ambiguousPublishStatus = context.lastImmediateStatus();
    const bool ambiguousStageNameGone = GetFileAttributesW(ambiguousStagePath) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND;
    HANDLE ambiguousTarget = CreateFileW(ambiguousTargetPath, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    FileIdentity ambiguousTargetId{};
    const bool ambiguousTargetIdentityMatches = ambiguousTarget != INVALID_HANDLE_VALUE &&
        identityOf(ambiguousTarget, ambiguousTargetId) && sameIdentity(ambiguousTargetId, ambiguousStageId);
    if (ambiguousTarget != INVALID_HANDLE_VALUE) CloseHandle(ambiguousTarget);
    context.injectPostPublishParentFailureForProbe(false);
    if (ambiguousStage != INVALID_HANDLE_VALUE) CloseHandle(ambiguousStage);
    const bool ambiguousPublishedBytesPresent = GetFileAttributesW(ambiguousTargetPath) != INVALID_FILE_ATTRIBUTES;
    if (collision != INVALID_HANDLE_VALUE) CloseHandle(collision);
    DeleteFileW(collisionPath);
    DeleteFileW(symlinkPath);
    DeleteFileW(externalTargetPath);

    HANDLE owned = CreateFileW(targetPath, DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    FileIdentity ownedId{};
    bool ownedOpened = owned != INVALID_HANDLE_VALUE && identityOf(owned, ownedId);
    FileIdentity wrongOwnedId = ownedId;
    wrongOwnedId.fileId[15] ^= 0x40;
    bool wrongIdentityRefused = ownedOpened && !context.unlinkOwned(owned, wrongOwnedId);
    const DWORD wrongIdentityError = context.lastOperationError();
    const bool wrongIdentityNotPossiblyCompleted = !context.lastUnlinkMayHaveCompleted();
    HANDLE readOnlyDeleteAttempt = CreateFileW(targetPath, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    const bool readOnlyDeleteRefused = readOnlyDeleteAttempt != INVALID_HANDLE_VALUE &&
        !context.unlinkOwned(readOnlyDeleteAttempt, ownedId);
    const DWORD readOnlyDeleteError = context.lastOperationError();
    const bool readOnlyDeletePossiblyCompleted = context.lastUnlinkMayHaveCompleted();
    if (readOnlyDeleteAttempt != INVALID_HANDLE_VALUE) CloseHandle(readOnlyDeleteAttempt);
    bool targetPreservedAfterWrongIdentity = GetFileAttributesW(targetPath) != INVALID_FILE_ATTRIBUTES;
    HANDLE observer = CreateFileW(targetPath, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    FileIdentity observerId{};
    bool observerOpened = observer != INVALID_HANDLE_VALUE && identityOf(observer, observerId) &&
        sameIdentity(observerId, ownedId);
    bool unlinked = ownedOpened && observerOpened && wrongIdentityRefused && targetPreservedAfterWrongIdentity &&
        context.unlinkOwned(owned, ownedId);
    const bool postUnlinkDirectoryFlush = unlinked && context.flushParentDirectoryForProbe() &&
        !context.lastDirectoryFlushMayHaveCompleted();
    const DWORD postUnlinkDirectoryFlushError = context.lastDirectoryFlushError();
    printf("post-unlink-directory-flush=%s win32-error=%lu possibly-completed=%s\\n",
        postUnlinkDirectoryFlush ? "PASS" : "FAIL", static_cast<unsigned long>(postUnlinkDirectoryFlushError),
        context.lastDirectoryFlushMayHaveCompleted() ? "yes" : "no");
    if (owned != INVALID_HANDLE_VALUE) CloseHandle(owned);
    FileIdentity observerAfterDisposition{};
    bool observerSurvivedDisposition = observer != INVALID_HANDLE_VALUE &&
        identityOf(observer, observerAfterDisposition) && sameIdentity(observerAfterDisposition, ownedId);
    if (observer != INVALID_HANDLE_VALUE) CloseHandle(observer);
    bool targetGone = GetFileAttributesW(targetPath) == INVALID_FILE_ATTRIBUTES &&
        GetLastError() == ERROR_FILE_NOT_FOUND;
    const std::wstring ambiguousPath = std::wstring(root) + L"\\ambiguous-unlink.bin";
    HANDLE ambiguousSeed = CreateFileW(ambiguousPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const char ambiguousPayload[] = "post-disposition-failpoint";
    DWORD ambiguousWritten = 0;
    const bool ambiguousSeeded = ambiguousSeed != INVALID_HANDLE_VALUE &&
        WriteFile(ambiguousSeed, ambiguousPayload, sizeof(ambiguousPayload) - 1, &ambiguousWritten, nullptr) &&
        ambiguousWritten == sizeof(ambiguousPayload) - 1 && FlushFileBuffers(ambiguousSeed);
    if (ambiguousSeed != INVALID_HANDLE_VALUE) CloseHandle(ambiguousSeed);
    HANDLE ambiguousHandle = ambiguousSeeded ? CreateFileW(ambiguousPath.c_str(), DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) : INVALID_HANDLE_VALUE;
    FileIdentity ambiguousId{};
    const bool ambiguousOpened = ambiguousHandle != INVALID_HANDLE_VALUE && identityOf(ambiguousHandle, ambiguousId);
    context.injectPostDispositionParentFailureForProbe(true);
    const bool ambiguousReturnedFailure = ambiguousOpened && !context.unlinkOwned(ambiguousHandle, ambiguousId);
    const DWORD ambiguousError = context.lastOperationError();
    const bool ambiguousFlag = context.lastUnlinkMayHaveCompleted();
    HANDLE ambiguousPathReopen = CreateFileW(ambiguousPath.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    const DWORD ambiguousReopenError = ambiguousPathReopen == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    const bool ambiguousReopenBlocked = ambiguousPathReopen == INVALID_HANDLE_VALUE;
    if (ambiguousPathReopen != INVALID_HANDLE_VALUE) CloseHandle(ambiguousPathReopen);
    context.injectPostDispositionParentFailureForProbe(false);
    if (ambiguousHandle != INVALID_HANDLE_VALUE) CloseHandle(ambiguousHandle);
    const bool ambiguousNameAbsentAfterClose = GetFileAttributesW(ambiguousPath.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND;
    const std::wstring syntheticPath = std::wstring(root) + L"\\synthetic-uncertain-unlink.bin";
    HANDLE syntheticSeed = CreateFileW(syntheticPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const bool syntheticSeeded = syntheticSeed != INVALID_HANDLE_VALUE;
    if (syntheticSeed != INVALID_HANDLE_VALUE) CloseHandle(syntheticSeed);
    HANDLE syntheticHandle = syntheticSeeded ? CreateFileW(syntheticPath.c_str(), DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) : INVALID_HANDLE_VALUE;
    FileIdentity syntheticId{};
    const bool syntheticOpened = syntheticHandle != INVALID_HANDLE_VALUE && identityOf(syntheticHandle, syntheticId);
    context.injectDispositionCallFailureForProbe(true);
    const bool syntheticReturnedFailure = syntheticOpened && !context.unlinkOwned(syntheticHandle, syntheticId);
    const DWORD syntheticError = context.lastOperationError();
    const bool syntheticPossiblyCompleted = context.lastUnlinkMayHaveCompleted();
    context.injectDispositionCallFailureForProbe(false);
    const bool syntheticTargetPreserved = GetFileAttributesW(syntheticPath.c_str()) != INVALID_FILE_ATTRIBUTES;
    if (syntheticHandle != INVALID_HANDLE_VALUE) CloseHandle(syntheticHandle);
    DeleteFileW(syntheticPath.c_str());
    const std::wstring flushPath = std::wstring(root) + L"\\flush-close-boundary.bin";
    HANDLE flushHandle = CreateFileW(flushPath.c_str(), GENERIC_WRITE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const char flushPayload[] = "flush-close-evidence";
    DWORD flushWritten = 0;
    const bool flushSeeded = flushHandle != INVALID_HANDLE_VALUE &&
        WriteFile(flushHandle, flushPayload, sizeof(flushPayload) - 1, &flushWritten, nullptr) &&
        flushWritten == sizeof(flushPayload) - 1;
    FileIdentity flushIdentity{};
    const bool flushIdentified = flushSeeded && identityOf(flushHandle, flushIdentity);
    context.injectFlushCallFailureForProbe(true);
    const bool flushCallFailureReturned = flushIdentified && !context.flushFile(flushHandle, flushIdentity);
    const bool flushCallFailureAmbiguous = context.lastFlushMayHaveCompleted() &&
        context.lastOperationError() == ERROR_GEN_FAILURE;
    context.injectFlushCallFailureForProbe(false);
    context.injectPostFlushFailureForProbe(true);
    const bool flushPostFailureReturned = flushIdentified && !context.flushFile(flushHandle, flushIdentity);
    const bool flushPostFailureAmbiguous = context.lastFlushMayHaveCompleted() &&
        context.lastOperationError() == ERROR_INVALID_HANDLE;
    context.injectPostFlushFailureForProbe(false);
    const bool flushSucceeded = flushIdentified && context.flushFile(flushHandle, flushIdentity) &&
        !context.lastFlushMayHaveCompleted();
    context.injectCloseFailureForProbe(true);
    const bool closeFailureReturned = !context.closeOwned(flushHandle);
    const bool closeFailureAmbiguous = context.lastCloseMayHaveCompleted() &&
        context.lastCloseError() == ERROR_GEN_FAILURE && flushHandle != INVALID_HANDLE_VALUE;
    context.injectCloseFailureForProbe(false);
    const bool closeSucceeded = context.closeOwned(flushHandle) &&
        !context.lastCloseMayHaveCompleted() && flushHandle == INVALID_HANDLE_VALUE;
    const bool flushFixturePresent = GetFileAttributesW(flushPath.c_str()) != INVALID_FILE_ATTRIBUTES;
    DeleteFileW(flushPath.c_str());
    printf("flush-close-boundaries=%s call-failure-ambiguous=%s post-flush-ambiguous=%s flush-success=%s close-failure-ambiguous=%s close-success=%s fixture-preserved=%s\n",
        flushSeeded && flushIdentified && flushCallFailureReturned && flushCallFailureAmbiguous &&
        flushPostFailureReturned && flushPostFailureAmbiguous && flushSucceeded &&
        closeFailureReturned && closeFailureAmbiguous && closeSucceeded && flushFixturePresent ? "PASS" : "FAIL",
        flushCallFailureAmbiguous ? "yes" : "no", flushPostFailureAmbiguous ? "yes" : "no",
        flushSucceeded ? "yes" : "no", closeFailureAmbiguous ? "yes" : "no",
        closeSucceeded ? "yes" : "no", flushFixturePresent ? "yes" : "no");    printf("unlink-synthetic-uncertain-result=%s error=%lu possibly-completed=%s target-preserved=%s (no OS disposition call issued)\n",
        syntheticReturnedFailure && syntheticError == ERROR_GEN_FAILURE && syntheticPossiblyCompleted && syntheticTargetPreserved ? "PASS" : "FAIL",
        static_cast<unsigned long>(syntheticError), syntheticPossiblyCompleted ? "yes" : "no",
        syntheticTargetPreserved ? "yes" : "no");    printf("root-open=%s concurrent-enumeration=%s enumerate=%s enumeration-bound=%s enumerated-identity=%s full-id-mismatch-rejected=%s volume-mismatch-rejected=%s enumeration-substitution-rejected=%s directory-rejected=%s symlink-fixture=%s symlink-error=%lu symlink-no-follow=%s symlink-token-rejected=%s child-relative-open=%s parent-identity-stable=%s read-hash=%s bytes=%llu publish-no-replace=%s collision-preserved=%s unlink-owned=%s target-absent=%s\\n",
        rootOpened ? "PASS" : "FAIL", concurrentEnumerationSafe ? "PASS" : "FAIL", enumerated ? "PASS" : "FAIL", enumerationBoundEnforced ? "PASS" : "FAIL",
        enumeratedIdentityBound ? "PASS" : "FAIL", fullIdMismatchRejected ? "PASS" : "FAIL", volumeMismatchRejected ? "PASS" : "FAIL", enumeratedSubstitutionRejected ? "PASS" : "FAIL", directoryRejected ? "PASS" : "FAIL", symlinkSeeded ? "CREATED" : "SKIP", static_cast<unsigned long>(symlinkError), symlinkNoFollow ? "PASS" : "FAIL", symlinkTokenRejected ? "PASS" : "FAIL", childOpened ? "PASS" : "FAIL",
        parentStable ? "PASS" : "FAIL", contentVerified ? "PASS" : "FAIL",
        static_cast<unsigned long long>(contentBytes), published ? "PASS" : "FAIL",
        noReplace ? "PASS" : "FAIL", unlinked ? "PASS" : "FAIL",
        targetGone ? "PASS" : "FAIL");
    printf("publish-postcondition-failpoint=%s status=0x%08lX possibly-completed=%s stage-name-gone=%s target-identity-matches=%s target-present=%s\\n",
        ambiguousPublishReturnedFailure && ambiguousPublishFlag && ambiguousPublishStatus == static_cast<NTSTATUS>(0) ? "PASS" : "FAIL",
        static_cast<unsigned long>(ambiguousPublishStatus), ambiguousPublishFlag ? "yes" : "no",
        ambiguousStageNameGone ? "yes" : "no", ambiguousTargetIdentityMatches ? "yes" : "no",
        ambiguousPublishedBytesPresent ? "yes" : "no");
    printf("unlink-post-disposition-failpoint=%s error=%lu possibly-completed=%s reopen-blocked=%s reopen-error=%lu name-absent-after-close=%s\\n",
        ambiguousReturnedFailure && ambiguousError == ERROR_INVALID_HANDLE && ambiguousFlag ? "PASS" : "FAIL",
        static_cast<unsigned long>(ambiguousError), ambiguousFlag ? "yes" : "no",
        ambiguousReopenBlocked ? "blocked" : "unexpected-open", static_cast<unsigned long>(ambiguousReopenError),
        ambiguousNameAbsentAfterClose ? "yes" : "no");
    printf("unlink-observer-open=%s observer-survives-disposition=%s final-name-absent-after-all-close=%s\n",
        observerOpened ? "PASS" : "FAIL",
        observerSurvivedDisposition ? "PASS" : "FAIL",
        targetGone ? "PASS" : "FAIL");
    printf("unlink-readonly-refused=%s win32-error=%lu possibly-completed=%s\\n",
        readOnlyDeleteRefused ? "PASS" : "FAIL", static_cast<unsigned long>(readOnlyDeleteError),
        readOnlyDeletePossiblyCompleted ? "yes" : "no");
    printf("unlink-wrong-identity-refused=%s target-preserved=%s\n",
        wrongIdentityRefused ? "PASS" : "FAIL",
        targetPreservedAfterWrongIdentity ? "PASS" : "FAIL");
    printf("publish-status=0x%08lX publish-iosb=0x%08lX publish-iosb-changed=%s collision-status=0x%08lX collision-iosb=0x%08lX collision-iosb-changed=%s\n", static_cast<unsigned long>(publishImmediate), static_cast<unsigned long>(publishIosb), publishIosbChanged ? "yes" : "no", static_cast<unsigned long>(collisionImmediate), static_cast<unsigned long>(collisionIosb), collisionIosbChanged ? "yes" : "no");
    if (child != INVALID_HANDLE_VALUE) CloseHandle(child);
    context.close();
    DeleteFileW(stagePath);
    DeleteFileW(targetPath);
    DeleteFileW(collisionPath);
    DeleteFileW(symlinkPath);
    DeleteFileW(externalTargetPath);
    DeleteFileW(ambiguousPath.c_str());
    DeleteFileW(ambiguousStagePath);
    DeleteFileW(ambiguousTargetPath);
    DeleteFileW(file);
    DeleteFileW(originalPath);
    RemoveDirectoryW(directoryPath);
    RemoveDirectoryW(root);
    return rootOpened && invalidNamesRejected && malformedDirectoryRecordsRejected && concurrentEnumerationSafe && enumerationVerified && enumerationBoundEnforced && fullIdMismatchRejected && volumeMismatchRejected &&
        directoryRejected && symlinkNoFollow && symlinkTokenRejected && childOpened &&
        parentStable && contentVerified && enumeratedIdentityBound && enumeratedSubstitutionRejected && published &&
        noReplace && statusEvidence && wrongIdentityRefused && wrongIdentityError == ERROR_INVALID_DATA && wrongIdentityNotPossiblyCompleted &&
        readOnlyDeleteRefused && readOnlyDeleteError == ERROR_ACCESS_DENIED && readOnlyDeletePossiblyCompleted &&
        targetPreservedAfterWrongIdentity && observerOpened && observerSurvivedDisposition && unlinked && postUnlinkDirectoryFlush && targetGone &&
        syntheticSeeded && syntheticOpened && syntheticReturnedFailure && syntheticError == ERROR_GEN_FAILURE && syntheticPossiblyCompleted && syntheticTargetPreserved &&
        postPublishDirectoryFlush && flushSeeded && flushIdentified && flushCallFailureReturned && flushCallFailureAmbiguous &&
        flushPostFailureReturned && flushPostFailureAmbiguous && flushSucceeded &&
        closeFailureReturned && closeFailureAmbiguous && closeSucceeded && flushFixturePresent &&
        ambiguousSeeded && ambiguousOpened && ambiguousReturnedFailure && ambiguousError == ERROR_INVALID_HANDLE &&
        ambiguousReopenBlocked && ambiguousNameAbsentAfterClose &&
        ambiguousStageReady && ambiguousStageIdentified && ambiguousPublishReturnedFailure && ambiguousPublishFlag &&
        ambiguousPublishStatus == static_cast<NTSTATUS>(0) && ambiguousStageNameGone && ambiguousTargetIdentityMatches && ambiguousPublishedBytesPresent ? 0 : 1;
}
