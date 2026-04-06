/**
 * Transform Feishu-sourced HTML for paste into WeChat Official Account editor.
 *
 * This is a jsdom port of the web app's applyTheme() + makeWeChatCompatible().
 * The browser versions use DOMParser; here we use JSDOM for the same DOM API.
 *
 * Pipeline: raw HTML → applyTheme() → makeWeChatCompatible() → ready for WeChat
 */

import { JSDOM } from 'jsdom';
import { THEMES } from '../../src/lib/themes/index.js';

// ─── applyTheme (port of src/lib/markdown.ts:applyTheme) ─────────────────────

const headingInlineOverrides: Record<string, string> = {
    strong: 'font-weight: 700; color: inherit !important; background-color: transparent !important;',
    em: 'font-style: italic; color: inherit !important; background-color: transparent !important;',
    a: 'color: inherit !important; text-decoration: none !important; border-bottom: 1px solid currentColor !important; background-color: transparent !important;',
    code: 'color: inherit !important; background-color: transparent !important; border: none !important; padding: 0 !important;',
};

function applyTheme(html: string, themeId: string): string {
    const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
    const style = theme.styles;

    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const Node = dom.window.Node;

    // ── Image grid merging (consecutive image-only paragraphs → side-by-side) ──

    const getSingleImageNode = (p: Element): Element | null => {
        const children = Array.from(p.childNodes).filter(n =>
            !(n.nodeType === Node.TEXT_NODE && !(n.textContent || '').trim()) &&
            !(n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'BR')
        );
        if (children.length !== 1) return null;
        const onlyChild = children[0] as Element;
        if (onlyChild.nodeName === 'IMG') return onlyChild;
        if (onlyChild.nodeName === 'A' && onlyChild.childNodes.length === 1 && onlyChild.childNodes[0].nodeName === 'IMG') {
            return onlyChild;
        }
        return null;
    };

    const isImageOnlyParagraph = (p: Element): boolean => {
        const children = Array.from(p.childNodes).filter(n =>
            !(n.nodeType === Node.TEXT_NODE && !(n.textContent || '').trim()) &&
            !(n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'BR')
        );
        if (children.length === 0) return false;
        return children.every(n =>
            n.nodeName === 'IMG' ||
            (n.nodeName === 'A' && n.childNodes.length === 1 && n.childNodes[0].nodeName === 'IMG')
        );
    };

    const paragraphSnapshot = Array.from(doc.querySelectorAll('p'));
    const processed = new Set<Element>();

    for (const paragraph of paragraphSnapshot) {
        if (!paragraph.isConnected || processed.has(paragraph)) continue;
        if (!getSingleImageNode(paragraph) && !isImageOnlyParagraph(paragraph)) continue;

        const run: Element[] = [paragraph];
        processed.add(paragraph);

        let cursor = paragraph.nextElementSibling;
        while (cursor && cursor.tagName === 'P') {
            if (!getSingleImageNode(cursor) && !isImageOnlyParagraph(cursor)) break;
            run.push(cursor);
            processed.add(cursor);
            cursor = cursor.nextElementSibling;
        }

        if (run.length < 2) continue;

        const allImages: Element[] = [];
        run.forEach(p => {
            if (getSingleImageNode(p)) {
                const img = getSingleImageNode(p);
                if (img) allImages.push(img);
            } else if (isImageOnlyParagraph(p)) {
                p.querySelectorAll('img').forEach(img => allImages.push(img));
            }
        });

        const firstParagraph = run[0];
        let lastInserted: Element | null = null;

        for (let i = 0; i < allImages.length; i += 2) {
            const gridParagraph = doc.createElement('p');
            gridParagraph.classList.add('image-grid');
            gridParagraph.setAttribute('style', 'display: flex; justify-content: center; gap: 8px; margin: 24px 0; align-items: flex-start;');
            gridParagraph.appendChild(allImages[i]);
            if (i + 1 < allImages.length) gridParagraph.appendChild(allImages[i + 1]);

            if (i === 0) {
                firstParagraph.before(gridParagraph);
                lastInserted = gridParagraph;
            } else if (lastInserted) {
                lastInserted.after(gridParagraph);
                lastInserted = gridParagraph;
            }
        }
        run.forEach(p => { if (p.isConnected) p.remove(); });
    }

    // Process remaining image grids
    doc.querySelectorAll('p').forEach(p => {
        const children = Array.from(p.childNodes).filter(n => !(n.nodeType === Node.TEXT_NODE && !(n.textContent || '').trim()));
        const isAllImages = children.length > 1 && children.every(n => n.nodeName === 'IMG' || (n.nodeName === 'A' && n.childNodes.length === 1 && n.childNodes[0].nodeName === 'IMG'));

        if (isAllImages) {
            p.classList.add('image-grid');
            p.setAttribute('style', 'display: flex; justify-content: center; gap: 8px; margin: 24px 0; align-items: flex-start;');
            p.querySelectorAll('img').forEach(img => {
                img.classList.add('grid-img');
                const w = 100 / children.length;
                img.setAttribute('style', `width: calc(${w}% - ${8 * (children.length - 1) / children.length}px); margin: 0; border-radius: 8px; height: auto;`);
            });
        }
    });

    // ── Apply theme styles ──

    Object.keys(style).forEach(selector => {
        if (selector === 'pre code') return;
        const elements = doc.querySelectorAll(selector);
        elements.forEach(el => {
            if (selector === 'code' && el.parentElement?.tagName === 'PRE') return;
            if (el.tagName === 'IMG' && el.closest('.image-grid')) return;
            const currentStyle = el.getAttribute('style') || '';
            el.setAttribute('style', currentStyle + '; ' + style[selector as keyof typeof style]);
        });
    });

    // ── List markers ──

    doc.querySelectorAll('ul').forEach(ul => {
        const s = ul.getAttribute('style') || '';
        ul.setAttribute('style', `${s}; list-style-type: disc !important; list-style-position: outside;`);
    });
    doc.querySelectorAll('ul ul').forEach(ul => {
        const s = ul.getAttribute('style') || '';
        ul.setAttribute('style', `${s}; list-style-type: circle !important;`);
    });
    doc.querySelectorAll('ol').forEach(ol => {
        const s = ol.getAttribute('style') || '';
        ol.setAttribute('style', `${s}; list-style-type: decimal !important; list-style-position: outside;`);
    });

    // ── Code highlighting ──

    const hljsLight: Record<string, string> = {
        'hljs-comment': 'color: #6a737d; font-style: normal;',
        'hljs-quote': 'color: #6a737d; font-style: normal;',
        'hljs-keyword': 'color: #d73a49; font-weight: 600;',
        'hljs-selector-tag': 'color: #d73a49; font-weight: 600;',
        'hljs-string': 'color: #032f62;',
        'hljs-title': 'color: #6f42c1; font-weight: 600;',
        'hljs-section': 'color: #6f42c1; font-weight: 600;',
        'hljs-type': 'color: #005cc5; font-weight: 600;',
        'hljs-number': 'color: #005cc5;',
        'hljs-literal': 'color: #005cc5;',
        'hljs-built_in': 'color: #005cc5;',
        'hljs-variable': 'color: #e36209;',
        'hljs-template-variable': 'color: #e36209;',
        'hljs-tag': 'color: #22863a;',
        'hljs-name': 'color: #22863a;',
        'hljs-attr': 'color: #6f42c1;',
    };

    doc.querySelectorAll('.hljs span').forEach(span => {
        let inlineStyle = span.getAttribute('style') || '';
        if (inlineStyle && !inlineStyle.endsWith(';')) inlineStyle += '; ';
        span.classList.forEach(cls => {
            if (hljsLight[cls]) inlineStyle += hljsLight[cls] + '; ';
        });
        if (inlineStyle) span.setAttribute('style', inlineStyle);
    });

    doc.querySelectorAll('pre').forEach(pre => {
        const s = pre.getAttribute('style') || '';
        pre.setAttribute('style', `${s}; font-variant-ligatures: none; tab-size: 2;`);
    });
    doc.querySelectorAll('pre code, pre .hljs, .hljs').forEach(codeNode => {
        const s = codeNode.getAttribute('style') || '';
        codeNode.setAttribute('style', `${s}; display: block; font-size: inherit !important; line-height: inherit !important; font-style: normal !important; white-space: pre; word-break: normal; overflow-wrap: normal;`);
    });

    // ── Heading inline overrides ──

    doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
        Object.keys(headingInlineOverrides).forEach(tag => {
            heading.querySelectorAll(tag).forEach(node => {
                const override = headingInlineOverrides[tag];
                node.setAttribute('style', `${node.getAttribute('style') || ''}; ${override}`);
            });
        });
    });

    // ── Unified image styles ──

    doc.querySelectorAll('img').forEach(img => {
        const inGrid = Boolean(img.closest('.image-grid'));
        const currentStyle = img.getAttribute('style') || '';
        const appendedStyle = inGrid
            ? 'display:block; max-width:100%; height:auto; margin:0 !important; padding:8px !important; border-radius:14px !important; box-sizing:border-box; box-shadow:0 12px 28px rgba(15,23,42,0.18), 0 2px 8px rgba(15,23,42,0.12); border:1px solid rgba(255,255,255,0.75);'
            : 'display:block; width:100%; max-width:100%; height:auto; margin:30px auto !important; padding:8px !important; border-radius:14px !important; box-sizing:border-box; box-shadow:0 16px 34px rgba(15,23,42,0.22), 0 4px 10px rgba(15,23,42,0.12); border:1px solid rgba(15,23,42,0.12);';
        img.setAttribute('style', `${currentStyle}; ${appendedStyle}`);
    });

    // ── Wrap in container ──

    const container = doc.createElement('div');
    container.setAttribute('style', style.container);
    container.innerHTML = doc.body.innerHTML;

    return container.outerHTML;
}

