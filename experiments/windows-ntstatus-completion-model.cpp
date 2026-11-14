#include <cstdint>
#include <iostream>
#include <string>

using NtStatus = std::uint32_t;

constexpr NtStatus STATUS_SUCCESS = 0x00000000u;
constexpr NtStatus STATUS_PENDING = 0x00000103u;
constexpr NtStatus STATUS_OBJECT_NAME_COLLISION = 0xC0000035u;
constexpr NtStatus STATUS_ACCESS_DENIED = 0xC0000022u;
constexpr NtStatus STATUS_CANCELLED = 0xC0000120u;
constexpr NtStatus STATUS_IO_TIMEOUT = 0xC00000B5u;
constexpr NtStatus STATUS_UNTOUCHED = 0xCCCCCCCCu;

enum class Classification { Success, Conflict, NotPerformed, PossiblyCompleted, Ambiguous };

struct NativeCompletionRecord {
    NtStatus syscallStatus;
    NtStatus iosbStatus;
    std::uintptr_t information;
    bool completionObserved;
};

struct Decision {
    Classification classification;
    bool retryAllowed;
    const char* reason;
};

static bool ntSuccess(NtStatus status) {
    return static_cast<std::int32_t>(status) >= 0;
}

static Decision classify(const NativeCompletionRecord& r) {
    if (r.syscallStatus == STATUS_PENDING) {
        if (!r.completionObserved) {
            return {Classification::PossiblyCompleted, false, "pending without observed completion"};
        }
        if (r.iosbStatus == STATUS_SUCCESS) {
            return {Classification::Success, false, "pending operation completed successfully"};
        }
        if (r.iosbStatus == STATUS_CANCELLED || r.iosbStatus == STATUS_IO_TIMEOUT) {
            return {Classification::PossiblyCompleted, false, "completion status does not prove absence of mutation"};
        }
        return {Classification::Ambiguous, false, "pending completion returned a non-success status"};
    }

    if (r.completionObserved) {
        if (ntSuccess(r.syscallStatus) && r.iosbStatus == STATUS_SUCCESS) {
            return {Classification::Success, false, "synchronous success with matching completion status"};
        }
        return {Classification::Ambiguous, false, "completion was observed but syscall and completion status are inconsistent or failed"};
    }

    if (r.iosbStatus != STATUS_UNTOUCHED) {
        return {Classification::Ambiguous, false, "IOSB changed without a recorded completion"};
    }
    if (r.syscallStatus == STATUS_OBJECT_NAME_COLLISION) {
        return {Classification::Conflict, false, "no-replace collision"};
    }
    if (r.syscallStatus == STATUS_ACCESS_DENIED) {
        return {Classification::NotPerformed, false, "immediate access denial with untouched IOSB"};
    }
    if (r.syscallStatus == STATUS_CANCELLED || r.syscallStatus == STATUS_IO_TIMEOUT) {
        return {Classification::PossiblyCompleted, false, "uncertain termination status"};
    }
    if (ntSuccess(r.syscallStatus)) {
        return {Classification::Ambiguous, false, "success status without observed completion"};
    }
    return {Classification::Ambiguous, false, "unmapped failure requires postcondition inspection"};
}

static bool automaticMutationAllowed(const Decision& d) {
    // This model never authorizes retry or cleanup from a status classification.
    // In particular, ambiguous/possibly-completed outcomes require inspection.
    return d.retryAllowed && d.classification == Classification::NotPerformed;
}

static const char* name(Classification c) {
    switch (c) {
        case Classification::Success: return "success";
        case Classification::Conflict: return "conflict";
        case Classification::NotPerformed: return "not-performed";
        case Classification::PossiblyCompleted: return "possibly-completed";
        case Classification::Ambiguous: return "ambiguous";
    }
    return "unknown";
}

static int checks = 0;
static int failures = 0;
static void expect(const char* label, const NativeCompletionRecord& record,
                   Classification expected, bool expectedRetry = false) {
    ++checks;
    const Decision d = classify(record);
    const bool ok = d.classification == expected && d.retryAllowed == expectedRetry;
    if (!ok) ++failures;
    std::cout << (ok ? "PASS " : "FAIL ") << label
              << " => " << name(d.classification)
              << ", retry=" << (d.retryAllowed ? "yes" : "no")
              << " (" << d.reason << ")\n";
}

int main() {
    expect("synchronous success", {STATUS_SUCCESS, STATUS_SUCCESS, 12, true}, Classification::Success);
    expect("immediate failure untouched IOSB", {STATUS_ACCESS_DENIED, STATUS_UNTOUCHED, 0, false}, Classification::NotPerformed);
    expect("pending then completion success", {STATUS_PENDING, STATUS_SUCCESS, 12, true}, Classification::Success);
    expect("pending then completion failure", {STATUS_PENDING, STATUS_ACCESS_DENIED, 0, true}, Classification::Ambiguous);
    expect("cancelled completion", {STATUS_PENDING, STATUS_CANCELLED, 0, true}, Classification::PossiblyCompleted);
    expect("timeout without completion", {STATUS_IO_TIMEOUT, STATUS_UNTOUCHED, 0, false}, Classification::PossiblyCompleted);
    expect("pending without completion", {STATUS_PENDING, STATUS_UNTOUCHED, 0, false}, Classification::PossiblyCompleted);
    expect("syscall success but IOSB failure", {STATUS_SUCCESS, STATUS_ACCESS_DENIED, 0, true}, Classification::Ambiguous);
    expect("IOSB changed without completion", {STATUS_ACCESS_DENIED, STATUS_SUCCESS, 0, false}, Classification::Ambiguous);
    expect("no-replace collision", {STATUS_OBJECT_NAME_COLLISION, STATUS_UNTOUCHED, 0, false}, Classification::Conflict);

    const Decision uncertain = classify({STATUS_CANCELLED, STATUS_UNTOUCHED, 0, false});
    ++checks;
    if (uncertain.classification != Classification::PossiblyCompleted || uncertain.retryAllowed) ++failures;
    std::cout << (uncertain.classification == Classification::PossiblyCompleted && !uncertain.retryAllowed
        ? "PASS " : "FAIL ") << "possibly-completed is never retryable\n";

    const Decision ambiguous = classify({STATUS_SUCCESS, STATUS_UNTOUCHED, 0, false});
    ++checks;
    if (ambiguous.classification != Classification::Ambiguous || automaticMutationAllowed(ambiguous)) ++failures;
    std::cout << (ambiguous.classification == Classification::Ambiguous && !automaticMutationAllowed(ambiguous)
        ? "PASS " : "FAIL ") << "ambiguous completion never authorizes retry or cleanup\n";

    ++checks;
    if (automaticMutationAllowed(uncertain)) ++failures;
    std::cout << (!automaticMutationAllowed(uncertain) ? "PASS " : "FAIL ")
              << "possibly-completed never authorizes retry or cleanup\n";

    const Decision conflict = classify({STATUS_OBJECT_NAME_COLLISION, STATUS_UNTOUCHED, 0, false});
    ++checks;
    if (conflict.classification != Classification::Conflict || automaticMutationAllowed(conflict)) ++failures;
    std::cout << (conflict.classification == Classification::Conflict && !automaticMutationAllowed(conflict)
        ? "PASS " : "FAIL ") << "conflict never authorizes destructive cleanup\n";

    std::cout << "SUMMARY checks=" << checks << " failures=" << failures << "\n";
    return failures == 0 ? 0 : 1;
}
