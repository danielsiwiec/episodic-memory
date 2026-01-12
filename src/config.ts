import fs from 'fs';
import path from 'path';
import { getIndexDir, getDbPath } from './paths.js';

/**
 * Database provider types
 */
export type DatabaseProvider = 'sqlite' | 'postgresql';

/**
 * SQLite-specific configuration
 */
export interface SqliteConfig {
  path: string;
}

/**
 * PostgreSQL-specific configuration
 */
export interface PostgresConfig {
  url: string;
  poolSize: number;
  ssl: boolean;
}

/**
 * Complete database configuration
 */
export interface DatabaseConfig {
  provider: DatabaseProvider;
  sqlite?: SqliteConfig;
  postgresql?: PostgresConfig;
}

/**
 * Configuration file structure
 */
interface ConfigFile {
  database?: {
    provider?: DatabaseProvider;
    postgresql?: {
      url?: string;
      poolSize?: number;
      ssl?: boolean;
    };
  };
}

/**
 * Get the path to the config file
 */
export function getConfigPath(): string {
  return path.join(getIndexDir(), 'config.json');
}

/**
 * Load configuration from file if it exists
 */
function loadConfigFile(): ConfigFile | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ConfigFile;
  } catch (error) {
    console.warn(`Warning: Failed to parse config file at ${configPath}:`, error);
    return null;
  }
}

/**
 * Get database configuration with the following precedence:
 * 1. Environment variables (highest priority)
 * 2. Config file (~/.config/superpowers/conversation-index/config.json)
 * 3. Default (SQLite)
 *
 * Environment variables:
 * - EPISODIC_MEMORY_DB_PROVIDER: 'sqlite' | 'postgresql'
 * - EPISODIC_MEMORY_POSTGRES_URL: PostgreSQL connection URL
 * - EPISODIC_MEMORY_POSTGRES_POOL_SIZE: Connection pool size (default: 10)
 * - EPISODIC_MEMORY_POSTGRES_SSL: Enable SSL (default: false)
 */
export function getDatabaseConfig(): DatabaseConfig {
  // 1. Check environment variables (highest priority)
  const envProvider = process.env.EPISODIC_MEMORY_DB_PROVIDER as DatabaseProvider | undefined;

  if (envProvider === 'postgresql') {
    const url = process.env.EPISODIC_MEMORY_POSTGRES_URL;
    if (!url) {
      throw new Error(
        'EPISODIC_MEMORY_POSTGRES_URL is required when EPISODIC_MEMORY_DB_PROVIDER=postgresql'
      );
    }

    return {
      provider: 'postgresql',
      postgresql: {
        url,
        poolSize: parseInt(process.env.EPISODIC_MEMORY_POSTGRES_POOL_SIZE || '10', 10),
        ssl: process.env.EPISODIC_MEMORY_POSTGRES_SSL === 'true',
      },
    };
  }

  if (envProvider === 'sqlite') {
    return {
      provider: 'sqlite',
      sqlite: {
        path: getDbPath(),
      },
    };
  }

  // 2. Check config file (second priority)
  const configFile = loadConfigFile();
  if (configFile?.database?.provider === 'postgresql') {
    const pgConfig = configFile.database.postgresql;
    if (!pgConfig?.url) {
      throw new Error(
        'PostgreSQL URL is required in config file when provider is postgresql'
      );
    }

    return {
      provider: 'postgresql',
      postgresql: {
        url: pgConfig.url,
        poolSize: pgConfig.poolSize ?? 10,
        ssl: pgConfig.ssl ?? false,
      },
    };
  }

  // 3. Default to SQLite
  return {
    provider: 'sqlite',
    sqlite: {
      path: getDbPath(),
    },
  };
}

/**
 * Check if using PostgreSQL
 */
export function isPostgresql(): boolean {
  return getDatabaseConfig().provider === 'postgresql';
}

/**
 * Check if using SQLite
 */
export function isSqlite(): boolean {
  return getDatabaseConfig().provider === 'sqlite';
}

/**
 * Get a human-readable description of the current database configuration
 */
export function getConfigDescription(): string {
  const config = getDatabaseConfig();

  if (config.provider === 'postgresql') {
    // Mask password in URL for display
    const url = config.postgresql!.url;
    const maskedUrl = url.replace(/:([^:@]+)@/, ':***@');
    return `PostgreSQL: ${maskedUrl} (pool: ${config.postgresql!.poolSize}, ssl: ${config.postgresql!.ssl})`;
  }

  return `SQLite: ${config.sqlite!.path}`;
}
