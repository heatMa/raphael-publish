import { describe, expect, it } from 'vitest';
import { makeXiaohongshuCompatibleDraft } from './xiaohongshuTransform';

describe('makeXiaohongshuCompatibleDraft', () => {
    it('splits long paragraphs and adds hashtags', () => {
        const draft = makeXiaohongshuCompatibleDraft({
            title: '飞书文档自动发布到小红书的实践总结',
            html: '<p>这是一段很长很长的说明文字。它会介绍飞书内容转小红书时应该怎么拆段，怎么保证阅读体验，并且尽量保留原始信息密度，让内容看起来更像平台原生笔记。</p>',
        });

        expect(draft.bodyText).toContain('这是一段很长很长的说明文字。');
        expect(draft.bodyText).toContain('#飞书文档');
        expect(draft.hashtags.length).toBeGreaterThan(0);
    });

    it('flattens headings, quotes, tables and code blocks into readable text', () => {
        const draft = makeXiaohongshuCompatibleDraft({
            title: '技术文改写',
            html: `
                <h2>核心步骤</h2>
                <blockquote><p>先把结构整理出来，再处理平台差异。</p></blockquote>
                <table><tbody><tr><th>平台</th><th>特点</th></tr><tr><td>小红书</td><td>短段落</td></tr></tbody></table>
                <pre><code>const answer = 42;\nconsole.log(answer);</code></pre>
            `,
        });

        expect(draft.bodyText).toContain('【核心步骤】');
        expect(draft.bodyHtml).toContain('<h2>核心步骤</h2>');
        expect(draft.bodyText).toContain('引用：先把结构整理出来');
        expect(draft.bodyText).toContain('表格速览：');
        expect(draft.bodyText).toContain('代码要点：');
    });

    it('preserves image order and inserts image markers', () => {
        const draft = makeXiaohongshuCompatibleDraft({
            title: '图文案例',
            html: `
                <p><img src="data:image/png;base64,AAAA" alt="图1"></p>
                <p>这是图片后的解释。</p>
                <p><img src="data:image/png;base64,BBBB" alt="图2"></p>
            `,
        });

        expect(draft.images).toEqual([
            'data:image/png;base64,AAAA',
            'data:image/png;base64,BBBB',
        ]);
        expect(draft.mode).toBe('image');
        expect(draft.bodyHtml).toContain('📷 配图 1');
        expect(draft.bodyText).toContain('📷 配图 1');
        expect(draft.bodyText).toContain('📷 配图 2');
        expect(draft.coverCandidateIndex).toBe(0);
    });

    it('routes imageless docs to longform mode and keeps longer titles', () => {
        const draft = makeXiaohongshuCompatibleDraft({
            title: '这是一个特别长特别长特别长特别长的小红书标题示例',
            html: '<ul><li>第一点</li><li>第二点</li></ul>',
        });

        expect(draft.mode).toBe('longform');
        expect(draft.title).toBe('这是一个特别长特别长特别长特别长的小红书标题示例');
        expect(draft.bodyText).toContain('• 第一点');
        expect(draft.images).toEqual([]);
        expect(draft.coverCandidateIndex).toBe(-1);
    });

    it('preserves list, quote, highlight and bold markup in longform html', () => {
        const draft = makeXiaohongshuCompatibleDraft({
            title: '格式保真',
            html: `
                <p>普通 <strong>加粗</strong> <span style="background-color: rgb(255, 244, 163);">高亮</span></p>
                <blockquote><p>引用第一段</p><p>引用第二段</p></blockquote>
                <ul>
                    <li>列表 <mark>一</mark></li>
                    <li><span style="font-weight: 700;">列表二</span></li>
                </ul>
            `,
        });

        expect(draft.mode).toBe('longform');
        expect(draft.bodyHtml).toContain('<p>普通 <strong>加粗</strong> <mark>高亮</mark></p>');
        expect(draft.bodyHtml).toContain('<blockquote><p>引用第一段</p><p>引用第二段</p></blockquote>');
        expect(draft.bodyHtml).toContain('<ul><li>列表 <mark>一</mark></li><li><strong>列表二</strong></li></ul>');
        expect(draft.bodyText).toContain('引用：引用第一段');
        expect(draft.bodyText).toContain('• 列表 一');
    });
});
