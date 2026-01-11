import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrateToPostgres, verifyMigration } from '../src/migrate.js';
import { PostgresProvider } from '../src/providers/postgres-provider.js';
import { suppressConsole } from './test-utils.js';

// These tests require Docker to be running
// They test the migration from SQLite to PostgreSQL

describe('Migration: SQLite to PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let postgresUrl: string;
  let testDir: string;
  let sqlitePath: string;
  let restoreConsole: () => void;

  // Start PostgreSQL container once for all tests
  beforeAll(async () => {
    restoreConsole = suppressConsole();

    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('testdb')
      .withUsername('test')
      .withPassword('test')
      .start();

    postgresUrl = container.getConnectionUri();
  }, 60000);

  afterAll(async () => {
    if (restoreConsole) restoreConsole();
    if (container) {
      await container.stop();
    }
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'migration-test-'));
    sqlitePath = join(testDir, 'test.db');
  });

  afterEach(async () => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up PostgreSQL tables
    const pgProvider = new PostgresProvider({
      url: postgresUrl,
      poolSize: 5,
      ssl: false,
    });
    await pgProvider.initialize();
    await pgProvider.rawExecute('DELETE FROM exchanges');
    await pgProvider.close();
  });

  describe('migrateToPostgres', () => {
    it('should migrate exchanges from SQLite to PostgreSQL', async () => {
      // Create SQLite database with test data
      const sqliteDb = createTestSqliteDb(sqlitePath);
      insertTestExchange(sqliteDb, {
        id: 'test-1',
        project: 'project-a',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Hello',
        assistantMessage: 'Hi there!',
        archivePath: join(testDir, 'conv1.jsonl'),
      });
      sqliteDb.close();

      // Run migration
      await migrateToPostgres(postgresUrl, { sqlitePath });

      // Verify data in PostgreSQL
      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const stats = await pgProvider.getStats();
      expect(stats.totalExchanges).toBe(1);

      const exchanges = await pgProvider.getAllExchanges();
      expect(exchanges[0].id).toBe('test-1');

      await pgProvider.close();
    });

    it('should migrate multiple exchanges', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      for (let i = 0; i < 5; i++) {
        insertTestExchange(sqliteDb, {
          id: `test-${i}`,
          project: `project-${i % 2}`,
          timestamp: `2025-01-0${i + 1}T12:00:00Z`,
          userMessage: `Message ${i}`,
          assistantMessage: `Response ${i}`,
          archivePath: join(testDir, `conv${i}.jsonl`),
        });
      }
      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath });

      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const stats = await pgProvider.getStats();
      expect(stats.totalExchanges).toBe(5);
      expect(stats.projectCount).toBe(2);

      await pgProvider.close();
    });

    it('should preserve embeddings during migration', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      // Create a specific embedding
      const embedding = new Array(384).fill(0).map((_, i) => i / 384);
      insertTestExchange(sqliteDb, {
        id: 'embed-test',
        project: 'project-a',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test',
        assistantMessage: 'Response',
        archivePath: join(testDir, 'conv.jsonl'),
      }, embedding);
      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath });

      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      // Search with the same embedding - should find the migrated exchange
      const results = await pgProvider.searchByVector(embedding, { limit: 1 });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('embed-test');
      // Distance should be very close to 0 for exact match
      expect(results[0].distance).toBeLessThan(0.01);

      await pgProvider.close();
    });

    it('should migrate all metadata fields', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      insertTestExchange(sqliteDb, {
        id: 'meta-test',
        project: 'project-a',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test',
        assistantMessage: 'Response',
        archivePath: join(testDir, 'conv.jsonl'),
        parentUuid: 'parent-123',
        isSidechain: true,
        sessionId: 'session-456',
        cwd: '/home/user/project',
        gitBranch: 'feature-branch',
        claudeVersion: '2.0.0',
        thinkingLevel: 'extended',
        thinkingDisabled: false,
        thinkingTriggers: 'trigger1',
      });
      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath });

      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const results = await pgProvider.rawQuery<{
        session_id: string;
        git_branch: string;
        is_sidechain: boolean;
        cwd: string;
      }>(
        'SELECT session_id, git_branch, is_sidechain, cwd FROM exchanges WHERE id = $1',
        ['meta-test']
      );

      expect(results[0].session_id).toBe('session-456');
      expect(results[0].git_branch).toBe('feature-branch');
      expect(results[0].is_sidechain).toBe(true);
      expect(results[0].cwd).toBe('/home/user/project');

      await pgProvider.close();
    });

    it('should migrate tool calls', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      insertTestExchange(sqliteDb, {
        id: 'tool-test',
        project: 'project-a',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test',
        assistantMessage: 'Response',
        archivePath: join(testDir, 'conv.jsonl'),
      });

      // Insert tool calls
      sqliteDb.prepare(`
        INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('tool-1', 'tool-test', 'Read', '{"path":"/test"}', 'contents', 0, '2025-01-01T12:00:01Z');

      sqliteDb.prepare(`
        INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('tool-2', 'tool-test', 'Write', '{"path":"/out"}', null, 0, '2025-01-01T12:00:02Z');

      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath });

      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const toolCalls = await pgProvider.rawQuery<{ id: string; tool_name: string }>(
        'SELECT id, tool_name FROM tool_calls WHERE exchange_id = $1 ORDER BY timestamp',
        ['tool-test']
      );

      expect(toolCalls.length).toBe(2);
      expect(toolCalls[0].tool_name).toBe('Read');
      expect(toolCalls[1].tool_name).toBe('Write');

      await pgProvider.close();
    });

    it('should skip exchanges without embeddings', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      // Insert exchange with embedding
      insertTestExchange(sqliteDb, {
        id: 'with-embed',
        project: 'project-a',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Has embedding',
        assistantMessage: 'Response',
        archivePath: join(testDir, 'conv1.jsonl'),
      });

      // Insert exchange without embedding (directly to exchanges table, skipping vec_exchanges)
      sqliteDb.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('no-embed', 'project-a', '2025-01-01T12:00:00Z', 'No embedding', 'Response', join(testDir, 'conv2.jsonl'), 1, 2);

      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath });

      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const stats = await pgProvider.getStats();
      expect(stats.totalExchanges).toBe(1); // Only the one with embedding

      const exchanges = await pgProvider.getAllExchanges();
      expect(exchanges[0].id).toBe('with-embed');

      await pgProvider.close();
    });

    it('should handle dry run mode', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);
      insertTestExchange(sqliteDb, {
        id: 'dry-run-test',
        project: 'project-a',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test',
        assistantMessage: 'Response',
        archivePath: join(testDir, 'conv.jsonl'),
      });
      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath, dryRun: true });

      // PostgreSQL should be empty (dry run doesn't modify)
      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const stats = await pgProvider.getStats();
      expect(stats.totalExchanges).toBe(0);

      await pgProvider.close();
    });

    it('should handle batch processing', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      // Insert more exchanges than batch size
      for (let i = 0; i < 15; i++) {
        insertTestExchange(sqliteDb, {
          id: `batch-${i}`,
          project: 'project-a',
          timestamp: `2025-01-01T12:${i.toString().padStart(2, '0')}:00Z`,
          userMessage: `Message ${i}`,
          assistantMessage: `Response ${i}`,
          archivePath: join(testDir, `conv${i}.jsonl`),
        });
      }
      sqliteDb.close();

      // Migrate with small batch size
      await migrateToPostgres(postgresUrl, { sqlitePath, batchSize: 5 });

      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      const stats = await pgProvider.getStats();
      expect(stats.totalExchanges).toBe(15);

      await pgProvider.close();
    });
  });

  describe('verifyMigration', () => {
    it('should verify successful migration', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      for (let i = 0; i < 3; i++) {
        insertTestExchange(sqliteDb, {
          id: `verify-${i}`,
          project: 'project-a',
          timestamp: '2025-01-01T12:00:00Z',
          userMessage: `Message ${i}`,
          assistantMessage: `Response ${i}`,
          archivePath: join(testDir, `conv${i}.jsonl`),
        });
      }
      sqliteDb.close();

      await migrateToPostgres(postgresUrl, { sqlitePath });

      const result = await verifyMigration(postgresUrl, sqlitePath);

      expect(result).toBe(true);
    });

    it('should detect missing exchanges', async () => {
      const sqliteDb = createTestSqliteDb(sqlitePath);

      // Add exchanges to SQLite
      for (let i = 0; i < 5; i++) {
        insertTestExchange(sqliteDb, {
          id: `miss-${i}`,
          project: 'project-a',
          timestamp: '2025-01-01T12:00:00Z',
          userMessage: `Message ${i}`,
          assistantMessage: `Response ${i}`,
          archivePath: join(testDir, `conv${i}.jsonl`),
        });
      }
      sqliteDb.close();

      // Only migrate 3 of them by manually inserting to PostgreSQL
      const pgProvider = new PostgresProvider({
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
      });
      await pgProvider.initialize();

      for (let i = 0; i < 3; i++) {
        await pgProvider.insertExchange(
          {
            id: `miss-${i}`,
            project: 'project-a',
            timestamp: '2025-01-01T12:00:00Z',
            userMessage: `Message ${i}`,
            assistantMessage: `Response ${i}`,
            archivePath: join(testDir, `conv${i}.jsonl`),
            lineStart: 1,
            lineEnd: 2,
          },
          new Array(384).fill(0.1)
        );
      }
      await pgProvider.close();

      const result = await verifyMigration(postgresUrl, sqlitePath);

      expect(result).toBe(false);
    });
  });
});

