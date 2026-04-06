/**
 * Zhihu article publisher using Playwright.
 *
 * Strategy:
 * 1. Launch browser with persistent profile (session survives between runs)
 * 2. Navigate to zhihu.com/creator/writing (article editor)
 * 3. Set title
 * 4. Inject HTML content via synthetic paste event into the Slate editor
 * 5. Wait for images to be uploaded by Zhihu, then save as draft
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const PROFILE_DIR = path.join(os.homedir(), '.raphael-agent', 'zhihu-profile');
const ZHIHU_EDITOR_URL = 'https://zhuanlan.zhihu.com/write';

// ─── Session management ───────────────────────────────────────────────────────

async function createContext(): Promise<BrowserContext> {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    return await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
        args: ['--no-sandbox'],
    });
}

export async function loginZhihu(): Promise<void> {
    const ctx = await createContext();
    const page = await ctx.newPage();
    await page.goto('https://www.zhihu.com/signin');
    console.log('\n请在浏览器中登录知乎，完成后按 Enter 继续...');
    await waitForEnter();
    await ctx.close();
    console.log('登录信息已保存。');
}

function waitForEnter(): Promise<void> {
    return new Promise(resolve => {
        process.stdin.resume();
        process.stdin.setRawMode?.(false);
        process.stdin.once('data', () => {
            process.stdin.pause();
            resolve();
        });
    });
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export interface ZhihuPublishOptions {
    title: string;
    html: string;
    /** When true, click publish immediately; otherwise save as draft */
    publish?: boolean;
}

export async function publishToZhihu(opts: ZhihuPublishOptions): Promise<void> {
    const { title, html, publish = false } = opts;

    const ctx = await createContext();
    const page = await ctx.newPage();

    try {
        console.log('Opening Zhihu editor...');
        await page.goto(ZHIHU_EDITOR_URL, { waitUntil: 'networkidle' });

        // Check if login is required
        if (page.url().includes('signin') || page.url().includes('login')) {
            throw new Error('未登录知乎，请先运行: npm run login:zhihu');
        }

        // Wait for the editor to be ready
        await page.waitForSelector('.DraftEditor-root, .editor-kit-container, [contenteditable="true"]', { timeout: 15000 });

        // Set title
        await setTitle(page, title);

        // Inject content into the editor
        await injectHtmlContent(page, html);

        // Wait for image uploads to complete
        await waitForImageUploads(page);

        if (publish) {
            await clickPublish(page);
            console.log('文章已发布！');
        } else {
            // Zhihu auto-saves; manually trigger save
            await page.keyboard.press('Control+s');
            await page.waitForTimeout(2000);
            console.log('文章已保存为草稿。请在知乎创作中心查看。');
        }

        // Keep browser open briefly so user can see the result
        await page.waitForTimeout(3000);
    } finally {
        await ctx.close();
    }
}

// ─── Editor interactions ──────────────────────────────────────────────────────

async function setTitle(page: Page, title: string): Promise<void> {
    // Try different known selectors for the title input
    const titleSelectors = [
        'textarea.WriteIndex-titleTextarea',
        'input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        '.title-editor input',
        '.title-editor textarea',
    ];

    let titleEl = null;
    for (const sel of titleSelectors) {
        titleEl = await page.$(sel);
        if (titleEl) break;
    }

    if (!titleEl) {
        console.warn('未找到标题输入框，尝试截图调试...');
        await page.screenshot({ path: '/tmp/zhihu-debug.png' });
        throw new Error('找不到知乎标题输入框，截图已保存到 /tmp/zhihu-debug.png');
    }

    await titleEl.click({ clickCount: 3 });
    await titleEl.fill(title);
    console.log(`标题已设置: ${title}`);
}

async function injectHtmlContent(page: Page, html: string): Promise<void> {
    // Locate the content editor (Slate-based)
    const editorSelectors = [
        '.DraftEditor-root',
        '.editor-kit-container [contenteditable="true"]',
        '[data-slate-editor="true"]',
        '.notranslate[contenteditable="true"]',
    ];

    let editorEl = null;
    for (const sel of editorSelectors) {
        editorEl = await page.$(sel);
        if (editorEl) break;
    }

    if (!editorEl) {
        await page.screenshot({ path: '/tmp/zhihu-editor-debug.png' });
        throw new Error('找不到知乎编辑器，截图已保存到 /tmp/zhihu-editor-debug.png');
    }

    await editorEl.click();
    await page.waitForTimeout(500);

    // Select all existing content and replace via paste
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(200);

    // Inject HTML via clipboard API (execCommand for compatibility)
    await page.evaluate((htmlContent) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/html', htmlContent);
        clipboardData.setData('text/plain', document.createTextNode(htmlContent).textContent || '');

        const event = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData,
        });

        const target = document.activeElement || document.querySelector('[contenteditable="true"]');
        if (target) {
            target.dispatchEvent(event);
        }
    }, html);

    await page.waitForTimeout(2000);
    console.log('内容已注入编辑器');
}

async function waitForImageUploads(page: Page): Promise<void> {
    console.log('等待图片上传完成...');
    // Wait until there are no more loading indicators
    const maxWait = 60000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        const hasLoading = await page.evaluate(() => {
            // Look for loading spinners or upload progress indicators
            const loadingSelectors = [
                '.uploading',
                '[class*="upload"][class*="loading"]',
                '[class*="image"][class*="loading"]',
                '.loading-image',
            ];
            return loadingSelectors.some(sel => document.querySelector(sel) !== null);
        });

        if (!hasLoading) break;
        await page.waitForTimeout(1000);
    }

    console.log('图片上传完成');
}

async function clickPublish(page: Page): Promise<void> {
    const publishSelectors = [
        'button:has-text("发布")',
        'button:has-text("发表")',
        '[class*="publish"]',
    ];

    for (const sel of publishSelectors) {
        const btn = await page.$(sel);
        if (btn) {
            await btn.click();
            await page.waitForTimeout(3000);
            return;
        }
    }
    throw new Error('找不到发布按钮');
}
