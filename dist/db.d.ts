import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
import { DatabaseProviderInterface } from './db-provider.js';
/**
 * Get or create the database provider based on configuration.
 * This is the main entry point for database operations.
 */
export declare function getProvider(): Promise<DatabaseProviderInterface>;
/**
 * Close the database provider connection
 */
export declare function closeProvider(): Promise<void>;
/**
 * Reset the provider instance (for testing)
 */
export declare function resetProvider(): void;
export declare function migrateSchema(db: Database.Database): void;
/**
 * @deprecated Use getProvider() instead
 */
export declare function initDatabase(): Database.Database;
/**
 * @deprecated Use provider.insertExchange() instead
 */
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], toolNames?: string[]): void;
/**
 * @deprecated Use provider.getAllExchanges() instead
 */
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
/**
 * @deprecated Use provider.getFileLastIndexed() instead
 */
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
/**
 * @deprecated Use provider.deleteExchange() instead
 */
export declare function deleteExchange(db: Database.Database, id: string): void;
