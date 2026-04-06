/**
 * Transform HTML from Feishu blocks into Zhihu-compatible HTML.
 *
 * Zhihu editor constraints:
 * - Only H1 and H2 are supported; H3+ must become <p><strong>...</strong></p>
 * - All inline styles are ignored; strip them for cleaner output
 * - Images must be public URLs (not base64/data URIs)
 *   → base64 images are uploaded to imgbb before pasting
 */

import { uploadToImgbb } from './imageRehost.js';

const imgbbCache = new Map<string, string>();

// ─── Simple regex-based transformations ──────────────────────────────────────

function stripInlineStyles(html: string): string {
    return html.replace(/\s*style="[^"]*"/g, '');
}

function downgradeHeadings(html: string): string {
    // H3–H9 → <p><strong>...</strong></p>
    return html.replace(/<h[3-9][^>]*>([\s\S]*?)<\/h[3-9]>/gi, (_match, inner) => {
        return `<p><strong>${inner}</strong></p>`;
    });
}

async function uploadBase64Images(html: string, imgbbApiKey: string): Promise<string> {
    // Find all <img src="data:..."> and upload to imgbb
    const dataUriRegex = /<img([^>]*)\ssrc="(data:image\/[^;]+;base64,[^"]+)"([^>]*)>/g;
    const replacements: Array<{ original: string; replacement: string }> = [];

    let match;
    while ((match = dataUriRegex.exec(html)) !== null) {
        const [full, before, dataUri, after] = match;
        try {
            const cached = imgbbCache.get(dataUri);
            const publicUrl = cached ?? await uploadToImgbb(dataUri, imgbbApiKey);
            if (!cached) imgbbCache.set(dataUri, publicUrl);
            replacements.push({
                original: full,
                replacement: `<img${before} src="${publicUrl}"${after}>`,
            });
        } catch (e) {
            console.error('imgbb upload failed:', e);
            // Keep data URI as fallback — Zhihu will reject it but at least content is preserved
        }
    }

    let result = html;
    for (const { original, replacement } of replacements) {
        result = result.replace(original, replacement);
    }
    return result;
}

export async function makeZhihuCompatibleHtml(html: string, imgbbApiKey: string): Promise<string> {
    let result = html;
    result = stripInlineStyles(result);
    result = downgradeHeadings(result);
    if (imgbbApiKey) {
        result = await uploadBase64Images(result, imgbbApiKey);
    }
    return result;
}
