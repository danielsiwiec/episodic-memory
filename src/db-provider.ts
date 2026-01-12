import { ConversationExchange, ToolCall } from './types.js';

/**
 * Search options for vector and text queries
 */
export interface SearchOptions {
  limit?: number;
  after?: string;  // ISO date string YYYY-MM-DD
  before?: string; // ISO date string YYYY-MM-DD
}

/**
 * Raw search result from database (before formatting)
 */
export interface RawSearchResult {
  id: string;
  project: string;
  timestamp: string;
  user_message: string;
  assistant_message: string;
  archive_path: string;
  line_start: number;
  line_end: number;
  distance: number;
  parent_uuid?: string;
  is_sidechain?: boolean;
  session_id?: string;
  cwd?: string;
  git_branch?: string;
  claude_version?: string;
  thinking_level?: string;
  thinking_disabled?: boolean;
  thinking_triggers?: string;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  totalConversations: number;
  totalExchanges: number;
  dateRange?: {
    earliest: string;
    latest: string;
  };
  projectCount: number;
  topProjects?: Array<{ project: string; count: number }>;
  archivePaths: string[];
}

/**
 * Abstract database provider interface
 * Implementations must provide vector search, text storage, and CRUD operations
 */
export interface DatabaseProviderInterface {
  /**
   * Provider name for logging/debugging
   */
  readonly name: string;

  /**
   * Initialize the database connection and schema
   */
  initialize(): Promise<void>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;

  /**
   * Insert or update an exchange with its embedding
   */
  insertExchange(
    exchange: ConversationExchange,
    embedding: number[],
    toolNames?: string[]
  ): Promise<void>;

  /**
   * Delete an exchange by ID
   */
  deleteExchange(id: string): Promise<void>;

  /**
   * Get all exchanges (id and archivePath only)
   */
  getAllExchanges(): Promise<Array<{ id: string; archivePath: string }>>;

  /**
   * Get the last indexed timestamp for a file
   */
  getFileLastIndexed(archivePath: string): Promise<number | null>;

  /**
   * Check if an archive path has any indexed exchanges
   */
  hasExchangesForArchive(archivePath: string): Promise<boolean>;

  /**
   * Search by vector similarity
   */
  searchByVector(
    embedding: number[],
    options?: SearchOptions
  ): Promise<RawSearchResult[]>;

  /**
   * Search by text pattern (LIKE query)
   */
  searchByText(
    query: string,
    options?: SearchOptions
  ): Promise<RawSearchResult[]>;

  /**
   * Get database statistics
   */
  getStats(): Promise<DatabaseStats>;

  /**
   * Execute a raw query (for provider-specific operations)
   * Returns results as an array of objects
   */
  rawQuery<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a raw statement (for provider-specific operations)
   * Returns affected row count
   */
  rawExecute(sql: string, params?: unknown[]): Promise<number>;

  // Optional sync tracking methods (PostgreSQL only, for stateless sync)

  /**
   * Get sync info for a source file (optional - only for PostgreSQL)
   */
  getSyncedFile?(sourcePath: string): Promise<{ mtimeMs: number; sizeBytes: number } | null>;

  /**
   * Record a file as synced (optional - only for PostgreSQL)
   */
  setSyncedFile?(sourcePath: string, mtimeMs: number, sizeBytes: number): Promise<void>;

  /**
   * Check if a file needs syncing (optional - only for PostgreSQL)
   */
  needsSync?(sourcePath: string, mtimeMs: number, sizeBytes: number): Promise<boolean>;

  // Optional summary methods (PostgreSQL only, for stateless sync)

  /**
   * Get summary for a session (optional - only for PostgreSQL)
   */
  getSummary?(sessionId: string): Promise<string | null>;

  /**
   * Check if a session has a summary (optional - only for PostgreSQL)
   */
  hasSummary?(sessionId: string): Promise<boolean>;

  /**
   * Store a summary for a session (optional - only for PostgreSQL)
   */
  setSummary?(sessionId: string, project: string, summary: string): Promise<void>;

  /**
   * Get sessions needing summaries (optional - only for PostgreSQL)
   */
  getSessionsNeedingSummaries?(limit: number): Promise<Array<{ sessionId: string; project: string }>>;
}

/**
 * Helper to convert raw DB row to ConversationExchange
 */
export function rowToExchange(row: RawSearchResult): ConversationExchange {
  return {
    id: row.id,
    project: row.project,
    timestamp: row.timestamp,
    userMessage: row.user_message,
    assistantMessage: row.assistant_message,
    archivePath: row.archive_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    parentUuid: row.parent_uuid,
    isSidechain: row.is_sidechain,
    sessionId: row.session_id,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    claudeVersion: row.claude_version,
    thinkingLevel: row.thinking_level,
    thinkingDisabled: row.thinking_disabled,
    thinkingTriggers: row.thinking_triggers,
  };
}
