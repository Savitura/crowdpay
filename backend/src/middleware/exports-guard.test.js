'use strict';

/**
 * exports-guard.test.js
 *
 * Guard test that asserts every rate limiter exported from middleware/rateLimiter.js
 * is imported somewhere in the codebase. This prevents unused exports like
 * the previous impactStatsLimiter from going unnoticed.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..');

// Files to exclude from the search (test files, etc.)
const EXCLUDE_PATTERNS = [/\.test\.js$/, /\.spec\.js$/, /node_modules/, /dist/, /coverage/];

/**
 * Recursively find all .js files in a directory
 */
function findJsFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const shouldExclude = EXCLUDE_PATTERNS.some(pattern => pattern.test(fullPath));
      if (!shouldExclude) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Extract exported names from a module.exports = { ... } statement
 */
function getModuleExports(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const exports = [];

  // Match module.exports = { name1, name2 }
  const moduleExportsMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (moduleExportsMatch) {
    const exportList = moduleExportsMatch[1];
    exportList.split(',').forEach(name => {
      const trimmed = name.trim();
      if (trimmed) exports.push(trimmed);
    });
  }

  return exports;
}

/**
 * Check if a name is imported anywhere in the codebase
 */
function isImported(name, sourceFiles) {
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, 'utf8');
    // Match various import patterns:
    // - const { name } = require('...')
    // - const name = require('...').name
    // - import { name } from '...'
    // - require('...').name
    const patterns = [
      new RegExp(`\\{\\s*${name}\\s*\\}`), // { name } in destructuring
      new RegExp(`require\\([^)]+\\.${name}`), // require('...').name
      new RegExp(`import\\s+\\{\\s*${name}\\s*\\}`), // import { name }
      new RegExp(`from\\s+['"][^'"]+['"]`), // import from
    ];
    // Check for the specific export in require/import context
    if (content.includes(name)) {
      // More specific checks
      const hasDestructuring = new RegExp(`\\{\\s*${name}\\s*\\}`).test(content);
      const hasRequireAccess = new RegExp(`require\\([^)]+\\.${name}`).test(content);
      const hasImport = new RegExp(`import\\s+\\{\\s*${name}\\s*\\}`).test(content);
      const hasDefaultImport = new RegExp(`require\\([^)]+\\)\\.${name}`).test(content);

      if (hasDestructuring || hasRequireAccess || hasImport || hasDefaultImport) {
        // Additional check: make sure it's from the right module
        if (content.includes('rateLimiter') || content.includes('rate-limiter')) {
          return true;
        }
      }
    }
  }
  return false;
}

describe('Rate limiter exports guard', () => {
  let sourceFiles;

  before(() => {
    sourceFiles = findJsFiles(SRC_DIR);
  });

  it('every exported rate limiter from middleware/rateLimiter.js is imported somewhere', () => {
    const rateLimiterPath = path.join(__dirname, 'rateLimiter.js');
    const exports = getModuleExports(rateLimiterPath);
    const unusedExports = [];

    for (const exportName of exports) {
      if (!isImported(exportName, sourceFiles)) {
        unusedExports.push(exportName);
      }
    }

    if (unusedExports.length > 0) {
      assert.fail(
        `Unused rate limiter exports found in middleware/rateLimiter.js:\n${unusedExports.join('\n')}`
      );
    }
  });
});
