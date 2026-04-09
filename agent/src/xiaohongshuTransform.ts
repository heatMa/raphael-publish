import type { FeishuDoc } from './feishu.js';
import { JSDOM } from 'jsdom';

export interface XiaohongshuDraft {
    mode: 'image' | 'longform';
    title: string;
    bodyText: string;
    bodyHtml: string;
    images: string[];
    hashtags: string[];
    coverCandidateIndex: number;
}

const IMAGE_TITLE_LIMIT = 20;
const LONGFORM_TITLE_LIMIT = 60;
const BODY_PARAGRAPH_LIMIT = 90;
const HASHTAG_LIMIT = 6;
const CHINESE_STOPWORDS = new Set([
    '我们', '你们', '他们', '这个', '那个', '一种', '一个', '一些', '因为', '所以', '如果', '然后',
    '以及', '可以', '需要', '进行', '已经', '还是', '就是', '关于', '文章', '内容', '方法', '问题',
    '时候', '这里', '这样', '那些', '大家', '自己', '体验', '总结', '笔记', '小红书', '飞书',
]);
const ENGLISH_STOPWORDS = new Set([
    'about', 'after', 'also', 'and', 'are', 'for', 'from', 'into', 'just', 'more', 'note', 'notes',
    'that', 'the', 'this', 'with', 'your', 'you', 'have', 'has', 'how', 'what', 'when', 'where',
]);

