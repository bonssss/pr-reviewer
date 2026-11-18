import { describe, expect, it } from 'vitest';
import { escapeHtml, isSafeUrl, sanitizeUrl } from '../../frontend/sanitize.js';

describe('Dashboard frontend sanitizers', () => {
  describe('escapeHtml', () => {
    it('escapes every HTML metacharacter', () => {
      expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#039;'
      );
    });

    it('keeps ordinary text untouched', () => {
      expect(escapeHtml('Reviewed 3 files — no issues')).toBe('Reviewed 3 files — no issues');
    });

    it('handles null, undefined and non-string values', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml(42)).toBe('42');
    });

    it('neutralises an attribute-breaking payload', () => {
      const escaped = escapeHtml('" onmouseover="alert(1)');
      expect(escaped).not.toContain('"');
      expect(escaped).toContain('&quot;');
    });
  });

  describe('sanitizeUrl', () => {
    it('allows absolute https URLs', () => {
      expect(sanitizeUrl('https://github.com/acme/repo/pull/1')).toBe(
        'https://github.com/acme/repo/pull/1'
      );
    });

    it('rejects javascript and data URLs', () => {
      expect(sanitizeUrl('javascript:alert(1)')).toBe('');
      expect(sanitizeUrl('JavaScript:alert(1)')).toBe('');
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    });

    it('rejects plain http and protocol-relative URLs', () => {
      expect(sanitizeUrl('http://example.com')).toBe('');
      expect(sanitizeUrl('//example.com/path')).toBe('');
    });

    it('rejects empty and malformed values', () => {
      expect(sanitizeUrl('')).toBe('');
      expect(sanitizeUrl('   ')).toBe('');
      expect(sanitizeUrl('not a url')).toBe('');
      expect(sanitizeUrl(null)).toBe('');
    });

    it('reports safety consistently', () => {
      expect(isSafeUrl('https://github.com/acme')).toBe(true);
      expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    });
  });
});
