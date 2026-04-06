/**
 * WeChat Official Account publisher using Playwright.
 *
 * Strategy:
 * 1. Launch browser with persistent profile (session survives between runs)
 * 2. Navigate to mp.weixin.qq.com → 新建图文
 * 3. Set title
 * 4. Inject HTML content via synthetic paste event into the editor
 * 5. Save as draft (auto-save) or click publish
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const PROFILE_DIR = path.join(os.homedir(), '.raphael-agent', 'wechat-profile');
const MP_HOME = 'https://mp.weixin.qq.com';
const MODIFIER_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

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

export async function loginWechat(): Promise<void> {
    const ctx = await createContext();
    const page = await ctx.newPage();
    await page.goto(MP_HOME);
    console.log('\n请在浏览器中扫码登录微信公众号后台，完成后按 Enter 继续...');
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

export interface WeChatPublishOptions {
    title: string;
    html: string;
    /** When true, submit for review/publish; otherwise save as draft */
    publish?: boolean;
}

export async function publishToWechat(opts: WeChatPublishOptions): Promise<void> {
    const { title, html, publish = false } = opts;

    const ctx = await createContext();
    const page = await ctx.newPage();

    try {
        console.log('Opening WeChat MP editor...');
        await page.goto(MP_HOME, { waitUntil: 'networkidle' });

        // Check if login is required (redirect to login page)
        if (page.url().includes('login') || await page.$('.weui-desktop-account__card') === null && await page.$('input[name="account"]') !== null) {
            throw new Error('未登录微信公众号，请先运行: npm run agent -- login wechat');
        }

        // Navigate to create new article
        await navigateToNewArticle(page);

        // Set title
        await setTitle(page, title);

        // Inject content
        await injectHtmlContent(page, html);

        // Wait for image uploads
        await waitForImageUploads(page);

        if (publish) {
            await clickPublish(page);
            console.log('文章已提交发布！');
        } else {
            // WeChat auto-saves; trigger explicit save just in case
            await page.keyboard.press(`${MODIFIER_KEY}+s`);
            await page.waitForTimeout(2000);
            console.log('文章已保存为草稿。请在公众号后台 → 草稿箱查看。');
        }

        await page.waitForTimeout(3000);
    } finally {
        await ctx.close();
    }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function navigateToNewArticle(page: Page): Promise<void> {
    // First land on home to get a valid session token from the URL
    await page.goto(MP_HOME, { waitUntil: 'networkidle' });

    // Extract token from URL or page (WeChat embeds it in every page URL)
    const token = await page.evaluate((): string => {
        // Try from current URL query string
        const params = new URLSearchParams(window.location.search);
        if (params.get('token')) return params.get('token')!;
        // Try from links on the page
        const links = Array.from(document.querySelectorAll('a[href*="token="]'));
        for (const link of links) {
            const m = (link as HTMLAnchorElement).href.match(/[?&]token=(\d+)/);
            if (m) return m[1];
        }
        return '';
    });

    if (token) {
        console.log(`Found session token: ${token}`);
        const editorUrl = `${MP_HOME}/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&token=${token}&lang=zh_CN`;
        await page.goto(editorUrl, { waitUntil: 'networkidle' });
    } else {
        // Fallback: click through the UI
        console.log('Token not found, navigating via UI...');
        await page.screenshot({ path: '/tmp/wechat-home-debug.png' });

        // Look for article creation button
        const btn = await page.$('text=写文章') ||
            await page.$('text=图文消息') ||
            await page.$('text=新建图文') ||
            await page.$('[class*="create"][class*="article"]');

        if (!btn) throw new Error('找不到新建文章按钮，截图已保存到 /tmp/wechat-home-debug.png');
        await btn.click();
        await page.waitForLoadState('networkidle');
    }

    // Wait for editor to load
    await page.waitForSelector(
        '.ProseMirror, iframe#ueditor_0',
        { timeout: 20000 }
    ).catch(async () => {
        await page.screenshot({ path: '/tmp/wechat-editor-debug.png' });
        throw new Error('找不到微信编辑器，截图已保存到 /tmp/wechat-editor-debug.png');
    });

    console.log('编辑器已加载');
}

// ─── Editor interactions ──────────────────────────────────────────────────────

async function setTitle(page: Page, title: string): Promise<void> {
    // Title is a TEXTAREA#title; use fill() to bypass any dialog overlay
    await page.fill('#title', title);
    console.log(`标题已设置: ${title}`);
}

async function injectHtmlContent(page: Page, html: string): Promise<void> {
    // WeChat now uses ProseMirror (not UEditor iframe)
    const editor = await page.$('.ProseMirror');
    if (!editor) {
        await page.screenshot({ path: '/tmp/wechat-editor-debug.png' });
        throw new Error('找不到微信编辑区域(.ProseMirror)，截图已保存到 /tmp/wechat-editor-debug.png');
    }

    await editor.click();
    await page.waitForTimeout(300);
    // Select all existing content
    await page.keyboard.press(`${MODIFIER_KEY}+a`);
    await page.waitForTimeout(100);

    await page.evaluate((htmlContent) => {
        const dt = new DataTransfer();
        dt.setData('text/html', htmlContent);
        dt.setData('text/plain', '');
        const target = document.querySelector('.ProseMirror') as HTMLElement;
        if (!target) return;
        target.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt,
        }));
    }, html);

    await page.waitForTimeout(2000);
    console.log('内容已注入编辑器');
}

async function waitForImageUploads(page: Page): Promise<void> {
    console.log('等待图片上传完成...');
    const maxWait = 120000; // WeChat image upload can be slow
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        const hasLoading = await page.evaluate(() => {
            const selectors = ['.uploading', '[class*="upload_loading"]', '.img_loading'];
            return selectors.some(sel => document.querySelector(sel) !== null);
        });
        if (!hasLoading) break;
        await page.waitForTimeout(1500);
    }

    console.log('图片上传完成');
}

async function clickPublish(page: Page): Promise<void> {
    // WeChat has a "群发" (mass send) flow, but for service accounts we look for publish/preview
    const publishSelectors = [
        'button:has-text("发布")',
        'button:has-text("群发")',
        'a:has-text("发布")',
        '#js_submit',
    ];

    for (const sel of publishSelectors) {
        const btn = await page.$(sel);
        if (btn) {
            await btn.click();
            await page.waitForTimeout(3000);
            return;
        }
    }
    throw new Error('找不到发布按钮，内容已保存为草稿');
}
