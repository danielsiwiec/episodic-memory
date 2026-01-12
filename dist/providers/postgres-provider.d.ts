import { ConversationExchange } from '../types.js';
import { DatabaseProviderInterface, SearchOptions, RawSearchResult, DatabaseStats } from '../db-provider.js';
import { PostgresConfig } from '../config.js';
/**
 * PostgreSQL database provider using pgvector for vector search
 */
export declare class PostgresProvider implements DatabaseProviderInterface {
    readonly name = "postgresql";
    private pool;
    private config;
    constructor(config: PostgresConfig);
    initialize(): Promise<void>;
    private migrateSchema;
    close(): Promise<void>;
    /**
     * Convert a number array to pgvector format string
     */
    private vectorToString;
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
     * Get the last sync info for a source file
     */
    getSyncedFile(sourcePath: string): Promise<{
        mtimeMs: number;
        sizeBytes: number;
    } | null>;
    /**
     * Record a file as synced
     */
    setSyncedFile(sourcePath: string, mtimeMs: number, sizeBytes: number): Promise<void>;
    /**
     * Check if a file needs to be synced (new or modified)
     */
    needsSync(sourcePath: string, mtimeMs: number, sizeBytes: number): Promise<boolean>;
    /**
     * Get summary for a session
     */
    getSummary(sessionId: string): Promise<string | null>;
    /**
     * Check if a session has a summary
     */
    hasSummary(sessionId: string): Promise<boolean>;
    /**
     * Store a summary for a session
     */
    setSummary(sessionId: string, project: string, summary: string): Promise<void>;
    /**
     * Get sessions that need summaries (have exchanges but no summary)
     */
    getSessionsNeedingSummaries(limit?: number): Promise<Array<{
        sessionId: string;
        project: string;
    }>>;
}
