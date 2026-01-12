import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresProvider } from '../src/providers/postgres-provider.js';
import { ConversationExchange } from '../src/types.js';
import { suppressConsole } from './test-utils.js';

// These tests require Docker to be running
// They are slower than unit tests due to container startup

describe('PostgresProvider', () => {
  let container: StartedPostgreSqlContainer;
  let provider: PostgresProvider;
  const restoreConsole = suppressConsole();

  // Use a longer timeout for container operations
  beforeAll(async () => {
    // Start PostgreSQL container with pgvector extension
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('testdb')
      .withUsername('test')
      .withPassword('test')
      .start();

    provider = new PostgresProvider({
      url: container.getConnectionUri(),
      poolSize: 5,
      ssl: false,
    });

    await provider.initialize();
  }, 60000); // 60 second timeout for container startup

  afterAll(async () => {
    restoreConsole();
    if (provider) {
      await provider.close();
    }
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    // Clean up exchanges table before each test
    await provider.rawExecute('DELETE FROM exchanges');
  });

  describe('initialization', () => {
    it('should create required tables', async () => {
      const tables = await provider.rawQuery<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
      );
      const tableNames = tables.map(t => t.tablename);

      expect(tableNames).toContain('exchanges');
      expect(tableNames).toContain('tool_calls');
    });

    it('should enable pgvector extension', async () => {
      const extensions = await provider.rawQuery<{ extname: string }>(
        'SELECT extname FROM pg_extension'
      );
      const extNames = extensions.map(e => e.extname);

      expect(extNames).toContain('vector');
    });

    it('should create HNSW index for embeddings', async () => {
      const indexes = await provider.rawQuery<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'exchanges'"
      );
      const indexNames = indexes.map(i => i.indexname);

      expect(indexNames).toContain('idx_embedding_hnsw');
    });
  });

  describe('insertExchange', () => {
    it('should insert a basic exchange', async () => {
      const exchange: ConversationExchange = {
        id: 'test-id-1',
        project: 'test-project',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Hello, how are you?',
        assistantMessage: 'I am doing great, thank you!',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
      };

      const embedding = new Array(384).fill(0.1);
      await provider.insertExchange(exchange, embedding);

      const results = await provider.rawQuery<{ id: string; project: string }>(
        'SELECT id, project FROM exchanges WHERE id = $1',
        ['test-id-1']
      );

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('test-id-1');
      expect(results[0].project).toBe('test-project');
    });

    it('should store embedding as vector', async () => {
      const exchange: ConversationExchange = {
        id: 'test-id-2',
        project: 'test-project',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test message',
        assistantMessage: 'Test response',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
      };

      const embedding = new Array(384).fill(0.5);
      await provider.insertExchange(exchange, embedding);

      // Verify embedding is stored (we can't easily query the vector, but we can check it's not null)
      const results = await provider.rawQuery<{ has_embedding: boolean }>(
        'SELECT embedding IS NOT NULL as has_embedding FROM exchanges WHERE id = $1',
        ['test-id-2']
      );

      expect(results[0].has_embedding).toBe(true);
    });

    it('should handle exchange with all optional fields', async () => {
      const exchange: ConversationExchange = {
        id: 'test-id-3',
        project: 'test-project',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test message',
        assistantMessage: 'Test response',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
        parentUuid: 'parent-uuid',
        isSidechain: true,
        sessionId: 'session-123',
        cwd: '/home/user/project',
        gitBranch: 'main',
        claudeVersion: '1.0.0',
        thinkingLevel: 'high',
        thinkingDisabled: false,
        thinkingTriggers: 'trigger1,trigger2',
      };

      const embedding = new Array(384).fill(0.1);
      await provider.insertExchange(exchange, embedding);

      const results = await provider.rawQuery<{
        session_id: string;
        git_branch: string;
        is_sidechain: boolean;
      }>(
        'SELECT session_id, git_branch, is_sidechain FROM exchanges WHERE id = $1',
        ['test-id-3']
      );

      expect(results[0].session_id).toBe('session-123');
      expect(results[0].git_branch).toBe('main');
      expect(results[0].is_sidechain).toBe(true);
    });

    it('should upsert on conflict', async () => {
      const exchange: ConversationExchange = {
        id: 'test-id-upsert',
        project: 'project-1',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Original message',
        assistantMessage: 'Original response',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
      };

      const embedding = new Array(384).fill(0.1);
      await provider.insertExchange(exchange, embedding);

      // Update the exchange
      const updatedExchange = {
        ...exchange,
        project: 'project-2',
        userMessage: 'Updated message',
      };
      await provider.insertExchange(updatedExchange, embedding);

      const results = await provider.rawQuery<{ project: string; user_message: string }>(
        'SELECT project, user_message FROM exchanges WHERE id = $1',
        ['test-id-upsert']
      );

      expect(results.length).toBe(1);
      expect(results[0].project).toBe('project-2');
      expect(results[0].user_message).toBe('Updated message');
    });

    it('should insert tool calls', async () => {
      const exchange: ConversationExchange = {
        id: 'test-id-tools',
        project: 'test-project',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test message',
        assistantMessage: 'Test response',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
        toolCalls: [
          {
            id: 'tool-1',
            exchangeId: 'test-id-tools',
            toolName: 'Read',
            toolInput: { path: '/test/file.txt' },
            toolResult: 'file contents',
            isError: false,
            timestamp: '2025-01-01T12:00:01Z',
          },
          {
            id: 'tool-2',
            exchangeId: 'test-id-tools',
            toolName: 'Write',
            toolInput: { path: '/test/output.txt', content: 'hello' },
            isError: false,
            timestamp: '2025-01-01T12:00:02Z',
          },
        ],
      };

      const embedding = new Array(384).fill(0.1);
      await provider.insertExchange(exchange, embedding);

      const toolCalls = await provider.rawQuery<{ tool_name: string }>(
        'SELECT tool_name FROM tool_calls WHERE exchange_id = $1 ORDER BY timestamp',
        ['test-id-tools']
      );

      expect(toolCalls.length).toBe(2);
      expect(toolCalls[0].tool_name).toBe('Read');
      expect(toolCalls[1].tool_name).toBe('Write');
    });
  });

  describe('deleteExchange', () => {
    it('should delete an exchange', async () => {
      const exchange: ConversationExchange = {
        id: 'test-delete',
        project: 'test-project',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test',
        assistantMessage: 'Response',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
      };

      const embedding = new Array(384).fill(0.1);
      await provider.insertExchange(exchange, embedding);

      await provider.deleteExchange('test-delete');

      const results = await provider.rawQuery(
        'SELECT id FROM exchanges WHERE id = $1',
        ['test-delete']
      );

      expect(results.length).toBe(0);
    });

    it('should cascade delete tool calls', async () => {
      const exchange: ConversationExchange = {
        id: 'test-cascade',
        project: 'test-project',
        timestamp: '2025-01-01T12:00:00Z',
        userMessage: 'Test',
        assistantMessage: 'Response',
        archivePath: '/test/path.jsonl',
        lineStart: 1,
        lineEnd: 2,
        toolCalls: [
          {
            id: 'tool-cascade',
            exchangeId: 'test-cascade',
            toolName: 'Read',
            isError: false,
            timestamp: '2025-01-01T12:00:01Z',
          },
        ],
      };

      const embedding = new Array(384).fill(0.1);
      await provider.insertExchange(exchange, embedding);
      await provider.deleteExchange('test-cascade');

      const toolCalls = await provider.rawQuery(
        'SELECT id FROM tool_calls WHERE exchange_id = $1',
        ['test-cascade']
      );

      expect(toolCalls.length).toBe(0);
    });
  });

  describe('searchByVector', () => {
    beforeEach(async () => {
      // Insert test data with different embeddings
      const exchanges = [
        {
          id: 'vec-1',
          project: 'project-a',
          userMessage: 'React component design',
          assistantMessage: 'Here is how to create React components',
          embedding: createEmbedding(0.1, 0.2, 0.3),
        },
        {
          id: 'vec-2',
          project: 'project-b',
          userMessage: 'Python data analysis',
          assistantMessage: 'Use pandas for data analysis',
          embedding: createEmbedding(0.4, 0.5, 0.6),
        },
        {
          id: 'vec-3',
          project: 'project-a',
          userMessage: 'React hooks tutorial',
          assistantMessage: 'React hooks are useful',
          embedding: createEmbedding(0.1, 0.2, 0.35),
        },
      ];

      for (const ex of exchanges) {
        await provider.insertExchange(
          {
            id: ex.id,
            project: ex.project,
            timestamp: '2025-01-01T12:00:00Z',
            userMessage: ex.userMessage,
            assistantMessage: ex.assistantMessage,
            archivePath: `/test/${ex.id}.jsonl`,
            lineStart: 1,
            lineEnd: 2,
          },
          ex.embedding
        );
      }
    });

    it('should return results ordered by similarity', async () => {
      // Search with embedding similar to vec-1 and vec-3 (React-related)
      const searchEmbedding = createEmbedding(0.1, 0.2, 0.32);
      const results = await provider.searchByVector(searchEmbedding, { limit: 3 });

      expect(results.length).toBe(3);
      // Results should be ordered by distance (lowest first = most similar)
      expect(results[0].distance).toBeLessThanOrEqual(results[1].distance);
      expect(results[1].distance).toBeLessThanOrEqual(results[2].distance);
    });

    it('should respect limit parameter', async () => {
      const searchEmbedding = createEmbedding(0.1, 0.2, 0.3);
      const results = await provider.searchByVector(searchEmbedding, { limit: 2 });

      expect(results.length).toBe(2);
    });

    it('should filter by date range', async () => {
      // Insert exchange with different date
      await provider.insertExchange(
        {
          id: 'vec-dated',
          project: 'project-c',
          timestamp: '2024-06-01T12:00:00Z',
          userMessage: 'Old message',
          assistantMessage: 'Old response',
          archivePath: '/test/old.jsonl',
          lineStart: 1,
          lineEnd: 2,
        },
        createEmbedding(0.1, 0.2, 0.3)
      );

      const searchEmbedding = createEmbedding(0.1, 0.2, 0.3);
      const results = await provider.searchByVector(searchEmbedding, {
        limit: 10,
        after: '2025-01-01',
      });

      // Should not include the old exchange
      const ids = results.map(r => r.id);
      expect(ids).not.toContain('vec-dated');
    });
  });

  describe('searchByText', () => {
    beforeEach(async () => {
      const exchanges = [
        { id: 'text-1', userMessage: 'How to use Docker', assistantMessage: 'Docker is a container platform' },
        { id: 'text-2', userMessage: 'Python basics', assistantMessage: 'Python is a programming language' },
        { id: 'text-3', userMessage: 'Docker compose tutorial', assistantMessage: 'Use docker-compose.yml' },
      ];

      for (const ex of exchanges) {
        await provider.insertExchange(
          {
            id: ex.id,
            project: 'test-project',
            timestamp: '2025-01-01T12:00:00Z',
            userMessage: ex.userMessage,
            assistantMessage: ex.assistantMessage,
            archivePath: `/test/${ex.id}.jsonl`,
            lineStart: 1,
            lineEnd: 2,
          },
          new Array(384).fill(0.1)
        );
      }
    });

    it('should find matches in user messages', async () => {
      const results = await provider.searchByText('Docker', { limit: 10 });

      expect(results.length).toBe(2);
      const ids = results.map(r => r.id);
      expect(ids).toContain('text-1');
      expect(ids).toContain('text-3');
    });

    it('should find matches in assistant messages', async () => {
      const results = await provider.searchByText('programming language', { limit: 10 });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('text-2');
    });

    it('should be case-insensitive', async () => {
      const lowerResults = await provider.searchByText('docker', { limit: 10 });
      const upperResults = await provider.searchByText('DOCKER', { limit: 10 });

      expect(lowerResults.length).toBe(upperResults.length);
    });

    it('should respect limit parameter', async () => {
      const results = await provider.searchByText('Docker', { limit: 1 });

      expect(results.length).toBe(1);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      const exchanges = [
        { id: 'stat-1', project: 'project-a', archivePath: '/test/conv1.jsonl', timestamp: '2025-01-01T12:00:00Z' },
        { id: 'stat-2', project: 'project-a', archivePath: '/test/conv1.jsonl', timestamp: '2025-01-02T12:00:00Z' },
        { id: 'stat-3', project: 'project-b', archivePath: '/test/conv2.jsonl', timestamp: '2025-01-03T12:00:00Z' },
        { id: 'stat-4', project: 'project-c', archivePath: '/test/conv3.jsonl', timestamp: '2025-01-04T12:00:00Z' },
      ];

      for (const ex of exchanges) {
        await provider.insertExchange(
          {
            id: ex.id,
            project: ex.project,
            timestamp: ex.timestamp,
            userMessage: 'Test',
            assistantMessage: 'Response',
            archivePath: ex.archivePath,
            lineStart: 1,
            lineEnd: 2,
          },
          new Array(384).fill(0.1)
        );
      }
    });

    it('should return total exchanges', async () => {
      const stats = await provider.getStats();

      expect(stats.totalExchanges).toBe(4);
    });

    it('should return total conversations (unique archive paths)', async () => {
      const stats = await provider.getStats();

      expect(stats.totalConversations).toBe(3);
    });

    it('should return project count', async () => {
      const stats = await provider.getStats();

      expect(stats.projectCount).toBe(3);
    });

    it('should return date range', async () => {
      const stats = await provider.getStats();

      expect(stats.dateRange).toBeDefined();
      // PostgreSQL returns dates in ISO format, check the date portion
      const earliest = new Date(stats.dateRange!.earliest);
      const latest = new Date(stats.dateRange!.latest);
      expect(earliest.toISOString()).toContain('2025-01-01');
      expect(latest.toISOString()).toContain('2025-01-04');
    });

    it('should return top projects', async () => {
      const stats = await provider.getStats();

      expect(stats.topProjects).toBeDefined();
      expect(stats.topProjects!.length).toBe(3);
      // project-a should be first (has 1 conversation)
      // All have 1 conversation each, so order depends on the query
    });
  });

  describe('hasExchangesForArchive', () => {
    it('should return true for existing archive', async () => {
      await provider.insertExchange(
        {
          id: 'archive-test',
          project: 'test',
          timestamp: '2025-01-01T12:00:00Z',
          userMessage: 'Test',
          assistantMessage: 'Response',
          archivePath: '/test/existing.jsonl',
          lineStart: 1,
          lineEnd: 2,
        },
        new Array(384).fill(0.1)
      );

      const result = await provider.hasExchangesForArchive('/test/existing.jsonl');

      expect(result).toBe(true);
    });

    it('should return false for non-existing archive', async () => {
      const result = await provider.hasExchangesForArchive('/test/nonexistent.jsonl');

      expect(result).toBe(false);
    });
  });

  describe('getAllExchanges', () => {
    it('should return all exchange ids and archive paths', async () => {
      await provider.insertExchange(
        {
          id: 'all-1',
          project: 'test',
          timestamp: '2025-01-01T12:00:00Z',
          userMessage: 'Test 1',
          assistantMessage: 'Response 1',
          archivePath: '/test/conv1.jsonl',
          lineStart: 1,
          lineEnd: 2,
        },
        new Array(384).fill(0.1)
      );
      await provider.insertExchange(
        {
          id: 'all-2',
          project: 'test',
          timestamp: '2025-01-01T12:00:00Z',
          userMessage: 'Test 2',
          assistantMessage: 'Response 2',
          archivePath: '/test/conv2.jsonl',
          lineStart: 1,
          lineEnd: 2,
        },
        new Array(384).fill(0.1)
      );

      const exchanges = await provider.getAllExchanges();

      expect(exchanges.length).toBe(2);
      expect(exchanges.map(e => e.id)).toContain('all-1');
      expect(exchanges.map(e => e.id)).toContain('all-2');
    });
  });
});

/**
 * Create a 384-dimensional embedding with specified first three values
 * and zeros for the rest
 */
function createEmbedding(v1: number, v2: number, v3: number): number[] {
  const embedding = new Array(384).fill(0);
  embedding[0] = v1;
  embedding[1] = v2;
  embedding[2] = v3;
  return embedding;
}
