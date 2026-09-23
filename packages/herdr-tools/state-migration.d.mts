export const LEGACY_STATE_DIRECTORY: string;
export const STATE_DIRECTORY: string;
export const MIGRATION_MARKER: string;

export type LegacyStateStatus = {
  legacy: boolean;
  current: boolean;
  migrated: boolean;
  needsMigration: boolean;
  legacyWrittenAfterMigration: boolean;
  legacyDirectory: string;
  currentDirectory: string;
};

export type MigrationResult =
  | ({ status: "no-legacy-state" | "already-migrated" } & LegacyStateStatus)
  | {
      status: "migrated";
      migratedTo: string;
      migratedAt: string;
      copiedFiles: number;
      rewrittenFiles: number;
      keptExisting: string[];
      controllerFiles: string[];
      controllerConfigDirectory: string | null;
    };

export function legacyStateStatus(projectRoot: string): Promise<LegacyStateStatus>;
export function rewriteStateText(text: string, pairs: [string, string][]): string;
export function migrateProjectState(options: {
  projectRoot: string;
  controllerConfigDirectory?: string;
  now?: () => Date;
}): Promise<MigrationResult>;
export function formatMigrationResult(result: MigrationResult): string;
