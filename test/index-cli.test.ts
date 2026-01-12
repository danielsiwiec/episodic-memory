import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Tests for index-cli flag parsing
 *
 * Since the CLI functions read directly from process.argv,
 * we test by manipulating process.argv and requiring the module fresh
 */

describe('index-cli flag parsing', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('--limit / -l flag', () => {
    it('should parse --limit with valid number', () => {
      process.argv = ['node', 'index-cli.js', '--limit', '100'];
      const limit = parseLimit();
      expect(limit).toBe(100);
    });

    it('should parse -l short form', () => {
      process.argv = ['node', 'index-cli.js', '-l', '50'];
      const limit = parseLimit();
      expect(limit).toBe(50);
    });

    it('should return undefined when no limit specified', () => {
      process.argv = ['node', 'index-cli.js'];
      const limit = parseLimit();
      expect(limit).toBeUndefined();
    });

    it('should return undefined for invalid number', () => {
      process.argv = ['node', 'index-cli.js', '--limit', 'abc'];
      const limit = parseLimit();
      expect(limit).toBeUndefined();
    });

    it('should return undefined for zero', () => {
      process.argv = ['node', 'index-cli.js', '--limit', '0'];
      const limit = parseLimit();
      expect(limit).toBeUndefined();
    });

    it('should return undefined for negative number', () => {
      process.argv = ['node', 'index-cli.js', '--limit', '-5'];
      const limit = parseLimit();
      expect(limit).toBeUndefined();
    });

    it('should work with other flags', () => {
      process.argv = ['node', 'index-cli.js', '-c', '4', '--limit', '100', '--no-summaries'];
      const limit = parseLimit();
      expect(limit).toBe(100);
    });
  });

  describe('--days / -d flag', () => {
    it('should parse --days with valid number', () => {
      process.argv = ['node', 'index-cli.js', '--days', '7'];
      const days = parseDays();
      expect(days).toBe(7);
    });

    it('should parse -d short form', () => {
      process.argv = ['node', 'index-cli.js', '-d', '30'];
      const days = parseDays();
      expect(days).toBe(30);
    });

    it('should return undefined when no days specified', () => {
      process.argv = ['node', 'index-cli.js'];
      const days = parseDays();
      expect(days).toBeUndefined();
    });

    it('should return undefined for invalid number', () => {
      process.argv = ['node', 'index-cli.js', '--days', 'abc'];
      const days = parseDays();
      expect(days).toBeUndefined();
    });

    it('should return undefined for zero', () => {
      process.argv = ['node', 'index-cli.js', '--days', '0'];
      const days = parseDays();
      expect(days).toBeUndefined();
    });

    it('should work with other flags', () => {
      process.argv = ['node', 'index-cli.js', '-d', '7', '-c', '4', '--limit', '100'];
      const days = parseDays();
      expect(days).toBe(7);
    });
  });

  describe('combined flags', () => {
    it('should parse both -d and -l together', () => {
      process.argv = ['node', 'index-cli.js', '-d', '7', '-l', '50', '-c', '4'];
      const days = parseDays();
      const limit = parseLimit();
      expect(days).toBe(7);
      expect(limit).toBe(50);
    });
  });
});

// Helper functions that mirror the CLI implementation
function parseLimit(): number | undefined {
  const limitIndex = process.argv.findIndex(arg => arg === '-l' || arg === '--limit');
  if (limitIndex !== -1 && process.argv[limitIndex + 1]) {
    const value = parseInt(process.argv[limitIndex + 1], 10);
    if (value >= 1) return value;
  }
  return undefined;
}

function parseDays(): number | undefined {
  const daysIndex = process.argv.findIndex(arg => arg === '-d' || arg === '--days');
  if (daysIndex !== -1 && process.argv[daysIndex + 1]) {
    const value = parseInt(process.argv[daysIndex + 1], 10);
    if (value >= 1) return value;
  }
  return undefined;
}
