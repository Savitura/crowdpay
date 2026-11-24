'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchWithTimeout, TimeoutError } = require('./fetchWithTimeout');

test('fetchWithTimeout succeeds on timely response', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/test`;

  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 1000 });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { ok: true });
  } finally {
    server.close();
  }
});

test('fetchWithTimeout throws TimeoutError when request exceeds timeoutMs', async () => {
  const server = http.createServer((_req, _res) => {
    // Deliberately hold connection open without responding
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/slow`;

  try {
    await assert.rejects(
      async () => {
        await fetchWithTimeout(url, { timeoutMs: 50 });
      },
      err => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.name, 'TimeoutError');
        assert.equal(err.code, 'ETIMEDOUT');
        assert.match(err.message, /timed out after 50ms/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test('fetchWithTimeout respects caller AbortSignal', async () => {
  const server = http.createServer((_req, _res) => {
    // Hold connection open
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/abort`;

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  try {
    await assert.rejects(
      async () => {
        await fetchWithTimeout(url, {
          timeoutMs: 5000,
          signal: controller.signal,
        });
      },
      err => {
        assert.ok(!(err instanceof TimeoutError));
        assert.equal(err.name, 'AbortError');
        return true;
      }
    );
  } finally {
    server.close();
  }
});
