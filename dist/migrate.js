import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { PostgresProvider } from './providers/postgres-provider.js';
import fs from 'fs';
/**
 * Migrate data from SQLite to PostgreSQL
 */
export async function migrateToPostgres(postgresUrl, options = {}) {
    const { batchSize = 100, dryRun = false, sqlitePath } = options;
    const dbPath = sqlitePath || getDbPath();
    // Check SQLite database exists
    if (!fs.existsSync(dbPath)) {
        throw new Error(`SQLite database not found at ${dbPath}`);
    }
    console.log(`Migration: SQLite -> PostgreSQL`);
    console.log(`Source: ${dbPath}`);
    console.log(`Target: ${postgresUrl.replace(/:([^:@]+)@/, ':***@')}`);
    if (dryRun)
        console.log(`Mode: DRY RUN (no changes will be made)`);
    console.log('');
    // Open SQLite database
    const sqliteDb = new Database(dbPath, { readonly: true });
    sqliteVec.load(sqliteDb);
    // Initialize PostgreSQL provider
    const pgConfig = {
        url: postgresUrl,
        poolSize: 10,
        ssl: false,
    };
    const pgProvider = new PostgresProvider(pgConfig);
    if (!dryRun) {
        await pgProvider.initialize();
    }
    try {
        // Count total exchanges
        const countResult = sqliteDb.prepare('SELECT COUNT(*) as count FROM exchanges').get();
        const totalExchanges = countResult.count;
        console.log(`Total exchanges to migrate: ${totalExchanges}`);
        // Get all exchanges with embeddings
        const exchangeStmt = sqliteDb.prepare(`
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
        e.thinking_triggers
      FROM exchanges e
      ORDER BY e.timestamp
    `);
        const vectorStmt = sqliteDb.prepare(`
      SELECT id, embedding FROM vec_exchanges WHERE id = ?
    `);
        const toolCallsStmt = sqliteDb.prepare(`
      SELECT id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp
      FROM tool_calls
      WHERE exchange_id = ?
    `);
        let processed = 0;
        let skipped = 0;
        let errors = 0;
        const allExchanges = exchangeStmt.all();
        for (let i = 0; i < allExchanges.length; i += batchSize) {
            const batch = allExchanges.slice(i, i + batchSize);
            for (const row of batch) {
                try {
                    // Get embedding
                    const vectorRow = vectorStmt.get(row.id);
                    if (!vectorRow) {
                        console.log(`  Skipping ${row.id} (no embedding)`);
                        skipped++;
                        continue;
                    }
                    // Convert Buffer to number array
                    const embedding = Array.from(new Float32Array(vectorRow.embedding.buffer));
                    // Get tool calls
                    const toolCallRows = toolCallsStmt.all(row.id);
                    const toolCalls = toolCallRows.map(tc => ({
                        id: tc.id,
                        exchangeId: tc.exchange_id,
                        toolName: tc.tool_name,
                        toolInput: tc.tool_input ? JSON.parse(tc.tool_input) : undefined,
                        toolResult: tc.tool_result || undefined,
                        isError: Boolean(tc.is_error),
                        timestamp: tc.timestamp,
                    }));
                    // Convert to ConversationExchange
                    const exchange = {
                        id: row.id,
                        project: row.project,
                        timestamp: row.timestamp,
                        userMessage: row.user_message,
                        assistantMessage: row.assistant_message,
                        archivePath: row.archive_path,
                        lineStart: row.line_start,
                        lineEnd: row.line_end,
                        parentUuid: row.parent_uuid || undefined,
                        isSidechain: Boolean(row.is_sidechain),
                        sessionId: row.session_id || undefined,
                        cwd: row.cwd || undefined,
                        gitBranch: row.git_branch || undefined,
                        claudeVersion: row.claude_version || undefined,
                        thinkingLevel: row.thinking_level || undefined,
                        thinkingDisabled: Boolean(row.thinking_disabled),
                        thinkingTriggers: row.thinking_triggers || undefined,
                        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                    };
                    if (!dryRun) {
                        await pgProvider.insertExchange(exchange, embedding);
                    }
                    processed++;
                }
                catch (error) {
                    console.error(`  Error migrating ${row.id}:`, error);
                    errors++;
                }
            }
            const progress = Math.round(((i + batch.length) / totalExchanges) * 100);
            console.log(`Progress: ${i + batch.length}/${totalExchanges} (${progress}%) - ${processed} migrated, ${skipped} skipped, ${errors} errors`);
        }
        console.log('');
        console.log('Migration complete!');
        console.log(`  Migrated: ${processed}`);
        console.log(`  Skipped: ${skipped}`);
        console.log(`  Errors: ${errors}`);
        if (dryRun) {
            console.log('\nThis was a dry run. No changes were made to PostgreSQL.');
            console.log('Run without --dry-run to perform the actual migration.');
        }
    }
    finally {
        sqliteDb.close();
        if (!dryRun) {
            await pgProvider.close();
        }
    }
}
/**
 * Verify migration by comparing counts
 */
export async function verifyMigration(postgresUrl, sqlitePath) {
    const dbPath = sqlitePath || getDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new Error(`SQLite database not found at ${dbPath}`);
    }
    console.log('Verifying migration...');
    console.log('');
    // Open SQLite database
    const sqliteDb = new Database(dbPath, { readonly: true });
    // Initialize PostgreSQL provider
    const pgConfig = {
        url: postgresUrl,
        poolSize: 5,
        ssl: false,
    };
    const pgProvider = new PostgresProvider(pgConfig);
    await pgProvider.initialize();
    try {
        // Compare counts
        const sqliteExchanges = sqliteDb.prepare('SELECT COUNT(*) as count FROM exchanges').get().count;
        const sqliteToolCalls = sqliteDb.prepare('SELECT COUNT(*) as count FROM tool_calls').get().count;
        const pgStats = await pgProvider.getStats();
        console.log('SQLite:');
        console.log(`  Exchanges: ${sqliteExchanges}`);
        console.log(`  Tool calls: ${sqliteToolCalls}`);
        console.log('');
        console.log('PostgreSQL:');
        console.log(`  Exchanges: ${pgStats.totalExchanges}`);
        const match = sqliteExchanges === pgStats.totalExchanges;
        console.log('');
        if (match) {
            console.log('Verification PASSED: Exchange counts match.');
        }
        else {
            console.log('Verification FAILED: Exchange counts do not match.');
            console.log(`  Missing: ${sqliteExchanges - pgStats.totalExchanges} exchanges`);
        }
        return match;
    }
    finally {
        sqliteDb.close();
        await pgProvider.close();
    }
}
