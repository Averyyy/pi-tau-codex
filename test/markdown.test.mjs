import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/markdown.js', import.meta.url), 'utf8');
const markdown = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('renders Markdown formatting while escaping stored HTML', () => {
  const html = markdown.renderMarkdown('**bold** <img src=x onerror=alert(1)>');

  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('only emits links for safe protocols', () => {
  const safe = markdown.renderMarkdown('[docs](https://example.com/a?x=1&y=2)');
  const javascript = markdown.renderMarkdown('[run](javascript:alert(1))');
  const data = markdown.renderMarkdown('[run](data:text/html;base64,PHNjcmlwdD4=)');

  assert.match(safe, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  assert.match(safe, /rel="noopener noreferrer"/);
  assert.doesNotMatch(javascript, /<a /);
  assert.doesNotMatch(data, /<a /);
  assert.match(javascript, /javascript:alert/);
});

test('keeps code and image Markdown safe', () => {
  const code = markdown.renderMarkdown('`<script>alert(1)</script>`');
  const image = markdown.renderMarkdown('![preview](https://example.com/preview.png)');
  const unsafeImage = markdown.renderMarkdown('![preview](javascript:alert(1))');

  assert.match(code, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
  assert.match(image, /<img src="https:\/\/example\.com\/preview\.png" alt="preview" class="inline-image">/);
  assert.doesNotMatch(unsafeImage, /<img /);
});

test('accepts raster image payloads and rejects executable data URLs', () => {
  assert.equal(
    markdown.sanitizeImageSource({ mimeType: 'image/png', data: 'aGVsbG8=' }),
    'data:image/png;base64,aGVsbG8=',
  );
  assert.equal(markdown.sanitizeImageSource({ data: 'data:image/svg+xml;base64,PHN2Zz4=' }), null);
  assert.equal(markdown.sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(markdown.sanitizeUrl('mailto:hello@example.com'), 'mailto:hello@example.com');
});
