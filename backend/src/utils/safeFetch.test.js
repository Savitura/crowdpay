const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const proxyquire = require('proxyquire').noCallThru();
const { safeFetch, SsrfBlockedError, pinnedLookup } = require('./safeFetch');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Real pinned requests against a local server (localhost is allowed for HTTP
// outside production, so these exercise the actual connection/pinning code
// path rather than mocking it away).
// ---------------------------------------------------------------------------

test('safeFetch performs a real pinned request and returns the response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    },
    async baseUrl => {
      const res = await safeFetch(`${baseUrl}/ok`, { method: 'GET' });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(await res.text(), 'hello');
    }
  );
});

test('safeFetch sends the request body and custom headers', async () => {
  await withServer(
    (req, res) => {
      let received = '';
      req.on('data', chunk => {
        received += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'X-Echo-Signature': req.headers['x-crowdpay-signature'] || '' });
        res.end(received);
      });
    },
    async baseUrl => {
      const res = await safeFetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'X-CrowdPay-Signature': 'sha256=abc' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(res.headers['x-echo-signature'], 'sha256=abc');
      assert.equal(await res.text(), JSON.stringify({ hello: 'world' }));
    }
  );
});

test('safeFetch follows a redirect to a public/allowed target', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('final destination');
    },
    async baseUrl => {
      const res = await safeFetch(`${baseUrl}/start`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'final destination');
    }
  );
});

test('safeFetch rejects a redirect to a private/internal target instead of following it', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
    },
    async baseUrl => {
      await assert.rejects(
        () => safeFetch(`${baseUrl}/start`),
        err => {
          assert.ok(err instanceof SsrfBlockedError);
          assert.match(err.message, /private\/internal/);
          return true;
        }
      );
    }
  );
});

test('safeFetch rejects a redirect to a plain-http target the same way a direct request to it would be', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    },
    async baseUrl => {
      await assert.rejects(
        () => safeFetch(`${baseUrl}/start`),
        err => {
          assert.ok(err instanceof SsrfBlockedError);
          assert.match(err.message, /HTTP is only allowed for localhost/);
          return true;
        }
      );
    }
  );
});

test('safeFetch gives up after too many redirects', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: req.url });
      res.end();
    },
    async baseUrl => {
      await assert.rejects(
        () => safeFetch(`${baseUrl}/loop`, { maxRedirects: 2 }),
        err => {
          assert.ok(err instanceof SsrfBlockedError);
          assert.match(err.message, /too many redirects/);
          return true;
        }
      );
    }
  );
});

