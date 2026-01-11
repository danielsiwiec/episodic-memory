/**
 * Database provider types
 */
export type DatabaseProvider = 'sqlite' | 'postgresql';
/**
 * SQLite-specific configuration
 */
export interface SqliteConfig {
    path: string;
}
/**
 * PostgreSQL-specific configuration
 */
export interface PostgresConfig {
    url: string;
    poolSize: number;
    ssl: boolean;
}
/**
 * Complete database configuration
 */
export interface DatabaseConfig {
    provider: DatabaseProvider;
    sqlite?: SqliteConfig;
    postgresql?: PostgresConfig;
}
/**
 * Get the path to the config file
 */
export declare function getConfigPath(): string;
/**
 * Get database configuration with the following precedence:
 * 1. Environment variables (highest priority)
 * 2. Config file (~/.config/superpowers/conversation-index/config.json)
 * 3. Default (SQLite)
 *
 * Environment variables:
 * - EPISODIC_MEMORY_DB_PROVIDER: 'sqlite' | 'postgresql'
 * - EPISODIC_MEMORY_POSTGRES_URL: PostgreSQL connection URL
 * - EPISODIC_MEMORY_POSTGRES_POOL_SIZE: Connection pool size (default: 10)
 * - EPISODIC_MEMORY_POSTGRES_SSL: Enable SSL (default: false)
 */
export declare function getDatabaseConfig(): DatabaseConfig;
/**
 * Check if using PostgreSQL
 */
export declare function isPostgresql(): boolean;
/**
 * Check if using SQLite
 */
export declare function isSqlite(): boolean;
/**
 * Get a human-readable description of the current database configuration
 */
export declare function getConfigDescription(): string;
