/**
 * Feishu Open API client
 * Reads a Feishu document (docx or wiki) and converts it to HTML.
 */

const BASE = 'https://open.feishu.cn';

// ─── Auth ────────────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

export async function getAccessToken(appId: string, appSecret: string): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const res = await fetch(`${BASE}/open-apis/auth/v3/app_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const json = await res.json() as { code: number; msg: string; app_access_token: string; expire: number };
    if (json.code !== 0) throw new Error(`Feishu auth failed: ${json.msg}`);

    cachedToken = json.app_access_token;
    tokenExpiry = Date.now() + (json.expire - 60) * 1000;
    return cachedToken;
}

// ─── Wiki → Doc token ────────────────────────────────────────────────────────

export async function resolveWikiNode(wikiToken: string, token: string): Promise<{ docId: string; title: string }> {
    const res = await fetch(`${BASE}/open-apis/wiki/v2/spaces/get_node?token=${wikiToken}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json() as {
        code: number; msg: string;
        data: { node: { obj_token: string; obj_type: string; title: string } }
    };
    if (json.code !== 0) throw new Error(`Feishu wiki get_node failed: ${json.msg}`);
    const { obj_token, obj_type, title } = json.data.node;
    if (obj_type !== 'docx') throw new Error(`Wiki node type is ${obj_type}, expected docx`);
    return { docId: obj_token, title };
}

