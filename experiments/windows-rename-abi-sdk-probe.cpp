#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <stddef.h>
#include <stdio.h>
#include <type_traits>

#ifndef FILE_RENAME_FLAG_REPLACE_IF_EXISTS
#error Windows SDK does not expose FILE_RENAME_FLAG_REPLACE_IF_EXISTS for selected target
#endif

struct PrototypeRenameInfo {
    BOOLEAN ReplaceIfExists;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
};

static_assert(std::is_standard_layout<FILE_RENAME_INFO>::value, "SDK FILE_RENAME_INFO must be standard layout");
static_assert(sizeof(FILE_RENAME_INFO) == sizeof(PrototypeRenameInfo), "rename structure size mismatch");
static_assert(offsetof(FILE_RENAME_INFO, RootDirectory) == offsetof(PrototypeRenameInfo, RootDirectory), "RootDirectory offset mismatch");
static_assert(offsetof(FILE_RENAME_INFO, FileNameLength) == offsetof(PrototypeRenameInfo, FileNameLength), "FileNameLength offset mismatch");
static_assert(offsetof(FILE_RENAME_INFO, FileName) == offsetof(PrototypeRenameInfo, FileName), "FileName offset mismatch");
static_assert(FILE_RENAME_FLAG_REPLACE_IF_EXISTS == 0x1, "unexpected replace flag");
static_assert(FILE_RENAME_FLAG_POSIX_SEMANTICS == 0x2, "unexpected POSIX flag");
static_assert(sizeof(IO_STATUS_BLOCK) == (sizeof(void*) == 8 ? 16 : 8), "unexpected IO_STATUS_BLOCK size");
static_assert(offsetof(IO_STATUS_BLOCK, Information) == sizeof(void*), "unexpected IO_STATUS_BLOCK Information offset");

int wmain() {
    wprintf(L"arch=%ls\n", sizeof(void*) == 8 ? L"x64" : L"x86");
    wprintf(L"sdk_FILE_RENAME_INFO_size=%zu prototype_size=%zu\n", sizeof(FILE_RENAME_INFO), sizeof(PrototypeRenameInfo));
    wprintf(L"RootDirectory_offset=%zu FileNameLength_offset=%zu FileName_offset=%zu\n",
        offsetof(FILE_RENAME_INFO, RootDirectory),
        offsetof(FILE_RENAME_INFO, FileNameLength),
        offsetof(FILE_RENAME_INFO, FileName));
    wprintf(L"IO_STATUS_BLOCK_size=%zu Information_offset=%zu\n",
        sizeof(IO_STATUS_BLOCK), offsetof(IO_STATUS_BLOCK, Information));
    wprintf(L"replace_flag=0x%08lX posix_flag=0x%08lX\n",
        static_cast<ULONG>(FILE_RENAME_FLAG_REPLACE_IF_EXISTS),
        static_cast<ULONG>(FILE_RENAME_FLAG_POSIX_SEMANTICS));
    wprintf(L"PASS: prototype layout matches installed Windows SDK declarations\n");
    return 0;
}
