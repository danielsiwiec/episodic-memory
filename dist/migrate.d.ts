/**
 * Migrate data from SQLite to PostgreSQL
 */
export declare function migrateToPostgres(postgresUrl: string, options?: {
    batchSize?: number;
    dryRun?: boolean;
    sqlitePath?: string;
}): Promise<void>;
/**
 * Verify migration by comparing counts
 */
export declare function verifyMigration(postgresUrl: string, sqlitePath?: string): Promise<boolean>;