/**
 * Create a test SQLite database with the required schema
 */
function createTestSqliteDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain INTEGER DEFAULT 0,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      thinking_level TEXT,
      thinking_disabled INTEGER DEFAULT 0,
      thinking_triggers TEXT
    )
  `);

  db.exec(`
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[384]
    )
  `);

  return db;
}

/**
 * Insert a test exchange into SQLite with embedding
 */
function insertTestExchange(
  db: Database.Database,
  data: {
    id: string;
    project: string;
    timestamp: string;
    userMessage: string;
    assistantMessage: string;
    archivePath: string;
    parentUuid?: string;
    isSidechain?: boolean;
    sessionId?: string;
    cwd?: string;
    gitBranch?: string;
    claudeVersion?: string;
    thinkingLevel?: string;
    thinkingDisabled?: boolean;
    thinkingTriggers?: string;
  },
  embedding?: number[]
): void {
  const emb = embedding || new Array(384).fill(0.1);

  db.prepare(`
    INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end,
     parent_uuid, is_sidechain, session_id, cwd, git_branch, claude_version, thinking_level, thinking_disabled, thinking_triggers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    data.project,
    data.timestamp,
    data.userMessage,
    data.assistantMessage,
    data.archivePath,
    1,
    2,
    data.parentUuid || null,
    data.isSidechain ? 1 : 0,
    data.sessionId || null,
    data.cwd || null,
    data.gitBranch || null,
    data.claudeVersion || null,
    data.thinkingLevel || null,
    data.thinkingDisabled ? 1 : 0,
    data.thinkingTriggers || null
  );

  // Insert embedding into vec_exchanges
  const embBuffer = Buffer.from(new Float32Array(emb).buffer);
  db.prepare(`
    INSERT INTO vec_exchanges (id, embedding)
    VALUES (?, ?)
  `).run(data.id, embBuffer);
}