export async function fetchDocumentTitle(docId: string, token: string): Promise<string> {
    const res = await fetch(`${BASE}/open-apis/docx/v1/documents/${docId}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json() as {
        code: number; msg: string;
        data?: { document?: { title?: string } };
    };
    if (json.code !== 0) throw new Error(`Feishu document get failed: ${json.msg}`);
    return json.data?.document?.title || 'Untitled';
}

// ─── Document blocks ─────────────────────────────────────────────────────────

interface TextRun {
    content: string;
    text_element_style?: {
        bold?: boolean;
        italic?: boolean;
        strikethrough?: boolean;
        underline?: boolean;
        inline_code?: boolean;
        link?: { url: string };
    };
}

interface MentionDoc {
    url: string;
    title: string;
}

interface TextElement {
    text_run?: TextRun;
    mention_doc?: MentionDoc;
}

interface Block {
    block_id: string;
    block_type: number;
    parent_id: string;
    children?: string[];
    // Type-specific content fields (only those we use)
    text?: { elements: TextElement[]; style?: { align?: number; list?: { type?: string; indentLevel?: number } } };
    heading1?: { elements: TextElement[]; style?: object };
    heading2?: { elements: TextElement[]; style?: object };
    heading3?: { elements: TextElement[]; style?: object };
    heading4?: { elements: TextElement[]; style?: object };
    heading5?: { elements: TextElement[]; style?: object };
    heading6?: { elements: TextElement[]; style?: object };
    heading7?: { elements: TextElement[]; style?: object };
    heading8?: { elements: TextElement[]; style?: object };
    heading9?: { elements: TextElement[]; style?: object };
    bullet?: { elements: TextElement[]; style?: { list?: { indentLevel?: number } } };
    ordered?: { elements: TextElement[]; style?: { list?: { indentLevel?: number } } };
    todo?: { elements: TextElement[]; style?: { done?: boolean } };
    quote?: { elements: TextElement[] };
    code?: { language?: number; elements?: TextElement[] };
    image?: { token: string; width?: number; height?: number };
    table?: { cells: string[]; property?: { column_size: number; row_size: number } };
    table_cell?: object;
    divider?: object;
    iframe?: { component?: { url?: string } };
}

async function fetchAllBlocks(docId: string, token: string): Promise<Block[]> {
    const blocks: Block[] = [];
    let pageToken: string | undefined;

    do {
        const url = new URL(`${BASE}/open-apis/docx/v1/documents/${docId}/blocks`);
        url.searchParams.set('page_size', '500');
        if (pageToken) url.searchParams.set('page_token', pageToken);

        const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json() as {
            code: number; msg: string;
            data: { items: Block[]; has_more: boolean; page_token?: string }
        };
        if (json.code !== 0) throw new Error(`Feishu docx blocks failed: ${json.msg}`);

        blocks.push(...json.data.items);
        pageToken = json.data.has_more ? json.data.page_token : undefined;
    } while (pageToken);

    return blocks;
}

// ─── Image download ───────────────────────────────────────────────────────────

export async function downloadImageAsDataUrl(imageToken: string, docId: string, accessToken: string): Promise<string> {
    const res = await fetch(`${BASE}/open-apis/drive/v1/medias/${imageToken}/download?extra={"bitablePerm":{"tableId":"","rev":0}}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        // Try alternative image download endpoint
        const res2 = await fetch(`${BASE}/open-apis/docx/v1/documents/${docId}/blocks/resource?token=${imageToken}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res2.ok) throw new Error(`Failed to download image ${imageToken}: HTTP ${res2.status}`);
        const blob2 = await res2.blob();
        return blobToDataUrl(blob2);
    }
    const blob = await res.blob();
    return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const reader = blob.stream().getReader();
        const pump = (): void => {
            reader.read().then(({ done, value }) => {
                if (done) {
                    const buf = Buffer.concat(chunks);
                    resolve(`data:${blob.type};base64,${buf.toString('base64')}`);
                } else {
                    chunks.push(Buffer.from(value));
                    pump();
                }
            }).catch(reject);
        };
        pump();
    });
}

// ─── Blocks → HTML ────────────────────────────────────────────────────────────

// Feishu block_type numbers
const TYPE = {
    PAGE: 1,
    TEXT: 2,
    HEADING1: 3, HEADING2: 4, HEADING3: 5,
    HEADING4: 6, HEADING5: 7, HEADING6: 8,
    HEADING7: 9, HEADING8: 10, HEADING9: 11,
    BULLET: 12,
    ORDERED: 13,
    CODE: 14,
    QUOTE: 15,
    TODO: 17,
    DIVIDER: 22,
    IMAGE: 27,
    TABLE: 31,
    TABLE_CELL: 32,
    IFRAME: 34,
} as const;

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function elementsToHtml(elements: TextElement[]): string {
    return elements.map(el => {
        if (el.mention_doc) {
            const title = escapeHtml(el.mention_doc.title || '文档');
            const url = escapeHtml(el.mention_doc.url || '');
            return `<a href="${url}">${title}</a>`;
        }
        if (!el.text_run) return '';
        const { content, text_element_style: style } = el.text_run;
        let html = escapeHtml(content);
        if (!style) return html;
        if (style.inline_code) return `<code>${html}</code>`;
        if (style.link?.url) {
            const href = escapeHtml(decodeURIComponent(style.link.url));
            html = `<a href="${href}">${html}</a>`;
        }
        if (style.bold) html = `<strong>${html}</strong>`;
        if (style.italic) html = `<em>${html}</em>`;
        if (style.strikethrough) html = `<del>${html}</del>`;
        if (style.underline) html = `<u>${html}</u>`;
        return html;
    }).join('');
}

interface ConvertContext {
    blockMap: Map<string, Block>;
    docId: string;
    accessToken: string;
    imageDataUrls: Map<string, string>;
    // track list nesting
    listStack: Array<{ tag: 'ul' | 'ol'; indent: number }>;
}

async function convertBlock(block: Block, ctx: ConvertContext): Promise<string> {
    const { blockMap, docId, accessToken, imageDataUrls } = ctx;

    switch (block.block_type) {
        case TYPE.PAGE: {
            // Render children
            const parts = await Promise.all(
                (block.children || []).map(id => {
                    const child = blockMap.get(id);
                    return child ? convertBlock(child, ctx) : Promise.resolve('');
                })
            );
            return parts.join('');
        }

        case TYPE.TEXT: {
            if (!block.text) return '';
            const inner = elementsToHtml(block.text.elements);
            if (!inner.trim()) return '<p><br></p>';
            return `<p>${inner}</p>`;
        }

        case TYPE.HEADING1: return `<h1>${elementsToHtml(block.heading1?.elements || [])}</h1>`;
        case TYPE.HEADING2: return `<h2>${elementsToHtml(block.heading2?.elements || [])}</h2>`;
        case TYPE.HEADING3: return `<h3>${elementsToHtml(block.heading3?.elements || [])}</h3>`;
        case TYPE.HEADING4: return `<h4>${elementsToHtml(block.heading4?.elements || [])}</h4>`;
        case TYPE.HEADING5: return `<h5>${elementsToHtml(block.heading5?.elements || [])}</h5>`;
        case TYPE.HEADING6: return `<h6>${elementsToHtml(block.heading6?.elements || [])}</h6>`;
        case TYPE.HEADING7: return `<h6>${elementsToHtml(block.heading7?.elements || [])}</h6>`;
        case TYPE.HEADING8: return `<h6>${elementsToHtml(block.heading8?.elements || [])}</h6>`;
        case TYPE.HEADING9: return `<h6>${elementsToHtml(block.heading9?.elements || [])}</h6>`;

        case TYPE.BULLET: {
            const content = elementsToHtml(block.bullet?.elements || []);
            return `<ul><li>${content}</li></ul>`;
        }

        case TYPE.ORDERED: {
            const content = elementsToHtml(block.ordered?.elements || []);
            return `<ol><li>${content}</li></ol>`;
        }

        case TYPE.TODO: {
            const checked = block.todo?.style?.done ? ' checked' : '';
            const content = elementsToHtml(block.todo?.elements || []);
            return `<ul><li><input type="checkbox"${checked} disabled> ${content}</li></ul>`;
        }

        case TYPE.QUOTE: {
            const content = elementsToHtml(block.quote?.elements || []);
            return `<blockquote><p>${content}</p></blockquote>`;
        }

        case TYPE.CODE: {
            const codeElements = block.code?.elements || [];
            const codeText = codeElements.map(el => el.text_run?.content || '').join('');
            const lang = getCodeLanguage(block.code?.language || 0);
            return `<pre><code class="language-${lang}">${escapeHtml(codeText)}</code></pre>`;
        }

        case TYPE.IMAGE: {
            const imageToken = block.image?.token;
            if (!imageToken) return '';
            try {
                let dataUrl = imageDataUrls.get(imageToken);
                if (!dataUrl) {
                    dataUrl = await downloadImageAsDataUrl(imageToken, docId, accessToken);
                    imageDataUrls.set(imageToken, dataUrl);
                }
                const w = block.image?.width ? ` width="${block.image.width}"` : '';
                return `<p><img src="${dataUrl}"${w} alt="图片"></p>`;
            } catch (e) {
                console.error(`Failed to download image ${imageToken}:`, e);
                return `<p>[图片加载失败: ${imageToken}]</p>`;
            }
        }

        case TYPE.DIVIDER:
            return '<hr>';

        case TYPE.TABLE: {
            if (!block.table) return '';
            const { cells, property } = block.table;
            const cols = property?.column_size || 1;
            const rows = property?.row_size || 1;
            let html = '<table><tbody>';
            for (let r = 0; r < rows; r++) {
                html += '<tr>';
                for (let c = 0; c < cols; c++) {
                    const cellId = cells[r * cols + c];
                    const cellBlock = cellMap(blockMap, cellId);
                    const cellContent = cellBlock ? await renderTableCell(cellBlock, ctx) : '';
                    html += `<td>${cellContent}</td>`;
                }
                html += '</tr>';
            }
            html += '</tbody></table>';
            return html;
        }

        case TYPE.IFRAME: {
            const url = block.iframe?.component?.url || '';
            if (!url) return '';
            return `<p><a href="${escapeHtml(url)}">[内嵌内容: ${escapeHtml(url)}]</a></p>`;
        }

        default:
            return '';
    }
}

function cellMap(blockMap: Map<string, Block>, cellId: string): Block | undefined {
    return blockMap.get(cellId);
}

async function renderTableCell(cellBlock: Block, ctx: ConvertContext): Promise<string> {
    const { blockMap } = ctx;
    const parts = await Promise.all(
        (cellBlock.children || []).map(id => {
            const child = blockMap.get(id);
            return child ? convertBlock(child, ctx) : Promise.resolve('');
        })
    );
    return parts.join('');
}

// Feishu code language enum → string
const CODE_LANG: Record<number, string> = {
    1: 'plain', 2: 'abap', 3: 'ada', 4: 'apache', 5: 'apex', 6: 'yml',
    7: 'bash', 8: 'clojure', 9: 'cmake', 10: 'coffeescript', 11: 'c',
    12: 'cpp', 13: 'csharp', 14: 'css', 15: 'dart', 16: 'delphi',
    17: 'dockerfile', 18: 'erlang', 19: 'fortran', 20: 'fsharp',
    21: 'diff', 22: 'go', 23: 'groovy', 24: 'html', 25: 'html',
    26: 'ini', 27: 'java', 28: 'javascript', 29: 'json', 30: 'julia',
    31: 'kotlin', 32: 'latex', 33: 'less', 34: 'lisp', 35: 'lua',
    36: 'makefile', 37: 'markdown', 38: 'matlab', 39: 'mermaid',
    40: 'nginx', 41: 'objectivec', 42: 'ocaml', 43: 'opengl',
    44: 'php', 45: 'powershell', 46: 'prolog', 47: 'protobuf',
    48: 'python', 49: 'r', 50: 'ruby', 51: 'rust', 52: 'scala',
    53: 'scss', 54: 'shell', 55: 'sql', 56: 'swift', 57: 'typescript',
    58: 'vb', 59: 'verilog', 60: 'xml', 61: 'yaml', 62: 'zig',
};

function getCodeLanguage(langNum: number): string {
    return CODE_LANG[langNum] || 'plain';
}

// ─── Post-process: merge adjacent lists ──────────────────────────────────────

function mergeAdjacentLists(html: string): string {
    // Merge consecutive <ul>...</ul> or <ol>...</ol> tags
    return html
        .replace(/<\/ul>\s*<ul>/g, '')
        .replace(/<\/ol>\s*<ol>/g, '');
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface FeishuDoc {
    title: string;
    html: string;
}

export async function readFeishuDocument(
    urlOrToken: string,
    appId: string,
    appSecret: string
): Promise<FeishuDoc> {
    const accessToken = await getAccessToken(appId, appSecret);

    // Extract wiki token from URL if needed
    let wikiToken = urlOrToken;
    const wikiMatch = urlOrToken.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) wikiToken = wikiMatch[1];

    // Resolve wiki → docx
    let docId: string;
    let title: string;
    if (urlOrToken.includes('/wiki/')) {
        const resolved = await resolveWikiNode(wikiToken, accessToken);
        docId = resolved.docId;
        title = resolved.title;
    } else {
        // Direct docx URL
        const docMatch = urlOrToken.match(/\/docx?\/([A-Za-z0-9]+)/);
        if (!docMatch) throw new Error(`Cannot parse Feishu URL: ${urlOrToken}`);
        docId = docMatch[1];
        title = await fetchDocumentTitle(docId, accessToken);
    }

    console.log(`Reading Feishu document: ${title} (${docId})`);

    const blocks = await fetchAllBlocks(docId, accessToken);
    const blockMap = new Map(blocks.map(b => [b.block_id, b]));
    const pageBlock = blocks.find(b => b.block_type === TYPE.PAGE);
    if (!pageBlock) throw new Error('No page block found in document');

    const ctx: ConvertContext = {
        blockMap,
        docId,
        accessToken,
        imageDataUrls: new Map(),
        listStack: [],
    };

    console.log(`Converting ${blocks.length} blocks...`);
    let html = await convertBlock(pageBlock, ctx);
    html = mergeAdjacentLists(html);

    return { title, html };
}