function normalizeWhitespace(text: string): string {
    return text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&amp;/g, '&');
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripTags(html: string): string {
    return normalizeWhitespace(decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')));
}

function extractImageSources(html: string): string[] {
    return Array.from(html.matchAll(/<img[^>]*src="([^"]+)"[^>]*>/gi)).map(match => match[1]);
}

function isImageOnlyParagraph(html: string): boolean {
    return stripTags(html).replace(/图片/g, '').trim() === '' && extractImageSources(html).length > 0;
}

function truncateTitle(title: string, limit: number): string {
    const cleaned = normalizeWhitespace(title).replace(/[【】]/g, '').trim();
    if (cleaned.length <= limit) return cleaned;
    return `${cleaned.slice(0, limit - 1)}…`;
}

function splitParagraph(text: string): string[] {
    const cleaned = normalizeWhitespace(text);
    if (!cleaned) return [];
    if (cleaned.length <= BODY_PARAGRAPH_LIMIT) return [cleaned];

    const sentences = cleaned
        .split(/(?<=[。！？!?；;])/)
        .map(part => part.trim())
        .filter(Boolean);

    if (sentences.length <= 1) {
        return cleaned
            .split(/(?<=[，,])/)
            .map(part => part.trim())
            .filter(Boolean);
    }

    const paragraphs: string[] = [];
    let current = '';

    for (const sentence of sentences) {
        if (!current) {
            current = sentence;
            continue;
        }

        if ((current + sentence).length > BODY_PARAGRAPH_LIMIT) {
            paragraphs.push(current);
            current = sentence;
        } else {
            current += sentence;
        }
    }

    if (current) paragraphs.push(current);
    return paragraphs;
}

function collectListItems(listHtml: string, ordered: boolean): string[] {
    return Array.from(listHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
        .map((item, index) => {
            const content = stripTags(item[1]);
            if (!content) return '';
            return ordered ? `${index + 1}. ${content}` : `• ${content}`;
        })
        .filter(Boolean);
}

function collectTableRows(tableHtml: string): string[] {
    const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).slice(0, 6);
    const lines = rows
        .map(row => Array.from(row[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)).map(cell => stripTags(cell[1])).filter(Boolean).join(' | '))
        .filter(Boolean);

    if (lines.length === 0) return [];
    return ['表格速览：', ...lines];
}

function collectCodeBlock(preHtml: string): string[] {
    const raw = stripTags(preHtml);
    if (!raw) return [];
    const lines = raw.split('\n').slice(0, 8);
    const result = ['代码要点：', ...lines.map(line => `  ${line}`)];
    if (raw.split('\n').length > lines.length) result.push('  ...');
    return result;
}

function addImageMarker(blocks: string[], images: string[], src: string): void {
    images.push(src);
    blocks.push(`📷 配图 ${images.length}`);
}

type DraftBlock =
    | { type: 'heading'; level: 1 | 2; text: string; html: string }
    | { type: 'paragraph'; text: string; html: string }
    | { type: 'list'; ordered: boolean; items: Array<{ text: string; html: string }> }
    | { type: 'blockquote'; text: string; html: string }
    | { type: 'table'; lines: string[] }
    | { type: 'code'; lines: string[] }
    | { type: 'divider' }
    | { type: 'image-marker'; index: number };

function hasHighlightStyle(style: string): boolean {
    const normalized = style.replace(/\s+/g, ' ').toLowerCase();
    if (!/background(?:-color)?\s*:/.test(normalized)) return false;
    return !/(transparent|rgba\(0,\s*0,\s*0,\s*0\)|initial|inherit|unset|white\b|#fff\b|#ffffff\b)/.test(normalized);
}

function hasBoldStyle(style: string): boolean {
    const normalized = style.replace(/\s+/g, ' ').toLowerCase();
    const match = normalized.match(/font-weight\s*:\s*([^;]+)/);
    if (!match) return false;
    const weight = match[1].trim();
    return weight === 'bold' || weight === 'bolder' || /^[6-9]00$/.test(weight);
}

function wrapInlineTag(tag: string, html: string): string {
    return html ? `<${tag}>${html}</${tag}>` : '';
}

function sanitizeInlineNode(node: Node): { html: string; text: string } {
    if (node.nodeType === node.TEXT_NODE) {
        const text = node.textContent || '';
        return { html: escapeHtml(text), text };
    }

    if (node.nodeType !== node.ELEMENT_NODE) {
        return { html: '', text: '' };
    }

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'img') return { html: '', text: '' };
    if (tagName === 'br') return { html: '<br>', text: '\n' };

    const child = sanitizeInlineNodes(Array.from(element.childNodes));

    switch (tagName) {
        case 'strong':
        case 'b':
            return { html: wrapInlineTag('strong', child.html), text: child.text };
        case 'mark':
            return { html: wrapInlineTag('mark', child.html), text: child.text };
        case 'code':
            return { html: wrapInlineTag('code', child.html), text: child.text };
        case 'em':
        case 'i':
        case 'u':
            return { html: wrapInlineTag(tagName, child.html), text: child.text };
        case 'a': {
            const href = element.getAttribute('href');
            if (href) {
                return {
                    html: `<a href="${escapeHtml(href)}">${child.html}</a>`,
                    text: child.text,
                };
            }
            return child;
        }
        case 'span': {
            const style = element.getAttribute('style') || '';
            if (hasHighlightStyle(style)) {
                return { html: wrapInlineTag('mark', child.html), text: child.text };
            }
            if (hasBoldStyle(style)) {
                return { html: wrapInlineTag('strong', child.html), text: child.text };
            }
            return child;
        }
        default:
            return child;
    }
}

function sanitizeInlineNodes(nodes: Node[]): { html: string; text: string } {
    return nodes.reduce((acc, node) => {
        const next = sanitizeInlineNode(node);
        acc.html += next.html;
        acc.text += next.text;
        return acc;
    }, { html: '', text: '' });
}

function makeRichText(html: string, text: string): { html: string; text: string } {
    const normalizedText = normalizeWhitespace(text);
    return {
        html: html.trim() || escapeHtml(normalizedText),
        text: normalizedText,
    };
}

function extractBlockquoteRichText(element: Element): { html: string; text: string } {
    const blockTags = new Set(['p', 'div', 'section']);
    const childElements = Array.from(element.children);
    const paragraphLike = childElements.filter(child => blockTags.has(child.tagName.toLowerCase()));

    if (paragraphLike.length === 0) {
        const inlineContent = sanitizeInlineNodes(Array.from(element.childNodes));
        const inline = makeRichText(inlineContent.html, inlineContent.text);
        return {
            html: inline.html ? `<p>${inline.html}</p>` : '',
            text: inline.text,
        };
    }

    const paragraphs = paragraphLike
        .map(child => {
            const inlineContent = sanitizeInlineNodes(Array.from(child.childNodes));
            return makeRichText(inlineContent.html, inlineContent.text);
        })
        .filter(part => part.text);

    return {
        html: paragraphs.map(part => `<p>${part.html}</p>`).join(''),
        text: normalizeWhitespace(paragraphs.map(part => part.text).join('\n\n')),
    };
}

function extractBlocks(html: string): { blocks: DraftBlock[]; images: string[]; keywordSource: string[] } {
    const blocks: DraftBlock[] = [];
    const images: string[] = [];
    const keywordSource: string[] = [];
    const dom = new JSDOM(`<body>${html}</body>`);
    const { document } = dom.window;

    for (const child of Array.from(document.body.children)) {
        const tagName = child.tagName.toLowerCase();

        if (/^h[1-6]$/.test(tagName)) {
            const inlineContent = sanitizeInlineNodes(Array.from(child.childNodes));
            const richText = makeRichText(inlineContent.html, inlineContent.text);
            if (!richText.text) continue;
            blocks.push({ type: 'heading', level: tagName === 'h1' ? 1 : 2, text: richText.text, html: richText.html });
            keywordSource.push(richText.text);
            continue;
        }

        if (tagName === 'p') {
            const paragraphImages = Array.from(child.querySelectorAll('img')).map(img => img.getAttribute('src') || '').filter(Boolean);
            if (isImageOnlyParagraph(child.innerHTML)) {
                paragraphImages.forEach(src => {
                    addImageMarker([], images, src);
                    blocks.push({ type: 'image-marker', index: images.length });
                });
                continue;
            }

            const inlineContent = sanitizeInlineNodes(Array.from(child.childNodes));
            const richText = makeRichText(inlineContent.html, inlineContent.text);
            if (richText.text) {
                blocks.push({ type: 'paragraph', text: richText.text, html: richText.html });
                keywordSource.push(richText.text);
            }

            paragraphImages.forEach(src => {
                if (src && !images.includes(src)) {
                    addImageMarker([], images, src);
                    blocks.push({ type: 'image-marker', index: images.length });
                }
            });
            continue;
        }

        if (tagName === 'ul' || tagName === 'ol') {
            const items = Array.from(child.children)
                .filter(item => item.tagName.toLowerCase() === 'li')
                .map(item => {
                    const inlineContent = sanitizeInlineNodes(Array.from(item.childNodes));
                    return makeRichText(inlineContent.html, inlineContent.text);
                })
                .filter(item => item.text);

            if (items.length > 0) {
                blocks.push({
                    type: 'list',
                    ordered: tagName === 'ol',
                    items,
                });
                keywordSource.push(...items.map(item => item.text));
            }
            continue;
        }

        if (tagName === 'blockquote') {
            const richText = extractBlockquoteRichText(child);
            if (!richText.text) continue;
            blocks.push({ type: 'blockquote', text: richText.text, html: richText.html });
            keywordSource.push(richText.text);
            continue;
        }

        if (tagName === 'table') {
            const lines = collectTableRows(child.outerHTML);
            if (lines.length > 0) blocks.push({ type: 'table', lines });
            keywordSource.push(...lines);
            continue;
        }

        if (tagName === 'pre') {
            const lines = collectCodeBlock(child.outerHTML);
            if (lines.length > 0) blocks.push({ type: 'code', lines });
            keywordSource.push(...lines);
            continue;
        }

        if (tagName === 'hr') {
            blocks.push({ type: 'divider' });
            continue;
        }
    }

    return {
        blocks,
        images,
        keywordSource,
    };
}

function scoreToken(token: string, scoreMap: Map<string, number>, weight: number): void {
    const normalized = token.trim().toLowerCase();
    if (!normalized) return;
    scoreMap.set(normalized, (scoreMap.get(normalized) || 0) + weight);
}

function extractHashtags(title: string, keywordSource: string[]): string[] {
    const scoreMap = new Map<string, number>();

    const addFromText = (text: string, weight: number): void => {
        const chineseTokens = text.match(/[\u4e00-\u9fff]{2,8}/g) || [];
        chineseTokens.forEach(token => {
            if (!CHINESE_STOPWORDS.has(token)) scoreToken(token, scoreMap, weight);
        });

        const englishTokens = text.match(/\b[a-zA-Z][a-zA-Z0-9-]{2,20}\b/g) || [];
        englishTokens.forEach(token => {
            if (!ENGLISH_STOPWORDS.has(token.toLowerCase())) scoreToken(token, scoreMap, weight);
        });
    };

    addFromText(title, 3);
    keywordSource.slice(0, 12).forEach(text => addFromText(text, 1));

    return Array.from(scoreMap.entries())
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
        .map(([token]) => token)
        .filter(token => token.length >= 2)
        .slice(0, HASHTAG_LIMIT)
        .map(token => `#${token}`);
}

function composeBodyText(blocks: DraftBlock[], hashtags: string[]): string {
    const bodyBlocks = blocks.flatMap(block => {
        switch (block.type) {
            case 'heading':
                return [`【${block.text}】`];
            case 'paragraph':
                return splitParagraph(block.text);
            case 'list':
                return block.items.map((item, index) => block.ordered ? `${index + 1}. ${item.text}` : `• ${item.text}`);
            case 'blockquote':
                return splitParagraph(`引用：${block.text}`);
            case 'table':
                return block.lines;
            case 'code':
                return block.lines;
            case 'divider':
                return ['——'];
            case 'image-marker':
                return [`📷 配图 ${block.index}`];
        }
    }).filter(Boolean);

    if (hashtags.length > 0) bodyBlocks.push(hashtags.join(' '));
    return normalizeWhitespace(bodyBlocks.join('\n\n'));
}

function composeBodyHtml(blocks: DraftBlock[], hashtags: string[]): string {
    const htmlBlocks = blocks.flatMap(block => {
        switch (block.type) {
            case 'heading':
                return [`<h${block.level}>${block.html}</h${block.level}>`];
            case 'paragraph':
                return [`<p>${block.html}</p>`];
            case 'list': {
                const tag = block.ordered ? 'ol' : 'ul';
                const items = block.items.map(item => `<li>${item.html}</li>`).join('');
                return [`<${tag}>${items}</${tag}>`];
            }
            case 'blockquote':
                return [`<blockquote>${block.html}</blockquote>`];
            case 'table':
                return block.lines.map(line => `<p>${escapeHtml(line)}</p>`);
            case 'code':
                return [
                    `<blockquote>${block.lines.map(line => `<p><code>${escapeHtml(line)}</code></p>`).join('')}</blockquote>`,
                ];
            case 'divider':
                return ['<p>——</p>'];
            case 'image-marker':
                return [`<p>📷 配图 ${block.index}</p>`];
        }
    });

    if (hashtags.length > 0) {
        htmlBlocks.push(`<p>${hashtags.map(tag => escapeHtml(tag)).join(' ')}</p>`);
    }

    return htmlBlocks.join('');
}

export function makeXiaohongshuCompatibleDraft(doc: FeishuDoc): XiaohongshuDraft {
    const { blocks, images, keywordSource } = extractBlocks(doc.html);
    const mode = images.length > 0 ? 'image' : 'longform';
    const title = truncateTitle(doc.title, mode === 'image' ? IMAGE_TITLE_LIMIT : LONGFORM_TITLE_LIMIT);
    const hashtags = extractHashtags(title, keywordSource);

    return {
        mode,
        title,
        bodyText: composeBodyText(blocks, hashtags),
        bodyHtml: composeBodyHtml(blocks, hashtags),
        images,
        hashtags,
        coverCandidateIndex: images.length > 0 ? 0 : -1,
    };
}
