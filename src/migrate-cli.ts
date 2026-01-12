#!/usr/bin/env node
import { migrateToPostgres, verifyMigration } from './migrate.js';
import { getDatabaseConfig, isPostgresql } from './config.js';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');

  // Get PostgreSQL config from environment/config
  const dbConfig = getDatabaseConfig();

  if (!isPostgresql()) {
    console.error('Error: PostgreSQL is not configured.');
    console.error('Set EPISODIC_MEMORY_DB_PROVIDER=postgresql and EPISODIC_MEMORY_POSTGRES_URL');
    process.exit(1);
  }

  if (!dbConfig.postgresql?.url) {
    console.error('Error: PostgreSQL URL not configured.');
    console.error('Set EPISODIC_MEMORY_POSTGRES_URL environment variable');
    process.exit(1);
  }

  const postgresUrl = dbConfig.postgresql.url;

  try {
    if (verify) {
      const success = await verifyMigration(postgresUrl);
      process.exit(success ? 0 : 1);
    } else {
      await migrateToPostgres(postgresUrl, { dryRun });
      process.exit(0);
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main();
