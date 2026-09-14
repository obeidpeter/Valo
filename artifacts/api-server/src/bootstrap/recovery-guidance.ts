export const PRODUCTION_RECOVERY_GUIDANCE =
  "Follow docs/operations.md#production-readiness-recovery. " +
  "Keep development-data copying OFF; do not run schema push against production. " +
  "Use the reviewed release path, or separately approved offline recovery " +
  "with a fresh verified backup and disposable restore drill.";
