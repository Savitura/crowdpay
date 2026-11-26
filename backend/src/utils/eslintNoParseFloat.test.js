const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const ESLINT_CONFIG_PATH = path.join(BACKEND_ROOT, 'eslint.config.cjs');

function createLinter() {
  return new ESLint({
    cwd: BACKEND_ROOT,
    overrideConfigFile: ESLINT_CONFIG_PATH,
  });
}

async function lintSnippet(code, relativeFilePath = 'src/services/sampleMonetaryService.js') {
  const eslint = createLinter();
  const [result] = await eslint.lintText(code, {
    filePath: path.join(BACKEND_ROOT, relativeFilePath),
  });
  return result.messages.filter(m => m.ruleId === 'no-restricted-syntax');
}

test('bans direct and member-expression parseFloat calls in new and migrated backend files', async () => {
  const cases = [
    "const amount = parseFloat('8.29');\nmodule.exports = amount;\n",
    "const amount = Number.parseFloat('8.29');\nmodule.exports = amount;\n",
    "const amount = globalThis.parseFloat('8.29');\nmodule.exports = amount;\n",
    "const amount = Number['parseFloat']('8.29');\nmodule.exports = amount;\n",
    "const amounts = ['8.29', '19.99'].map(parseFloat);\nmodule.exports = amounts;\n",
  ];

  for (const snippet of cases) {
    const hits = await lintSnippet(snippet, 'src/services/ledgerMonitor.js');
    assert.equal(hits.length, 1, `expected 1 diagnostic for snippet:\n${snippet}`);
    assert.equal(hits[0].severity, 2, 'expected error severity');
    assert.match(hits[0].message, /stroops\.js/);
  }
});

test('allows exact stroops helpers and non-float numeric parsing', async () => {
  const snippet = [
    "const { toStroops, fromStroops, compareAmounts } = require('./stroops');",
    "const stroops = toStroops('8.29');",
    'const formatted = fromStroops(stroops);',
    "const cmp = compareAmounts(formatted, '8.29');",
    "const count = Number.parseInt('42', 10);",
    'module.exports = { stroops, formatted, cmp, count };',
    '',
  ].join('\n');

  const hits = await lintSnippet(snippet);
  assert.deepEqual(hits, []);
});

test('warns on legacy unmigrated files and allows intentional float-bug tests in stroops.test.js', async () => {
  const snippet = "const legacy = parseFloat('1.23');\nmodule.exports = legacy;\n";

  const legacyHits = await lintSnippet(snippet, 'src/services/contributionPolicy.js');
  assert.equal(legacyHits.length, 1);
  assert.equal(legacyHits[0].severity, 1, 'expected warning severity on legacy file');
  assert.match(legacyHits[0].message, /stroops\.js/);

  const stroopsTestHits = await lintSnippet(snippet, 'src/utils/stroops.test.js');
  assert.deepEqual(stroopsTestHits, []);
});
