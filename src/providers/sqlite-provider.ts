import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { ConversationExchange } from '../types.js';
import {
  DatabaseProviderInterface,
  SearchOptions,
  RawSearchResult,
  DatabaseStats,
} from '../db-provider.js';
import { SqliteConfig } from '../config.js';

/**
 * SQLite database provider using better-sqlite3 and sqlite-vec for vector search
 */
export class SqliteProvider implements DatabaseProviderInterface {
  readonly name = 'sqlite';
  private db: Database.Database | null = null;
  private config: SqliteConfig;

  constructor(config: SqliteConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const dbPath = this.config.path;

    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Create exchanges table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exchanges (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        embedding BLOB,
        last_indexed INTEGER,
        parent_uuid TEXT,
        is_sidechain BOOLEAN DEFAULT 0,
        session_id TEXT,
        cwd TEXT,
        git_branch TEXT,
        claude_version TEXT,
        thinking_level TEXT,
        thinking_disabled BOOLEAN,
        thinking_triggers TEXT
      )
    `);

    // Create tool_calls table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        exchange_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT,
        tool_result TEXT,
        is_error BOOLEAN DEFAULT 0,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
      )
    `);

    // Create vector search index
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);

    // Run schema migrations
    this.migrateSchema();

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)`);
  }

  private migrateSchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    const columns = this.db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    const migrations: Array<{ name: string; sql: string }> = [
      { name: 'last_indexed', sql: 'ALTER TABLE exchanges ADD COLUMN last_indexed INTEGER' },
      { name: 'parent_uuid', sql: 'ALTER TABLE exchanges ADD COLUMN parent_uuid TEXT' },
      { name: 'is_sidechain', sql: 'ALTER TABLE exchanges ADD COLUMN is_sidechain BOOLEAN DEFAULT 0' },
      { name: 'session_id', sql: 'ALTER TABLE exchanges ADD COLUMN session_id TEXT' },
      { name: 'cwd', sql: 'ALTER TABLE exchanges ADD COLUMN cwd TEXT' },
      { name: 'git_branch', sql: 'ALTER TABLE exchanges ADD COLUMN git_branch TEXT' },
      { name: 'claude_version', sql: 'ALTER TABLE exchanges ADD COLUMN claude_version TEXT' },
      { name: 'thinking_level', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_level TEXT' },
      { name: 'thinking_disabled', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_disabled BOOLEAN' },
      { name: 'thinking_triggers', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_triggers TEXT' },
    ];

    let migrated = false;
    for (const migration of migrations) {
      if (!columnNames.has(migration.name)) {
        console.log(`Migrating schema: adding ${migration.name} column...`);
        this.db.prepare(migration.sql).run();
        migrated = true;
      }
    }

    if (migrated) {
      console.log('Migration complete.');
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async insertExchange(
    exchange: ConversationExchange,
    embedding: number[],
    toolNames?: string[]
  ): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
       parent_uuid, is_sidechain, session_id, cwd, git_branch, claude_version,
       thinking_level, thinking_disabled, thinking_triggers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      exchange.id,
      exchange.project,
      exchange.timestamp,
      exchange.userMessage,
      exchange.assistantMessage,
      exchange.archivePath,
      exchange.lineStart,
      exchange.lineEnd,
      now,
      exchange.parentUuid || null,
      exchange.isSidechain ? 1 : 0,
      exchange.sessionId || null,
      exchange.cwd || null,
      exchange.gitBranch || null,
      exchange.claudeVersion || null,
      exchange.thinkingLevel || null,
      exchange.thinkingDisabled ? 1 : 0,
      exchange.thinkingTriggers || null
    );

    // Insert into vector table (delete first since virtual tables don't support REPLACE)
    const delStmt = this.db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`);
    delStmt.run(exchange.id);

    const vecStmt = this.db.prepare(`
      INSERT INTO vec_exchanges (id, embedding)
      VALUES (?, ?)
    `);

    vecStmt.run(exchange.id, Buffer.from(new Float32Array(embedding).buffer));

    // Insert tool calls if present
    if (exchange.toolCalls && exchange.toolCalls.length > 0) {
      const toolStmt = this.db.prepare(`
        INSERT OR REPLACE INTO tool_calls
        (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const toolCall of exchange.toolCalls) {
        toolStmt.run(
          toolCall.id,
          toolCall.exchangeId,
          toolCall.toolName,
          toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null,
          toolCall.toolResult || null,
          toolCall.isError ? 1 : 0,
          toolCall.timestamp
        );
      }
    }
  }

  async deleteExchange(id: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Delete from vector table
    this.db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);

    // Delete from main table
    this.db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
  }

  async getAllExchanges(): Promise<Array<{ id: string; archivePath: string }>> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
    return stmt.all() as Array<{ id: string; archivePath: string }>;
  }

  async getFileLastIndexed(archivePath: string): Promise<number | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT MAX(last_indexed) as lastIndexed
      FROM exchanges
      WHERE archive_path = ?
    `);
    const row = stmt.get(archivePath) as { lastIndexed: number | null };
    return row.lastIndexed;
  }

  async hasExchangesForArchive(archivePath: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?`);
    const result = stmt.get(archivePath) as { count: number };
    return result.count > 0;
  }

  async searchByVector(
    embedding: number[],
    options: SearchOptions = {}
  ): Promise<RawSearchResult[]> {
    if (!this.db) throw new Error('Database not initialized');

    const { limit = 10, after, before } = options;

    // Build time filter clause
    const timeFilter: string[] = [];
    if (after) timeFilter.push(`e.timestamp >= '${after}'`);
    if (before) timeFilter.push(`e.timestamp <= '${before}'`);
    const timeClause = timeFilter.length > 0 ? `AND ${timeFilter.join(' AND ')}` : '';

    const stmt = this.db.prepare(`
      SELECT
        e.id,
        e.project,
        e.timestamp,
        e.user_message,
        e.assistant_message,
        e.archive_path,
        e.line_start,
        e.line_end,
        e.parent_uuid,
        e.is_sidechain,
        e.session_id,
        e.cwd,
        e.git_branch,
        e.claude_version,
        e.thinking_level,
        e.thinking_disabled,
        e.thinking_triggers,
        vec.distance
      FROM vec_exchanges AS vec
      JOIN exchanges AS e ON vec.id = e.id
      WHERE vec.embedding MATCH ?
        AND k = ?
        ${timeClause}
      ORDER BY vec.distance ASC
    `);

    return stmt.all(
      Buffer.from(new Float32Array(embedding).buffer),
      limit
    ) as RawSearchResult[];
  }

  async searchByText(
    query: string,
    options: SearchOptions = {}
  ): Promise<RawSearchResult[]> {
    if (!this.db) throw new Error('Database not initialized');

    const { limit = 10, after, before } = options;

    // Build time filter clause
    const timeFilter: string[] = [];
    if (after) timeFilter.push(`e.timestamp >= '${after}'`);
    if (before) timeFilter.push(`e.timestamp <= '${before}'`);
    const timeClause = timeFilter.length > 0 ? `AND ${timeFilter.join(' AND ')}` : '';

    const stmt = this.db.prepare(`
      SELECT
        e.id,
        e.project,
        e.timestamp,
        e.user_message,
        e.assistant_message,
        e.archive_path,
        e.line_start,
        e.line_end,
        e.parent_uuid,
        e.is_sidechain,
        e.session_id,
        e.cwd,
        e.git_branch,
        e.claude_version,
        e.thinking_level,
        e.thinking_disabled,
        e.thinking_triggers,
        0 as distance
      FROM exchanges AS e
      WHERE (e.user_message LIKE ? OR e.assistant_message LIKE ?)
        ${timeClause}
      ORDER BY e.timestamp DESC
      LIMIT ?
    `);

    return stmt.all(`%${query}%`, `%${query}%`, limit) as RawSearchResult[];
  }

  async getStats(): Promise<DatabaseStats> {
    if (!this.db) throw new Error('Database not initialized');

    // Total conversations
    const totalConversations = this.db.prepare(
      'SELECT COUNT(DISTINCT archive_path) as count FROM exchanges'
    ).get() as { count: number };

    // Total exchanges
    const totalExchanges = this.db.prepare(
      'SELECT COUNT(*) as count FROM exchanges'
    ).get() as { count: number };

    // Date range
    const dateRange = this.db.prepare(
      'SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM exchanges'
    ).get() as { earliest: string; latest: string } | undefined;

    // Project count
    const projectCount = this.db.prepare(
      'SELECT COUNT(DISTINCT project) as count FROM exchanges'
    ).get() as { count: number };

    // Top 10 projects
    const topProjects = this.db.prepare(`
      SELECT project, COUNT(DISTINCT archive_path) as count
      FROM exchanges
      GROUP BY project
      ORDER BY count DESC
      LIMIT 10
    `).all() as Array<{ project: string; count: number }>;

    // All archive paths
    const archivePathsResult = this.db.prepare(
      'SELECT DISTINCT archive_path FROM exchanges'
    ).all() as Array<{ archive_path: string }>;

    return {
      totalConversations: totalConversations.count,
      totalExchanges: totalExchanges.count,
      dateRange: dateRange?.earliest ? {
        earliest: dateRange.earliest,
        latest: dateRange.latest,
      } : undefined,
      projectCount: projectCount.count,
      topProjects,
      archivePaths: archivePathsResult.map(r => r.archive_path),
    };
  }

  async rawQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).all(...params) as T[];
  }

  async rawExecute(sql: string, params: unknown[] = []): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  /**
   * Get the underlying database instance (for legacy compatibility)
   */
  getDatabase(): Database.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }
}
