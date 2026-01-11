import Database from 'better-sqlite3';
import { ConversationExchange } from '../types.js';
import { DatabaseProviderInterface, SearchOptions, RawSearchResult, DatabaseStats } from '../db-provider.js';
import { SqliteConfig } from '../config.js';
/**
 * SQLite database provider using better-sqlite3 and sqlite-vec for vector search
 */
export declare class SqliteProvider implements DatabaseProviderInterface {
    readonly name = "sqlite";
    private db;
    private config;
    constructor(config: SqliteConfig);
    initialize(): Promise<void>;
    private migrateSchema;
    close(): Promise<void>;
    insertExchange(exchange: ConversationExchange, embedding: number[], toolNames?: string[]): Promise<void>;
    deleteExchange(id: string): Promise<void>;
    getAllExchanges(): Promise<Array<{
        id: string;
        archivePath: string;
    }>>;
    getFileLastIndexed(archivePath: string): Promise<number | null>;
    hasExchangesForArchive(archivePath: string): Promise<boolean>;
    searchByVector(embedding: number[], options?: SearchOptions): Promise<RawSearchResult[]>;
    searchByText(query: string, options?: SearchOptions): Promise<RawSearchResult[]>;
    getStats(): Promise<DatabaseStats>;
    rawQuery<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
    rawExecute(sql: string, params?: unknown[]): Promise<number>;
    /**
     * Get the underlying database instance (for legacy compatibility)
     */
    getDatabase(): Database.Database;
}
