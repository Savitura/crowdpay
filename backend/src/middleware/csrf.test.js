'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const {
  csrfProtection,
  ensureCsrfToken,
  generateCsrfToken,
  setCsrfCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_EXEMPT_PATHS,
  isExemptPath,
  isApiKeyRequest,
} = require('./csrf');

describe('CSRF middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      method: 'POST',
      originalUrl: '/api/test',
      url: '/api/test',
      headers: {},
      cookies: {},
    };
    res = {
      statusCode: 200,
      cookies: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
      cookie(name, value, options) {
        this.cookies[name] = { value, options };
      },
    };
    next = () => {};
  });

  describe('generateCsrfToken', () => {
    it('generates a token of correct length', () => {
      const token = generateCsrfToken();
      assert.strictEqual(token.length, 64); // 32 bytes = 64 hex chars
    });

    it('generates unique tokens', () => {
      const tokens = new Set();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateCsrfToken());
      }
      assert.strictEqual(tokens.size, 100);
    });
  });

  describe('setCsrfCookie', () => {
    it('sets cookie with correct options', () => {
      const mockRes = { cookie: () => {} };
      const cookieMock = mock.method(mockRes, 'cookie');
      setCsrfCookie(mockRes, 'test-token');
      const call = cookieMock.mock.calls[0];
      assert.strictEqual(call.arguments[0], CSRF_COOKIE_NAME);
      assert.strictEqual(call.arguments[1], 'test-token');
      assert.strictEqual(call.arguments[2].httpOnly, false);
      assert.strictEqual(call.arguments[2].sameSite, 'strict');
      assert.strictEqual(call.arguments[2].path, '/');
    });
  });

  describe('isExemptPath', () => {
    it('returns true for exact exempt paths', () => {
      assert.strictEqual(isExemptPath('/api/webhooks/kyc'), true);
      assert.strictEqual(isExemptPath('/api/webhooks/incoming'), true);
      assert.strictEqual(isExemptPath('/api/anchor/callbacks'), true);
      assert.strictEqual(isExemptPath('/api/anchor/sep24'), true);
    });

    it('returns false for sub-paths of exempt paths (no prefix matching)', () => {
      assert.strictEqual(isExemptPath('/api/webhooks/kyc/subpath'), false);
      assert.strictEqual(isExemptPath('/api/webhooks/incoming/extra'), false);
      assert.strictEqual(isExemptPath('/api/anchor/callbacks/extra'), false);
      assert.strictEqual(isExemptPath('/api/anchor/sep24/extra'), false);
    });

    it('returns false for non-exempt paths', () => {
      assert.strictEqual(isExemptPath('/api/campaigns'), false);
      assert.strictEqual(isExemptPath('/api/contributions'), false);
      assert.strictEqual(isExemptPath('/api/webhooks'), false);
    });
  });

  describe('isApiKeyRequest', () => {
    it('returns true for Bearer cpk_ token', () => {
      req.headers.authorization = 'Bearer cpk_test123';
      assert.strictEqual(isApiKeyRequest(req), true);
    });

    it('returns false for Bearer token without cpk_ prefix', () => {
      req.headers.authorization = 'Bearer some-other-token';
      assert.strictEqual(isApiKeyRequest(req), false);
    });

    it('returns false for missing authorization header', () => {
      req.headers.authorization = undefined;
      assert.strictEqual(isApiKeyRequest(req), false);
    });

    it('returns false for non-Bearer authorization', () => {
      req.headers.authorization = 'Basic dXNlcjpwYXNz';
      assert.strictEqual(isApiKeyRequest(req), false);
    });
  });

  describe('csrfProtection - safe methods (GET, HEAD, OPTIONS)', () => {
    it('sets CSRF cookie if missing on GET', async () => {
      req.method = 'GET';
      await new Promise((resolve) => {
        csrfProtection(req, res, () => {
          assert.ok(res.cookies[CSRF_COOKIE_NAME]);
          assert.strictEqual(req.csrfToken, res.cookies[CSRF_COOKIE_NAME].value);
          resolve();
        });
      });
    });

    it('uses existing CSRF cookie on GET', async () => {
      req.method = 'GET';
      req.cookies[CSRF_COOKIE_NAME] = 'existing-token';
      await new Promise((resolve) => {
        csrfProtection(req, res, () => {
          assert.strictEqual(req.csrfToken, 'existing-token');
          resolve();
        });
      });
    });
  });

  describe('csrfProtection - exempt paths', () => {
    it('allows exact exempt path without CSRF validation', async () => {
      req.originalUrl = '/api/webhooks/kyc';
      req.url = '/api/webhooks/kyc';
      req.cookies = {}; // No cookie
      req.headers[CSRF_HEADER_NAME] = undefined; // No header
      await new Promise((resolve) => {
        csrfProtection(req, res, () => {
          assert.strictEqual(res.statusCode, 200);
          resolve();
        });
      });
    });

    it('rejects sub-path of exempt path (no prefix matching)', async () => {
      req.originalUrl = '/api/webhooks/kyc/subpath';
      req.url = '/api/webhooks/kyc/subpath';
      req.cookies = {};
      req.headers[CSRF_HEADER_NAME] = undefined;
      // The middleware will return 403 directly without calling next()
      csrfProtection(req, res, () => {
        // This should not be called
        assert.fail('next() should not be called for rejected request');
      });
      // Check response was sent
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'CSRF validation failed. Please refresh the page and try again.');
    });
  });

  describe('csrfProtection - API key requests', () => {
    it('allows API key request without CSRF cookie', async () => {
      req.headers.authorization = 'Bearer cpk_test123';
      req.cookies = {};
      req.headers[CSRF_HEADER_NAME] = undefined;
      let nextCalled = false;
      csrfProtection(req, res, () => {
        nextCalled = true;
      });
      assert.strictEqual(nextCalled, true);
      assert.strictEqual(res.statusCode, 200);
    });

    it('allows API key request with mismatched CSRF header', async () => {
      req.headers.authorization = 'Bearer cpk_test123';
      req.cookies[CSRF_COOKIE_NAME] = 'cookie-token';
      req.headers[CSRF_HEADER_NAME] = 'different-header-token';
      let nextCalled = false;
      csrfProtection(req, res, () => {
        nextCalled = true;
      });
      assert.strictEqual(nextCalled, true);
      assert.strictEqual(res.statusCode, 200);
    });
  });

  describe('csrfProtection - state-changing requests with cookie', () => {
    it('allows valid double-submit (header matches cookie)', async () => {
      const token = 'valid-csrf-token';
      req.cookies[CSRF_COOKIE_NAME] = token;
      req.headers[CSRF_HEADER_NAME] = token;
      await new Promise((resolve) => {
        csrfProtection(req, res, () => {
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(req.csrfToken, token);
          resolve();
        });
      });
    });

    it('rejects missing header token', async () => {
      req.cookies[CSRF_COOKIE_NAME] = 'cookie-token';
      req.headers[CSRF_HEADER_NAME] = undefined;
      csrfProtection(req, res, () => {
        assert.fail('next() should not be called for rejected request');
      });
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'CSRF validation failed. Please refresh the page and try again.');
    });

    it('rejects mismatched header token', async () => {
      req.cookies[CSRF_COOKIE_NAME] = 'cookie-token';
      req.headers[CSRF_HEADER_NAME] = 'different-token';
      csrfProtection(req, res, () => {
        assert.fail('next() should not be called for rejected request');
      });
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'CSRF validation failed. Please refresh the page and try again.');
    });

    it('rejects request with no CSRF cookie (and not API key)', async () => {
      req.cookies = {};
      req.headers[CSRF_HEADER_NAME] = 'some-header-token';
      csrfProtection(req, res, () => {
        assert.fail('next() should not be called for rejected request');
      });
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'CSRF validation failed. Please refresh the page and try again.');
    });

    it('rejects request with no CSRF cookie and no header', async () => {
      req.cookies = {};
      req.headers[CSRF_HEADER_NAME] = undefined;
      csrfProtection(req, res, () => {
        assert.fail('next() should not be called for rejected request');
      });
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'CSRF validation failed. Please refresh the page and try again.');
    });
  });

  describe('ensureCsrfToken', () => {
    it('sets CSRF cookie if missing', async () => {
      req.cookies = {};
      await new Promise((resolve) => {
        ensureCsrfToken(req, res, () => {
          assert.ok(res.cookies[CSRF_COOKIE_NAME]);
          assert.strictEqual(req.csrfToken, res.cookies[CSRF_COOKIE_NAME].value);
          resolve();
        });
      });
    });

    it('uses existing CSRF cookie', async () => {
      req.cookies[CSRF_COOKIE_NAME] = 'existing-token';
      await new Promise((resolve) => {
        ensureCsrfToken(req, res, () => {
          assert.strictEqual(req.csrfToken, 'existing-token');
          resolve();
        });
      });
    });
  });

  describe('CSRF_EXEMPT_PATHS constant', () => {
    it('is a Set for O(1) lookup', () => {
      assert.ok(CSRF_EXEMPT_PATHS instanceof Set);
    });

    it('contains only exact paths', () => {
      for (const path of CSRF_EXEMPT_PATHS) {
        // Ensure no paths end with / that would act as prefix
        assert.ok(!path.endsWith('/') || path === '/api/webhooks/incoming' || path === '/api/anchor/callbacks' || path === '/api/anchor/sep24',
          `Path ${path} should not end with / unless it's an exact match`);
      }
    });
  });
});