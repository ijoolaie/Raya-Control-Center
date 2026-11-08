const observed = value => value === true ? true : value === false ? false : null;

export function classifyRestoreRecoveryState({ journalStatus, journalValid, locks = {}, artifacts = {} }) {
  const live = observed(artifacts.destination?.exists);
  const rollback = observed(artifacts.rollback?.exists);
  const temporary = observed(artifacts.temporary?.exists);
  const source = observed(artifacts.source?.exists);
  const runtimeLock = observed(locks.runtime?.active) ?? observed(locks.runtime?.exists);
  const maintenanceLock = observed(locks.maintenance?.active) ?? observed(locks.maintenance?.exists);
  const lockStateUnknown = [locks.runtime, locks.maintenance].some(lock => lock && (lock.error != null || (lock.active == null && lock.exists == null)));
  const observations = { live, rollback, temporary, source, runtimeLock, maintenanceLock };

  if (journalStatus === 'absent') {
    if (runtimeLock || maintenanceLock) return {
      state: 'no-pending-restore-lock-present', severity: 'warning', automaticAction: 'none', observations,
      guidance: 'No Restore journal was found, but a runtime or maintenance lock remains. Do not infer that its owner is stale; verify all database users are stopped before operator action.'
    };
    if (lockStateUnknown) return {
      state: 'no-pending-restore-lock-state-unknown', severity: 'warning', automaticAction: 'none', observations,
      guidance: 'No Restore journal was found, but at least one lock state could not be inspected. Do not infer that no lock exists; verify database users and filesystem state before operator action.'
    };
    return {
      state: 'no-pending-restore', severity: 'info', automaticAction: 'none', observations,
      guidance: 'No pending Restore journal or lock was found. This is not a database integrity check.'
    };
  }
  if (journalStatus !== 'valid' || journalValid !== true) return {
    state: 'manual-review-invalid-journal', severity: 'critical', automaticAction: 'none', observations,
    guidance: 'Preserve the journal and every artifact. Do not retry Restore or infer a recovery copy.'
  };

  let state;
  let guidance;
  if (runtimeLock || maintenanceLock) {
    state = 'blocked-lock-present';
    guidance = 'A lock path exists. Its owner is not classified as stale; verify all database users are stopped before any operator action.';
  } else if (lockStateUnknown) {
    state = 'manual-review-lock-state-unknown';
    guidance = 'At least one runtime or maintenance lock could not be inspected. Preserve all artifacts and verify filesystem and database users before any operator action.';
  } else if (!live && rollback) {
    state = 'live-missing-rollback-present';
    guidance = 'A rollback candidate exists while the live path is absent. Preserve all files; validate a separate copy and require explicit operator selection.';
  } else if (live && rollback) {
    state = 'live-and-rollback-present-ambiguous';
    guidance = 'Both live and rollback files exist. Their authority and installation state cannot be inferred; preserve and compare copies.';
  } else if (!live && !rollback) {
    state = 'live-and-rollback-missing';
    guidance = 'Neither live nor rollback path exists. Preserve the source, temporary, and journal; recovery requires manual investigation.';
  } else {
    state = temporary ? 'live-present-temporary-present-no-rollback' : 'live-present-no-rollback';
    guidance = 'The live path exists and no rollback path is recorded as present. Do not infer that it is unchanged or valid; preserve artifacts and verify a copy.';
  }
  return {
    state, severity: state === 'live-present-no-rollback' ? 'warning' : 'critical',
    automaticAction: 'none', observations,
    guidance: guidance + ' Artifact presence does not establish which database is authoritative.'
  };
}