test('safeFetch rejects the initial URL outright when it is unsafe, without connecting', async () => {
  await assert.rejects(
    () => safeFetch('http://169.254.169.254/'),
    err => {
      assert.ok(err instanceof SsrfBlockedError);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// DNS-level scenarios: mixed answers and resolution pinning, via a mocked
// resolver (real DNS can't be made to return attacker-controlled answers).
// ---------------------------------------------------------------------------

function buildSafeFetchWithMockedDns(dnsLookupImpl) {
  const ssrfGuard = proxyquire('./ssrfGuard', {
    dns: { promises: { lookup: dnsLookupImpl } },
    '../config/logger': { warn: () => {}, error: () => {}, info: () => {} },
  });
  return proxyquire('./safeFetch', { './ssrfGuard': ssrfGuard });
}

test('safeFetch rejects a hostname with mixed public/private DNS answers', async () => {
  const dnsLookupImpl = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ];
  const { safeFetch: mockedSafeFetch, SsrfBlockedError: MockedError } =
    buildSafeFetchWithMockedDns(dnsLookupImpl);

  await assert.rejects(
    () => mockedSafeFetch('https://attacker-controlled.example/'),
    err => {
      assert.ok(err instanceof MockedError);
      assert.match(err.message, /private\/internal/);
      return true;
    }
  );
});

test('safeFetch resolves DNS exactly once per hop and pins the connection to that answer (no re-resolution at connect time)', async () => {
  let lookupCalls = 0;
  const dnsLookupImpl = async () => {
    lookupCalls += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const { safeFetch: mockedSafeFetch } = buildSafeFetchWithMockedDns(dnsLookupImpl);

  // A non-IP hostname exercises the DNS-resolution branch (raw-IP and
  // localhost-literal hostnames both skip it entirely). The actual TCP
  // connect is expected to fail here — nothing real is listening on the
  // pinned port — the point is proving `dns.lookup` is consulted exactly
  // once by the validate+pin step and never again for the connection
  // itself (Node's custom `lookup` on the request options satisfies the
  // connect without a second resolution).
  await assert.rejects(() => mockedSafeFetch('https://example-under-test.invalid:1/'));
  assert.equal(
    lookupCalls,
    1,
    'DNS should be resolved exactly once, not re-resolved at connect time'
  );
});

test('safeFetch rejects when DNS resolution fails entirely', async () => {
  const dnsLookupImpl = async () => {
    throw new Error('ENOTFOUND');
  };
  const { safeFetch: mockedSafeFetch, SsrfBlockedError: MockedError } =
    buildSafeFetchWithMockedDns(dnsLookupImpl);

  await assert.rejects(
    () => mockedSafeFetch('https://does-not-resolve.example/'),
    err => {
      assert.ok(err instanceof MockedError);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Pinned lookup contract (Node 20+ calls `lookup` with `{ all: true }` when
// auto-family-selection is active), Host/SNI preservation, and per-redirect
// re-resolution. Without the array branch the socket errors before connecting
// and the pin is never applied (#1127).
// ---------------------------------------------------------------------------

test('pinnedLookup returns an address array when Node requests all results', () => {
  const lookup = pinnedLookup('203.0.113.7', 4);
  let result;
  lookup('hooks.example.test', { all: true }, (err, addresses) => {
    result = { err, addresses };
  });

  assert.deepEqual(result, {
    err: null,
    addresses: [{ address: '203.0.113.7', family: 4 }],
  });
});

test('pinnedLookup returns a single address/family when all results are not requested', () => {
  const lookup = pinnedLookup('203.0.113.7', '4');
  let result;
  lookup('hooks.example.test', {}, (err, address, family) => {
    result = { err, address, family };
  });

  assert.deepEqual(result, { err: null, address: '203.0.113.7', family: 4 });
});

test('safeFetch pins a hostname endpoint and preserves the original Host header', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'X-Received-Host': req.headers.host || '' });
      res.end('pinned');
    },
    async (_baseUrl, port) => {
      const res = await safeFetch(`http://localhost:${port}/hook`);

      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'pinned');
      assert.equal(res.headers['x-received-host'], `localhost:${port}`);
    }
  );
});

test('pinned HTTPS requests preserve the Host header and TLS SNI', async () => {
  let captured;
  const fakeRequest = {
    handlers: {},
    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    },
    write() {},
    end() {
      setImmediate(() => this.handlers.error(new Error('stop after capture')));
    },
  };
  const fakeHttps = {
    request(options) {
      captured = options;
      return fakeRequest;
    },
  };
  const fakeSsrfGuard = {
    resolveSafeConnectTarget: async () => ({
      safe: true,
      reason: '',
      hostname: 'hooks.example.test',
      pinnedAddress: '203.0.113.7',
      family: 4,
    }),
  };
  const { safeFetch: mockedSafeFetch } = proxyquire('./safeFetch', {
    './ssrfGuard': fakeSsrfGuard,
    https: fakeHttps,
  });

  await assert.rejects(
    () =>
      mockedSafeFetch('https://hooks.example.test/hook', {
        method: 'POST',
        headers: { 'X-CrowdPay-Signature': 'v1=abc' },
        body: '{}',
      }),
    /stop after capture/
  );

  assert.equal(captured.hostname, 'hooks.example.test');
  assert.equal(captured.headers.Host, 'hooks.example.test');
  assert.equal(captured.servername, 'hooks.example.test');

  const all = await new Promise(resolve =>
    captured.lookup('hooks.example.test', { all: true }, (err, addresses) =>
      resolve({ err, addresses })
    )
  );
  assert.deepEqual(all, {
    err: null,
    addresses: [{ address: '203.0.113.7', family: 4 }],
  });

  const single = await new Promise(resolve =>
    captured.lookup('hooks.example.test', {}, (err, address, family) =>
      resolve({ err, address, family })
    )
  );
  assert.deepEqual(single, { err: null, address: '203.0.113.7', family: 4 });
});

test('every 3xx redirect re-resolves DNS and pins the new target address', async () => {
  const resolutions = [];
  const fakeSsrfGuard = {
    resolveSafeConnectTarget: async url => {
      resolutions.push(url);
      return {
        safe: true,
        reason: '',
        hostname: new URL(url).hostname,
        pinnedAddress: resolutions.length === 1 ? '203.0.113.10' : '203.0.113.20',
        family: 4,
      };
    },
  };

  const calls = [];
  const fakeHttp = {
    request(options, onResponse) {
      const call = { options, onResponse };
      calls.push(call);

      return {
        on() {
          return this;
        },
        write() {},
        end() {
          const res = new EventEmitter();
          if (calls.length === 1) {
            res.statusCode = 302;
            res.headers = { location: 'http://second.example/final' };
          } else {
            res.statusCode = 200;
            res.headers = {};
          }
          onResponse(res);
          res.emit('end');
        },
      };
    },
  };
  const { safeFetch: mockedSafeFetch } = proxyquire('./safeFetch', {
    './ssrfGuard': fakeSsrfGuard,
    http: fakeHttp,
  });

  const res = await mockedSafeFetch('http://first.example/start');
  assert.equal(res.status, 200);
  assert.deepEqual(resolutions, ['http://first.example/start', 'http://second.example/final']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Host, 'first.example');
  assert.equal(calls[1].options.headers.Host, 'second.example');

  const firstPin = await new Promise(resolve =>
    calls[0].options.lookup('first.example', { all: true }, (_err, addresses) => resolve(addresses))
  );
  const secondPin = await new Promise(resolve =>
    calls[1].options.lookup('second.example', { all: true }, (_err, addresses) =>
      resolve(addresses)
    )
  );
  assert.deepEqual(firstPin, [{ address: '203.0.113.10', family: 4 }]);
  assert.deepEqual(secondPin, [{ address: '203.0.113.20', family: 4 }]);
});
