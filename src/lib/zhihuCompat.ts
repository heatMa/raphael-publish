import { uploadToImgbb } from './imageRehost';
import { stripIndexMarkers } from './markdownIndexer';

// Cache base64 → imgbb URL within the page session to avoid re-uploading the same image.
const imgbbCache = new Map<string, string>();

/**
 * Transform rendered HTML for paste into Zhihu's article editor.
 *
 * Differences from WeChat:
 * - Zhihu ignores all inline styles → strip them
 * - Zhihu only supports H1 and H2 → H3+ become bold paragraphs
 * - Zhihu's backend fetches images by URL → base64 data URIs must be
 *   uploaded to a public host (imgbb) before pasting
 */
export async function makeZhihuCompatible(html: string, imgbbApiKey: string): Promise<string> {
    // Start from clean HTML (no internal editor markers)
    const cleanHtml = stripIndexMarkers(html);

    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanHtml, 'text/html');

    // Unwrap single container div (produced by applyTheme)
    const rootNodes = Array.from(doc.body.children);
    const section = doc.createElement('section');
    if (rootNodes.length === 1 && rootNodes[0].tagName === 'DIV') {
        Array.from(rootNodes[0].childNodes).forEach(child => section.appendChild(child));
    } else {
        rootNodes.forEach(node => section.appendChild(node));
    }

    // 1. Split image grids into individual image paragraphs
    //    (Zhihu doesn't support flex / multi-image layouts)
    section.querySelectorAll('p.image-grid').forEach(grid => {
        const imgs = Array.from(grid.querySelectorAll('img'));
        const frag = doc.createDocumentFragment();
        imgs.forEach(img => {
            const p = doc.createElement('p');
            p.appendChild(img.cloneNode(true));
            frag.appendChild(p);
        });
        grid.parentNode?.replaceChild(frag, grid);
    });

    // 2. Strip all inline styles (Zhihu re-styles everything)
    section.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

    // 3. Downgrade H3–H6 → <p><strong>…</strong></p>
    //    (Zhihu's editor only offers H1 and H2)
    (['h3', 'h4', 'h5', 'h6'] as const).forEach(tag => {
        section.querySelectorAll(tag).forEach(heading => {
            const p = doc.createElement('p');
            const strong = doc.createElement('strong');
            strong.innerHTML = heading.innerHTML;
            p.appendChild(strong);
            heading.parentNode?.replaceChild(p, heading);
        });
    });

    // 4. Upload base64 images to imgbb to get publicly accessible URLs
    if (imgbbApiKey) {
        const imgs = Array.from(section.querySelectorAll('img'));
        await Promise.all(imgs.map(async img => {
            const src = img.getAttribute('src') || '';
            if (!src.startsWith('data:')) return;
            try {
                const cached = imgbbCache.get(src);
                const publicUrl = cached ?? await uploadToImgbb(src, imgbbApiKey);
                if (!cached) imgbbCache.set(src, publicUrl);
                img.setAttribute('src', publicUrl);
            } catch (e) {
                console.error('Failed to re-host image to imgbb:', e);
                // Keep base64 as fallback; Zhihu may still reject it
            }
        }));
    }

    doc.body.innerHTML = '';
    doc.body.appendChild(section);
    return doc.body.innerHTML;
}
