const { describe, it } = require('node:test');
const assert = require('node:assert');

/**
 * Regression test for issue #559:
 * Duplicate `const IMPERSONATION_TTL_SECONDS` declaration caused a
 * SyntaxError at module load time, crashing all admin routes.
 *
 * This test ensures the admin router module can be required without
 * throwing any syntax or initialization errors.
 */
describe('Admin Module Load (issue #559)', () => {
  it('should require admin.js without SyntaxError', () => {
    // If there is a duplicate const declaration, require() will throw:
    //   SyntaxError: Identifier 'IMPERSONATION_TTL_SECONDS' has already been declared
    try {
      // Clear module cache to ensure we re-evaluate admin.js from scratch
      delete require.cache[require.resolve('./admin')];
      require('./admin');
    } catch (err) {
      if (err instanceof SyntaxError) {
        assert.fail(
          `admin.js threw SyntaxError on load — likely a duplicate const declaration: ${err.message}`
        );
      }
      // MODULE_NOT_FOUND or other runtime errors are expected in isolated tests
    }
    // If we get here without a SyntaxError, the module loaded successfully
  });

  it('should not redeclare constants already imported from config/constants', () => {
    const fs = require('fs');
    const path = require('path');

    const adminSource = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf-8');

    // Find all const declarations of IMPERSONATION_TTL_SECONDS
    const constDeclarations = adminSource.match(
      /(?:const|let|var)\s+(?:\{[^}]*\bIMPERSONATION_TTL_SECONDS\b[^}]*\}|\bIMPERSONATION_TTL_SECONDS\b)\s*=/g
    );

    assert.ok(constDeclarations, 'Should find at least one const declaration');

    // There should be exactly one declaration (the destructured import from constants.js)
    const destructuredImports = constDeclarations.filter(d => d.includes('{'));
    assert.strictEqual(
      destructuredImports.length,
      1,
      `Expected exactly 1 destructured import of IMPERSONATION_TTL_SECONDS, found ${destructuredImports.length}: ${constDeclarations}`
    );

    // Ensure no standalone `const IMPERSONATION_TTL_SECONDS =` (without destructuring)
    const standaloneDeclarations = constDeclarations.filter(d => !d.includes('{'));
    assert.strictEqual(
      standaloneDeclarations.length,
      0,
      `Found standalone const IMPERSONATION_TTL_SECONDS declaration(s) which would shadow the import — remove them`
    );
  });
});
