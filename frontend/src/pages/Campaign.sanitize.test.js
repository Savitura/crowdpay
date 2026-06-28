import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';

describe('campaign markdown XSS sanitization', () => {
  it('strips script tags', () => {
    const payload = '<script>alert("xss")</script>Safe text';
    expect(DOMPurify.sanitize(payload)).not.toContain('<script>');
    expect(DOMPurify.sanitize(payload)).toContain('Safe text');
  });

  it('strips event handler attributes injected via href attribute breakout', () => {
    // Simulates the attribute-injection vector: [text](https://x.com" onmouseover="alert(1))
    // After markdownToHtml processes escaped input, the resulting <a> tag would be:
    // <a href="https://x.com&quot; onmouseover=&quot;alert(1)" ...>
    // which browsers decode to a live event handler — DOMPurify must strip it.
    const payload = '<a href="https://x.com" onmouseover="alert(1)">click</a>';
    const sanitized = DOMPurify.sanitize(payload);
    expect(sanitized).not.toContain('onmouseover');
    expect(sanitized).toContain('href');
  });

  it('strips javascript: protocol from links', () => {
    const payload = '<a href="javascript:alert(1)">click</a>';
    expect(DOMPurify.sanitize(payload)).not.toContain('javascript:');
  });

  it('preserves safe markdown-derived HTML elements', () => {
    const safe = '<h1>Title</h1><h2>Sub</h2><strong>bold</strong><em>italic</em><br />';
    const sanitized = DOMPurify.sanitize(safe);
    expect(sanitized).toContain('<h1>');
    expect(sanitized).toContain('<strong>');
    expect(sanitized).toContain('<em>');
  });

  it('preserves safe external links', () => {
    const safe = '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>';
    const sanitized = DOMPurify.sanitize(safe);
    expect(sanitized).toContain('href="https://example.com"');
  });
});
