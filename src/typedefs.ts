export type RenovateUpdateType =
  | "bump"
  | "digest"
  | "lockFileMaintenance"
  | "lockfileUpdate"
  | "major"
  | "minor"
  | "patch"
  | "pin"
  | "pinDigest"
  | "replacement"
  | "rollback";

export type RenovateUpgrade = {
  currentDigest?: string | null;
  currentDigestShort?: string | null;
  currentValue?: string | null;
  currentVersion?: string | null;
  datasource?: string | null;
  depName?: string | null;
  depType?: string | null;
  displayFrom?: string | null;
  displayTo?: string | null;
  isGroup?: boolean | null;
  isLockfileUpdate?: boolean | null;
  isMajor?: boolean | null;
  isMinor?: boolean | null;
  isPatch?: boolean | null;
  isPin?: boolean | null;
  isPinDigest?: boolean | null;
  isRange?: boolean | null;
  isReplacement?: boolean | null;
  isRollback?: boolean | null;
  isSingleVersion?: boolean | null;
  isVulnerabilityAlert?: boolean | null;
  manager?: string | null;
  newDigest?: string | null;
  newDigestShort?: string | null;
  newMajor?: number | null;
  newMinor?: number | null;
  newName?: string | null;
  newPatch?: number | null;
  newValue?: string | null;
  newVersion?: string | null;
  packageFile?: string | null;
  packageFileDir?: string | null;
  packageName?: string | null;
  parentDir?: string | null;
  prettyDepType?: string | null;
  prettyNewMajor?: string | null;
  prettyNewVersion?: string | null;
  updateType?: RenovateUpdateType | null;
};
