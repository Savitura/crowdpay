const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiDocs = fs.readFileSync(path.join(__dirname, '..', 'API.md'), 'utf8');

test('API docs describe worker lifecycle and configuration accurately', () => {
  assert.match(apiDocs, /startBackgroundWorkers\(\)/);
  assert.match(apiDocs, /WORKER_ENABLED=false/);
  assert.match(apiDocs, /NODE_ENV=test/);
  assert.match(apiDocs, /Production startup fails if every processor is disabled/);
});

test('API docs define accepted export requests and the supported status flow', () => {
  assert.match(apiDocs, /POST \/api\/users\/me\/exports/);
  assert.match(apiDocs, /GET \/api\/users\/me\/exports/);
  assert.match(apiDocs, /initially `pending`/);
  assert.match(apiDocs, /failed export must not be treated as downloadable/);
  assert.match(apiDocs, /another user's or unknown export returns `404`/);
  assert.match(apiDocs, /expired archive returns `410`/);
});

test('API docs do not misrepresent user exports as jobs claimed by the worker', () => {
  assert.match(apiDocs, /not persisted as a job for `src\/worker\.js` to claim/);
  assert.match(apiDocs, /does not expose a separate worker HTTP API or a generic job-status endpoint/);
});
