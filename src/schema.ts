import { z } from "zod";

export const renovateUpgradeSchema = z
  .looseObject({
    currentDigest: z.string().nullish(),
    currentDigestShort: z.string().nullish(),
    currentValue: z.string().nullish(),
    currentVersion: z.string().nullish(),
    datasource: z.string().nullish(),
    depName: z.string().nullish(),
    depType: z.string().nullish(),
    displayFrom: z.string().nullish(),
    displayTo: z.string().nullish(),
    isGroup: z.boolean().nullish(),
    isLockFileMaintenance: z.boolean().nullish(),
    isLockfileUpdate: z.boolean().nullish(),
    isMajor: z.boolean().nullish(),
    isMinor: z.boolean().nullish(),
    isPatch: z.boolean().nullish(),
    isPin: z.boolean().nullish(),
    isPinDigest: z.boolean().nullish(),
    isRange: z.boolean().nullish(),
    isReplacement: z.boolean().nullish(),
    isRollback: z.boolean().nullish(),
    isSingleVersion: z.boolean().nullish(),
    isVulnerabilityAlert: z.boolean().nullish(),
    manager: z.string().nullish(),
    newDigest: z.string().nullish(),
    newDigestShort: z.string().nullish(),
    newMajor: z.number().nullish(),
    newMinor: z.number().nullish(),
    newName: z.string().nullish(),
    newPatch: z.number().nullish(),
    newValue: z.string().nullish(),
    newVersion: z.string().nullish(),
    packageFile: z.string(),
    packageFileDir: z.string().nullish(),
    packageName: z.string().nullish(),
    parentDir: z.string().nullish(),
    prettyDepType: z.string().nullish(),
    prettyNewMajor: z.string().nullish(),
    prettyNewVersion: z.string().nullish(),
    sourceUrl: z.string().nullish(),
    updateType: z
      .enum([
        "bump",
        "digest",
        "lockFileMaintenance",
        "lockfileUpdate",
        "major",
        "minor",
        "patch",
        "pin",
        "pinDigest",
        "replacement",
        "rollback",
      ])
      .nullish(),
    vulnerabilitySeverity: z.string().nullish(),
  })
  .refine((upgrade) => upgrade.updateType === "lockFileMaintenance" || typeof upgrade.depName === "string", {
    error: "An upgrade needs a depName unless it is lockFileMaintenance",
    path: ["depName"],
  });

export type Upgrade = z.infer<typeof renovateUpgradeSchema>;

export type RenovateUpdateType = NonNullable<Upgrade["updateType"]>;
