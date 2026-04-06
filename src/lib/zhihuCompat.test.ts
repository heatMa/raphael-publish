import { describe, it, expect, vi } from 'vitest';
import { makeZhihuCompatible } from './zhihuCompat';

// makeZhihuCompatible may call uploadToImgbb for data URIs when an API key is given.
// We test without an API key so no network requests are made.
const NO_KEY = '';

describe('makeZhihuCompatible', () => {
    it('strips data-md-type and data-md-index attributes', async () => {
        const html = '<div style=""><p data-md-type="paragraph" data-md-index="0">text</p></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).not.toContain('data-md-type');
        expect(result).not.toContain('data-md-index');
    });

    it('strips all inline styles', async () => {
        const html = '<div style="font-size:16px"><p style="color:red">hello</p></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).not.toContain('style=');
    });

    it('keeps H1 and H2 as-is', async () => {
        const html = '<div style=""><h1>Title</h1><h2>Sub</h2></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).toContain('<h1>Title</h1>');
        expect(result).toContain('<h2>Sub</h2>');
    });

    it('converts H3 to bold paragraph', async () => {
        const html = '<div style=""><h3>Section</h3></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).not.toContain('<h3');
        expect(result).toContain('<p><strong>Section</strong></p>');
    });

    it('converts H4–H6 to bold paragraphs', async () => {
        const html = '<div style=""><h4>A</h4><h5>B</h5><h6>C</h6></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).not.toMatch(/<h[4-6]/);
        expect(result).toContain('<p><strong>A</strong></p>');
        expect(result).toContain('<p><strong>B</strong></p>');
        expect(result).toContain('<p><strong>C</strong></p>');
    });

    it('splits image grid into individual image paragraphs', async () => {
        const html = '<div style=""><p class="image-grid" style="display:flex"><img src="a.jpg"><img src="b.jpg"></p></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).not.toContain('image-grid');
        // Each image should be in its own <p>
        const pMatches = result.match(/<p>/g);
        expect(pMatches?.length).toBe(2);
        expect(result).toContain('<img src="a.jpg">');
        expect(result).toContain('<img src="b.jpg">');
    });

    it('leaves non-data-URI image src unchanged when no API key', async () => {
        const html = '<div style=""><p><img src="https://example.com/img.png"></p></div>';
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).toContain('src="https://example.com/img.png"');
    });

    it('leaves data URI src unchanged when no API key provided', async () => {
        const dataUri = 'data:image/png;base64,abc123';
        const html = `<div style=""><p><img src="${dataUri}"></p></div>`;
        const result = await makeZhihuCompatible(html, NO_KEY);
        expect(result).toContain(dataUri);
    });

    it('calls uploadToImgbb for data URI images when API key is present', async () => {
        vi.mock('./imageRehost', () => ({
            uploadToImgbb: vi.fn().mockResolvedValue('https://i.ibb.co/test/img.png'),
        }));
        const { uploadToImgbb } = await import('./imageRehost');

        const dataUri = 'data:image/png;base64,abc123';
        const html = `<div style=""><p><img src="${dataUri}"></p></div>`;
        const result = await makeZhihuCompatible(html, 'my-api-key');

        expect(uploadToImgbb).toHaveBeenCalledWith(dataUri, 'my-api-key');
        expect(result).toContain('https://i.ibb.co/test/img.png');

        vi.restoreAllMocks();
    });
});
