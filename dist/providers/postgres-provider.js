import pg from 'pg';
const { Pool } = pg;
/**
 * PostgreSQL database provider using pgvector for vector search
 */
export class PostgresProvider {
    name = 'postgresql';
    pool = null;
    config;
    constructor(config) {
        this.config = config;
    }
    async initialize() {
        this.pool = new Pool({
            connectionString: this.config.url,
            max: this.config.poolSize,
            ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
        });
        // Test connection
        const client = await this.pool.connect();
        try {
            // Enable pgvector extension
            await client.query('CREATE EXTENSION IF NOT EXISTS vector');
            // Create exchanges table
            await client.query(`
        CREATE TABLE IF NOT EXISTS exchanges (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          user_message TEXT NOT NULL,
          assistant_message TEXT NOT NULL,
          archive_path TEXT NOT NULL,
          line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL,
          embedding vector(384),
          last_indexed BIGINT,
          parent_uuid TEXT,
          is_sidechain BOOLEAN DEFAULT FALSE,
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
            await client.query(`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id TEXT PRIMARY KEY,
          exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
          tool_name TEXT NOT NULL,
          tool_input TEXT,
          tool_result TEXT,
          is_error BOOLEAN DEFAULT FALSE,
          timestamp TIMESTAMPTZ NOT NULL
        )
      `);
            // Create indexes
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_archive_path ON exchanges(archive_path)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)
      `);
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)
      `);
            // Create HNSW index for vector similarity search (faster than IVFFlat for most use cases)
            // Using L2 distance (Euclidean) to match sqlite-vec behavior
            await client.query(`
        CREATE INDEX IF NOT EXISTS idx_embedding_hnsw ON exchanges
        USING hnsw (embedding vector_l2_ops)
      `);
            // Create synced_files table for tracking sync state
            await client.query(`
        CREATE TABLE IF NOT EXISTS synced_files (
          source_path TEXT PRIMARY KEY,
          mtime_ms BIGINT NOT NULL,
          size_bytes BIGINT NOT NULL,
          last_synced TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
            // Create summaries table for storing conversation summaries
            await client.query(`
        CREATE TABLE IF NOT EXISTS summaries (
          session_id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
            // Run migrations
            await this.migrateSchema(client);
        }
        finally {
            client.release();
        }
    }
    async migrateSchema(client) {
        // Get existing columns
        const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'exchanges'
    `);
        const columnNames = new Set(result.rows.map(r => r.column_name));
        const migrations = [
            { name: 'last_indexed', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS last_indexed BIGINT' },
            { name: 'parent_uuid', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS parent_uuid TEXT' },
            { name: 'is_sidechain', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS is_sidechain BOOLEAN DEFAULT FALSE' },
            { name: 'session_id', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS session_id TEXT' },
            { name: 'cwd', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS cwd TEXT' },
            { name: 'git_branch', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS git_branch TEXT' },
            { name: 'claude_version', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS claude_version TEXT' },
            { name: 'thinking_level', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS thinking_level TEXT' },
            { name: 'thinking_disabled', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS thinking_disabled BOOLEAN' },
            { name: 'thinking_triggers', sql: 'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS thinking_triggers TEXT' },
        ];
        let migrated = false;
        for (const migration of migrations) {
            if (!columnNames.has(migration.name)) {
                console.log(`Migrating schema: adding ${migration.name} column...`);
                await client.query(migration.sql);
                migrated = true;
            }
        }
        if (migrated) {
            console.log('Migration complete.');
        }
    }
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
    /**
     * Convert a number array to pgvector format string
     */
    vectorToString(embedding) {
        return `[${embedding.join(',')}]`;
    }
    async insertExchange(exchange, embedding, toolNames) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const now = Date.now();
            // Upsert exchange
            await client.query(`
        INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end,
         embedding, last_indexed, parent_uuid, is_sidechain, session_id, cwd, git_branch, claude_version,
         thinking_level, thinking_disabled, thinking_triggers)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        ON CONFLICT (id) DO UPDATE SET
          project = EXCLUDED.project,
          timestamp = EXCLUDED.timestamp,
          user_message = EXCLUDED.user_message,
          assistant_message = EXCLUDED.assistant_message,
          archive_path = EXCLUDED.archive_path,
          line_start = EXCLUDED.line_start,
          line_end = EXCLUDED.line_end,
          embedding = EXCLUDED.embedding,
          last_indexed = EXCLUDED.last_indexed,
          parent_uuid = EXCLUDED.parent_uuid,
          is_sidechain = EXCLUDED.is_sidechain,
          session_id = EXCLUDED.session_id,
          cwd = EXCLUDED.cwd,
          git_branch = EXCLUDED.git_branch,
          claude_version = EXCLUDED.claude_version,
          thinking_level = EXCLUDED.thinking_level,
          thinking_disabled = EXCLUDED.thinking_disabled,
          thinking_triggers = EXCLUDED.thinking_triggers
      `, [
                exchange.id,
                exchange.project,
                exchange.timestamp,
                exchange.userMessage,
                exchange.assistantMessage,
                exchange.archivePath,
                exchange.lineStart,
                exchange.lineEnd,
                this.vectorToString(embedding),
                now,
                exchange.parentUuid || null,
                exchange.isSidechain || false,
                exchange.sessionId || null,
                exchange.cwd || null,
                exchange.gitBranch || null,
                exchange.claudeVersion || null,
                exchange.thinkingLevel || null,
                exchange.thinkingDisabled || false,
                exchange.thinkingTriggers || null,
            ]);
            // Insert tool calls if present
            if (exchange.toolCalls && exchange.toolCalls.length > 0) {
                for (const toolCall of exchange.toolCalls) {
                    await client.query(`
            INSERT INTO tool_calls
            (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
              exchange_id = EXCLUDED.exchange_id,
              tool_name = EXCLUDED.tool_name,
              tool_input = EXCLUDED.tool_input,
              tool_result = EXCLUDED.tool_result,
              is_error = EXCLUDED.is_error,
              timestamp = EXCLUDED.timestamp
          `, [
                        toolCall.id,
                        toolCall.exchangeId,
                        toolCall.toolName,
                        toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null,
                        toolCall.toolResult || null,
                        toolCall.isError || false,
                        toolCall.timestamp,
                    ]);
                }
            }
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async deleteExchange(id) {
        if (!this.pool)
            throw new Error('Database not initialized');
        // tool_calls will be deleted by CASCADE
        await this.pool.query('DELETE FROM exchanges WHERE id = $1', [id]);
    }
    async getAllExchanges() {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query('SELECT id, archive_path as "archivePath" FROM exchanges');
        return result.rows;
    }
    async getFileLastIndexed(archivePath) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query('SELECT MAX(last_indexed) as "lastIndexed" FROM exchanges WHERE archive_path = $1', [archivePath]);
        return result.rows[0]?.lastIndexed ?? null;
    }
    async hasExchangesForArchive(archivePath) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query('SELECT COUNT(*) as count FROM exchanges WHERE archive_path = $1', [archivePath]);
        return parseInt(result.rows[0].count, 10) > 0;
    }
    async searchByVector(embedding, options = {}) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const { limit = 10, after, before } = options;
        // Build time filter clause
        const params = [this.vectorToString(embedding), limit];
        const conditions = ['e.embedding IS NOT NULL'];
        let paramIndex = 3;
        if (after) {
            conditions.push(`e.timestamp >= $${paramIndex}`);
            params.push(after);
            paramIndex++;
        }
        if (before) {
            conditions.push(`e.timestamp <= $${paramIndex}`);
            params.push(before);
            paramIndex++;
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await this.pool.query(`
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
        e.embedding <-> $1 AS distance
      FROM exchanges e
      ${whereClause}
      ORDER BY e.embedding <-> $1
      LIMIT $2
    `, params);
        return result.rows.map(row => ({
            id: row.id,
            project: row.project,
            timestamp: row.timestamp,
            user_message: row.user_message,
            assistant_message: row.assistant_message,
            archive_path: row.archive_path,
            line_start: row.line_start,
            line_end: row.line_end,
            distance: parseFloat(row.distance),
            parent_uuid: row.parent_uuid,
            is_sidechain: row.is_sidechain,
            session_id: row.session_id,
            cwd: row.cwd,
            git_branch: row.git_branch,
            claude_version: row.claude_version,
            thinking_level: row.thinking_level,
            thinking_disabled: row.thinking_disabled,
            thinking_triggers: row.thinking_triggers,
        }));
    }
    async searchByText(query, options = {}) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const { limit = 10, after, before } = options;
        // Build parameters and conditions
        const likePattern = `%${query}%`;
        const params = [likePattern, likePattern, limit];
        const conditions = ['(e.user_message ILIKE $1 OR e.assistant_message ILIKE $2)'];
        let paramIndex = 4;
        if (after) {
            conditions.push(`e.timestamp >= $${paramIndex}`);
            params.push(after);
            paramIndex++;
        }
        if (before) {
            conditions.push(`e.timestamp <= $${paramIndex}`);
            params.push(before);
            paramIndex++;
        }
        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const result = await this.pool.query(`
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
        0 AS distance
      FROM exchanges e
      ${whereClause}
      ORDER BY e.timestamp DESC
      LIMIT $3
    `, params);
        return result.rows.map(row => ({
            id: row.id,
            project: row.project,
            timestamp: row.timestamp,
            user_message: row.user_message,
            assistant_message: row.assistant_message,
            archive_path: row.archive_path,
            line_start: row.line_start,
            line_end: row.line_end,
            distance: 0,
            parent_uuid: row.parent_uuid,
            is_sidechain: row.is_sidechain,
            session_id: row.session_id,
            cwd: row.cwd,
            git_branch: row.git_branch,
            claude_version: row.claude_version,
            thinking_level: row.thinking_level,
            thinking_disabled: row.thinking_disabled,
            thinking_triggers: row.thinking_triggers,
        }));
    }
    async getStats() {
        if (!this.pool)
            throw new Error('Database not initialized');
        // Total conversations
        const totalConversationsResult = await this.pool.query('SELECT COUNT(DISTINCT archive_path) as count FROM exchanges');
        const totalConversations = parseInt(totalConversationsResult.rows[0].count, 10);
        // Total exchanges
        const totalExchangesResult = await this.pool.query('SELECT COUNT(*) as count FROM exchanges');
        const totalExchanges = parseInt(totalExchangesResult.rows[0].count, 10);
        // Date range
        const dateRangeResult = await this.pool.query('SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM exchanges');
        const dateRange = dateRangeResult.rows[0]?.earliest ? {
            earliest: dateRangeResult.rows[0].earliest,
            latest: dateRangeResult.rows[0].latest,
        } : undefined;
        // Project count
        const projectCountResult = await this.pool.query('SELECT COUNT(DISTINCT project) as count FROM exchanges');
        const projectCount = parseInt(projectCountResult.rows[0].count, 10);
        // Top 10 projects
        const topProjectsResult = await this.pool.query(`
      SELECT project, COUNT(DISTINCT archive_path) as count
      FROM exchanges
      GROUP BY project
      ORDER BY count DESC
      LIMIT 10
    `);
        const topProjects = topProjectsResult.rows.map(r => ({
            project: r.project,
            count: parseInt(r.count, 10),
        }));
        // All archive paths
        const archivePathsResult = await this.pool.query('SELECT DISTINCT archive_path FROM exchanges');
        return {
            totalConversations,
            totalExchanges,
            dateRange,
            projectCount,
            topProjects,
            archivePaths: archivePathsResult.rows.map(r => r.archive_path),
        };
    }
    async rawQuery(sql, params = []) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query(sql, params);
        return result.rows;
    }
    async rawExecute(sql, params = []) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query(sql, params);
        return result.rowCount ?? 0;
    }
    // Sync tracking methods
    /**
     * Get the last sync info for a source file
     */
    async getSyncedFile(sourcePath) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query('SELECT mtime_ms, size_bytes FROM synced_files WHERE source_path = $1', [sourcePath]);
        if (result.rows.length === 0)
            return null;
        return {
            mtimeMs: parseInt(result.rows[0].mtime_ms, 10),
            sizeBytes: parseInt(result.rows[0].size_bytes, 10),
        };
    }
    /**
     * Record a file as synced
     */
    async setSyncedFile(sourcePath, mtimeMs, sizeBytes) {
        if (!this.pool)
            throw new Error('Database not initialized');
        await this.pool.query(`
      INSERT INTO synced_files (source_path, mtime_ms, size_bytes, last_synced)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (source_path) DO UPDATE SET
        mtime_ms = EXCLUDED.mtime_ms,
        size_bytes = EXCLUDED.size_bytes,
        last_synced = NOW()
    `, [sourcePath, Math.floor(mtimeMs), sizeBytes]);
    }
    /**
     * Check if a file needs to be synced (new or modified)
     */
    async needsSync(sourcePath, mtimeMs, sizeBytes) {
        const existing = await this.getSyncedFile(sourcePath);
        if (!existing)
            return true;
        return existing.mtimeMs < mtimeMs || existing.sizeBytes !== sizeBytes;
    }
    // Summary methods
    /**
     * Get summary for a session
     */
    async getSummary(sessionId) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query('SELECT summary FROM summaries WHERE session_id = $1', [sessionId]);
        return result.rows.length > 0 ? result.rows[0].summary : null;
    }
    /**
     * Check if a session has a summary
     */
    async hasSummary(sessionId) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query('SELECT 1 FROM summaries WHERE session_id = $1', [sessionId]);
        return result.rows.length > 0;
    }
    /**
     * Store a summary for a session
     */
    async setSummary(sessionId, project, summary) {
        if (!this.pool)
            throw new Error('Database not initialized');
        await this.pool.query(`
      INSERT INTO summaries (session_id, project, summary, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        project = EXCLUDED.project,
        summary = EXCLUDED.summary,
        created_at = NOW()
    `, [sessionId, project, summary]);
    }
    /**
     * Get sessions that need summaries (have exchanges but no summary)
     */
    async getSessionsNeedingSummaries(limit = 10) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const result = await this.pool.query(`
      SELECT DISTINCT e.session_id, e.project
      FROM exchanges e
      LEFT JOIN summaries s ON e.session_id = s.session_id
      WHERE e.session_id IS NOT NULL AND s.session_id IS NULL
      LIMIT $1
    `, [limit]);
        return result.rows.map(r => ({
            sessionId: r.session_id,
            project: r.project,
        }));
    }
}