// ─── makeWeChatCompatible (port of src/lib/wechatCompat.ts) ───────────────────

function makeWeChatCompatible(html: string, themeId: string): string {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const Node = dom.window.Node;

    const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
    const containerStyle = theme.styles.container || '';

    // 1. Wrap in <section>
    const rootNodes = Array.from(doc.body.children);
    const section = doc.createElement('section');
    section.setAttribute('style', containerStyle);

    rootNodes.forEach(node => {
        if (node.tagName === 'DIV' && rootNodes.length === 1) {
            Array.from(node.childNodes).forEach(child => section.appendChild(child));
        } else {
            section.appendChild(node);
        }
    });

    // 2. Flex → table for images (WeChat ignores flex)
    const flexLikeNodes = section.querySelectorAll('div, p.image-grid');
    flexLikeNodes.forEach(node => {
        if (node.closest('pre, code')) return;
        const style = node.getAttribute('style') || '';
        const isFlexNode = style.includes('display: flex') || style.includes('display:flex');
        const isImageGrid = node.classList.contains('image-grid');
        if (!isFlexNode && !isImageGrid) return;

        const flexChildren = Array.from(node.children);
        if (flexChildren.every(child => child.tagName === 'IMG' || child.querySelector('img'))) {
            const table = doc.createElement('table');
            table.setAttribute('style', 'width: 100%; border-collapse: collapse; margin: 16px 0; border: none !important;');
            const tbody = doc.createElement('tbody');
            const tr = doc.createElement('tr');
            tr.setAttribute('style', 'border: none !important; background: transparent !important;');

            flexChildren.forEach(child => {
                const td = doc.createElement('td');
                td.setAttribute('style', 'padding: 0 4px; vertical-align: top; border: none !important; background: transparent !important;');
                td.appendChild(child);
                if (child.tagName === 'IMG') {
                    const currentStyle = child.getAttribute('style') || '';
                    child.setAttribute('style', currentStyle.replace(/width:\s*[^;]+;?/g, '') + ' width: 100% !important; display: block; margin: 0 auto;');
                }
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
            table.appendChild(tbody);
            node.parentNode?.replaceChild(table, node);
        } else if (isFlexNode) {
            node.setAttribute('style', style.replace(/display:\s*flex;?/g, 'display: block;'));
        }
    });

    // 3. Flatten <p> inside <li> → <span>
    section.querySelectorAll('li').forEach(li => {
        const hasBlockChildren = Array.from(li.children).some(child =>
            ['P', 'DIV', 'UL', 'OL', 'BLOCKQUOTE'].includes(child.tagName)
        );
        if (hasBlockChildren) {
            li.querySelectorAll('p').forEach(p => {
                const span = doc.createElement('span');
                span.innerHTML = p.innerHTML;
                const pStyle = p.getAttribute('style');
                if (pStyle) span.setAttribute('style', pStyle);
                p.parentNode?.replaceChild(span, p);
            });
        }
    });

    // 4. Force font inheritance (WeChat overrides inherited fonts)
    const fontMatch = containerStyle.match(/font-family:\s*([^;]+);/);
    const sizeMatch = containerStyle.match(/font-size:\s*([^;]+);/);
    const colorMatch = containerStyle.match(/color:\s*([^;]+);/);
    const lineHeightMatch = containerStyle.match(/line-height:\s*([^;]+);/);

    section.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, span').forEach(node => {
        if (node.tagName === 'SPAN' && node.closest('pre, code')) return;

        let currentStyle = node.getAttribute('style') || '';
        if (fontMatch && !currentStyle.includes('font-family:')) currentStyle += ` font-family: ${fontMatch[1]};`;
        if (lineHeightMatch && !currentStyle.includes('line-height:')) currentStyle += ` line-height: ${lineHeightMatch[1]};`;
        if (sizeMatch && !currentStyle.includes('font-size:') && ['P', 'LI', 'BLOCKQUOTE', 'SPAN'].includes(node.tagName))
            currentStyle += ` font-size: ${sizeMatch[1]};`;
        if (colorMatch && !currentStyle.includes('color:')) currentStyle += ` color: ${colorMatch[1]};`;
        node.setAttribute('style', currentStyle.trim());
    });

    // 5. CJK punctuation attached to preceding inline emphasis
    const inlineNodes = section.querySelectorAll('strong, b, em, span, a, code');
    inlineNodes.forEach(node => {
        const next = node.nextSibling;
        if (!next || next.nodeType !== Node.TEXT_NODE) return;
        const text = next.textContent || '';
        const match = text.match(/^\s*([：；，。！？、:])(.*)$/s);
        if (!match) return;

        const punct = match[1];
        const rest = match[2] || '';
        node.appendChild(doc.createTextNode(punct));
        if (rest) {
            next.textContent = rest;
        } else {
            next.parentNode?.removeChild(next);
        }
    });

    // 6. Images: Feishu images are already base64, no conversion needed.
    //    (Web app calls fetchImageAsDataUrl here, but agent downloads images as
    //     base64 during Feishu block conversion, so they're already data URIs.)

    doc.body.innerHTML = '';
    doc.body.appendChild(section);

    let outputHtml = doc.body.innerHTML;
    outputHtml = outputHtml.replace(/(<\/(?:strong|b|em|span|a|code)>)\s*([：；，。！？、])/g, '$1\u2060$2');

    return outputHtml;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const DEFAULT_THEME = 'apple';

export function makeWeChatCompatibleHtml(html: string, themeId: string = DEFAULT_THEME): string {
    const themed = applyTheme(html, themeId);
    return makeWeChatCompatible(themed, themeId);
}
