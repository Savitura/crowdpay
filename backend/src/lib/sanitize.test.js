const test = require('node:test');
const assert = require('node:assert/strict');
const { stripHtml } = require('./sanitize');

test('stripHtml removes HTML tags', () => {
  assert.equal(stripHtml('<b>hello</b>'), 'hello');
  assert.equal(stripHtml('<p>a</p><p>b</p>'), 'ab');
});

test('stripHtml strips script tags and their angle brackets', () => {
  assert.equal(stripHtml('<script>alert(1)</script>safe'), 'alert(1)safe');
  assert.equal(stripHtml('<img src=x onerror=alert(1)>'), '');
});

test('stripHtml trims surrounding whitespace', () => {
  assert.equal(stripHtml('  spaced  '), 'spaced');
  assert.equal(stripHtml('<div>  padded  </div>'), 'padded');
});

test('stripHtml leaves plain text unchanged', () => {
  assert.equal(stripHtml('just text'), 'just text');
});

test('stripHtml coerces non-string input', () => {
  assert.equal(stripHtml(123), '123');
  assert.equal(stripHtml(0), '0');
});

test('stripHtml handles missing and nullish input', () => {
  assert.equal(stripHtml(), '');
  assert.equal(stripHtml(null), 'null');
  assert.equal(stripHtml(undefined), '');
});

test('stripHtml preserves inner text content of nested tags', () => {
  assert.equal(stripHtml('<a href="x"><span>link</span></a>'), 'link');
});
