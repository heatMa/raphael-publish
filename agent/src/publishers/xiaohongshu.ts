import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import type { XiaohongshuDraft } from '../xiaohongshuTransform.js';

const PROFILE_DIR = path.join(os.homedir(), '.raphael-agent', 'xiaohongshu-profile');
const CREATOR_HOME = 'https://creator.xiaohongshu.com/';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';
const MODIFIER_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
const KEEP_BROWSER_OPEN = process.env.RAPHAEL_KEEP_BROWSER_OPEN === '1';
const REMOTE_DEBUGGING_PORT = 9223;
const CDP_URL = `http://127.0.0.1:${REMOTE_DEBUGGING_PORT}`;

interface UploadPayload {
    name: string;
    mimeType: string;
    buffer: Buffer;
}

interface DebugTarget {
    id: string;
    type: string;
    url: string;
}

function getChromiumExecutablePath(): string {
    return chromium.executablePath();
}

async function isBrowserReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${CDP_URL}/json/version`);
        return res.ok;
    } catch {
        return false;
    }
}

async function getWebSocketDebuggerUrl(): Promise<string> {
    const res = await fetch(`${CDP_URL}/json/version`);
    if (!res.ok) {
        throw new Error(`无法获取小红书调试浏览器 websocket 地址: HTTP ${res.status}`);
    }
    const json = await res.json() as { webSocketDebuggerUrl?: string };
    if (!json.webSocketDebuggerUrl) {
        throw new Error('小红书调试浏览器未返回 websocket 调试地址');
    }
    return json.webSocketDebuggerUrl;
}

async function listDebugTargets(): Promise<DebugTarget[]> {
    const res = await fetch(`${CDP_URL}/json/list`);
    if (!res.ok) {
        throw new Error(`无法获取小红书调试浏览器标签页列表: HTTP ${res.status}`);
    }
    return await res.json() as DebugTarget[];
}

async function createDebugTarget(url: string): Promise<void> {
    const encodedUrl = encodeURIComponent(url);
    const res = await fetch(`${CDP_URL}/json/new?${encodedUrl}`, { method: 'PUT' });
    if (!res.ok) {
        throw new Error(`无法为小红书调试浏览器创建新标签页: HTTP ${res.status}`);
    }
}

function activateManagedBrowser(): void {
    if (process.platform !== 'darwin') return;

    const activator = spawn('osascript', [
        '-e',
        'tell application "Google Chrome for Testing" to activate',
    ], {
        detached: true,
        stdio: 'ignore',
    });
    activator.unref();
}

function setManagedBrowserActiveTabUrl(url: string): void {
    if (process.platform !== 'darwin') return;

    const escapedUrl = url.replace(/"/g, '\\"');
    const activator = spawn('osascript', [
        '-e',
        'tell application "Google Chrome for Testing" to activate',
        '-e',
        'tell application "Google Chrome for Testing"',
        '-e',
        'if (count of windows) > 0 then',
        '-e',
        `tell active tab of front window to set URL to "${escapedUrl}"`,
        '-e',
        'end if',
        '-e',
        'end tell',
    ], {
        detached: true,
        stdio: 'ignore',
    });
    activator.unref();
}

function getProfileBrowserPids(): number[] {
    const ps = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    if (ps.status !== 0) return [];

    return ps.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line =>
            line.includes('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') &&
            line.includes(`--user-data-dir=${PROFILE_DIR}`)
        )
        .map(line => Number(line.split(/\s+/, 1)[0]))
        .filter(pid => Number.isFinite(pid));
}

function killProfileBrowsers(): void {
    for (const pid of getProfileBrowserPids()) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // Best effort: process may already have exited.
        }
    }
}

async function waitForBrowserReady(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isBrowserReachable()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('小红书调试浏览器未能在预期时间内启动');
}

async function launchManagedBrowser(url: string): Promise<void> {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const child = spawn(getChromiumExecutablePath(), [
        `--user-data-dir=${PROFILE_DIR}`,
        `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
        '--no-sandbox',
        url,
    ], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    activateManagedBrowser();
    await waitForBrowserReady();
}

async function ensureManagedBrowser(url: string): Promise<void> {
    if (await isBrowserReachable()) {
        activateManagedBrowser();
        return;
    }

    if (getProfileBrowserPids().length > 0) {
        console.log('检测到旧版小红书调试浏览器实例，正在重启为可复用模式...');
        killProfileBrowsers();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await launchManagedBrowser(url);
}

function isDisposablePage(url: string): boolean {
    return (
        !url ||
        url === 'about:blank' ||
        url.startsWith('chrome://new-tab-page') ||
        url.startsWith('chrome://newtab') ||
        url.startsWith('devtools://')
    );
}

function isManagedPage(url: string, targetOrigin: string): boolean {
    return isDisposablePage(url) || url.startsWith(targetOrigin);
}

async function normalizeManagedTargets(targetUrl: string): Promise<void> {
    const targetOrigin = new URL(targetUrl).origin;
    const pageTargets = (await listDebugTargets()).filter(target => target.type === 'page');
    if (pageTargets.length <= 1) return;

    const keepTarget =
        pageTargets.find(target => target.url === targetUrl) ||
        pageTargets.find(target => target.url.startsWith(targetOrigin)) ||
        pageTargets.find(target => !isDisposablePage(target.url)) ||
        pageTargets[0];

    if (!keepTarget) return;

    const closableTargets = pageTargets.filter(target => (
        target.id !== keepTarget.id &&
        isManagedPage(target.url, targetOrigin)
    ));

    await Promise.all(closableTargets.map(async target => {
        try {
            await fetch(`${CDP_URL}/json/close/${target.id}`);
        } catch {
            // Best effort: target may already be gone.
        }
    }));
}

async function ensureDebugPageTarget(url: string): Promise<void> {
    const pageTargets = (await listDebugTargets()).filter(target => target.type === 'page');
    if (pageTargets.length > 0) return;
    await createDebugTarget(url);
}

function pickManagedPage(context: BrowserContext, targetUrl: string): Page | null {
    const openPages = context.pages().filter(page => !page.isClosed());
    if (openPages.length === 0) return null;

    const targetOrigin = new URL(targetUrl).origin;

    return (
        openPages.find(page => page.url() === targetUrl) ||
        openPages.find(page => page.url().startsWith(targetOrigin)) ||
        openPages.find(page => !isDisposablePage(page.url())) ||
        openPages[0] ||
        null
    );
}

async function closeExtraManagedPages(
    context: BrowserContext,
    keepPage: Page,
    targetUrl: string
): Promise<void> {
    const targetOrigin = new URL(targetUrl).origin;
    const openPages = context.pages().filter(page => !page.isClosed());
    for (const page of openPages) {
        if (page === keepPage) continue;
        if (!isManagedPage(page.url(), targetOrigin)) continue;
        await page.close().catch(() => undefined);
    }
}

async function connectManagedBrowser(url: string): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
    createdPage: boolean;
}> {
    await ensureManagedBrowser(url);
    await ensureDebugPageTarget(url);
    await normalizeManagedTargets(url);

    const browser = await chromium.connectOverCDP(await getWebSocketDebuggerUrl());
    const context = browser.contexts()[0];
    if (!context) throw new Error('无法连接到小红书调试浏览器上下文');

    let createdPage = false;
    let page = pickManagedPage(context, url);
    if (!page) {
        page = await context.newPage();
        createdPage = true;
    }

    await closeExtraManagedPages(context, page, url);
    await page.bringToFront().catch(() => undefined);
    activateManagedBrowser();
    return { browser, context, page, createdPage };
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

export async function loginXiaohongshu(): Promise<void> {
    const { page } = await connectManagedBrowser(CREATOR_HOME);
    page.on('dialog', async dialog => {
        await dialog.dismiss().catch(() => undefined);
    });
    await page.goto(CREATOR_HOME, { waitUntil: 'networkidle' });
    console.log('\n请在浏览器中登录小红书创作服务平台，完成后按 Enter 继续...');
    await waitForEnter();
    console.log('登录信息已保存。');
}

export async function openXiaohongshuProfile(): Promise<void> {
    const { page } = await connectManagedBrowser(PUBLISH_URL);
    await page.goto(PUBLISH_URL, { waitUntil: 'networkidle' });

    if (await isLoginRequired(page)) {
        throw new Error('未登录小红书，请先运行: pnpm --dir agent run login:xiaohongshu');
    }

    await openDraftBox(page);
    console.log(`Opened xiaohongshu Playwright profile and draft box: ${PROFILE_DIR}`);
}

export interface XiaohongshuPublishOptions {
    draft: XiaohongshuDraft;
    publish?: boolean;
}

export async function publishToXiaohongshu(opts: XiaohongshuPublishOptions): Promise<void> {
    const { draft, publish = false } = opts;
    const noteMode = draft.mode ?? (draft.images.length > 0 ? 'image' : 'longform');

    if (publish) {
        throw new Error('小红书 v1 仅支持保存草稿，请不要传 --publish');
    }

    const { page, createdPage } = await connectManagedBrowser(PUBLISH_URL);
    page.on('dialog', async dialog => {
        await dialog.dismiss().catch(() => undefined);
    });

    try {
        console.log('Opening Xiaohongshu creator...');
        await page.goto(PUBLISH_URL, { waitUntil: 'networkidle' });

        if (await isLoginRequired(page)) {
            throw new Error('未登录小红书，请先运行: pnpm --dir agent run login:xiaohongshu');
        }

        if (noteMode === 'image') {
            await ensureImageNoteMode(page);
            await uploadImages(page, draft.images);
            await ensureEditorReadyAfterUpload(page);
        } else {
            await ensureLongFormEditorReady(page);
        }

        await setTitle(page, draft.title);
        await setBody(page, draft);
        await saveDraft(page, noteMode);
        await page.waitForTimeout(3000);

        if (KEEP_BROWSER_OPEN) {
            console.log('\n调试模式已开启，浏览器窗口将保持打开。请检查页面后按 Enter 关闭...');
            await waitForEnter();
        }
    } finally {
        if (!KEEP_BROWSER_OPEN && createdPage && !page.isClosed()) {
            await page.close().catch(() => undefined);
        }
    }
}

async function isLoginRequired(page: Page): Promise<boolean> {
    if (page.url().includes('login')) return true;
    return await page.evaluate(() => {
        const text = document.body.innerText;
        if (text.includes('登录') && (text.includes('手机号') || text.includes('验证码') || text.includes('扫码登录'))) {
            return true;
        }
        return false;
    });
}

async function ensureImageNoteMode(page: Page): Promise<void> {
    const switched = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        const candidates: Element[] = [];

        for (const element of allElements) {
            const text = (element.textContent || '').replace(/\s+/g, '');
            if (text !== '上传图文' && text !== '图文') continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            candidates.push(element);
        }

        candidates.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            return rectA.top - rectB.top || rectA.left - rectB.left;
        });

        let topCandidate = candidates[0];
        for (const candidate of candidates) {
            if (candidate.getBoundingClientRect().top < 220) {
                topCandidate = candidate;
                break;
            }
        }

        if (!topCandidate) return false;

        (topCandidate as HTMLElement).click();
        return true;
    });

    if (switched) {
        await page.waitForTimeout(1000);
        console.log('已切换到图文发布模式');
        return;
    }

    await page.screenshot({ path: '/tmp/xiaohongshu-mode-debug.png' });
    throw new Error('找不到小红书图文发布页签，截图已保存到 /tmp/xiaohongshu-mode-debug.png');
}

async function ensureLongFormEditorReady(page: Page): Promise<void> {
    const switched = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        const candidate = allElements.find(element => {
            const text = (element.textContent || '').replace(/\s+/g, '');
            if (text !== '写长文') return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });

        if (!candidate) return false;
        (candidate as HTMLElement).click();
        return true;
    });

    if (!switched) {
        await page.screenshot({ path: '/tmp/xiaohongshu-longform-mode-debug.png' });
        throw new Error('找不到小红书长文入口，截图已保存到 /tmp/xiaohongshu-longform-mode-debug.png');
    }

    await page.waitForTimeout(1000);

    if (await hasTitleInput(page)) {
        console.log('已进入长文编辑模式');
        return;
    }

    const created = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        const candidate = allElements.find(element => {
            const text = (element.textContent || '').replace(/\s+/g, '');
            if (text !== '新的创作') return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });

        if (!candidate) return false;
        (candidate as HTMLElement).click();
        return true;
    });

    if (!created) {
        await page.screenshot({ path: '/tmp/xiaohongshu-longform-create-debug.png' });
        throw new Error('找不到小红书长文“新的创作”按钮，截图已保存到 /tmp/xiaohongshu-longform-create-debug.png');
    }

    const ready = await waitForTitleInput(page, 15000);
    if (!ready) {
        await page.screenshot({ path: '/tmp/xiaohongshu-longform-editor-debug.png' });
        throw new Error('小红书长文编辑器未成功打开，截图已保存到 /tmp/xiaohongshu-longform-editor-debug.png');
    }

    console.log('已切换到长文发布模式');
}

async function getPreferredDraftTab(page: Page): Promise<'图文笔记' | '长文笔记' | '视频笔记' | null> {
    return await page.evaluate(async () => {
        const openReq = indexedDB.open('draft-database-v1');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            openReq.onerror = () => reject(openReq.error);
            openReq.onsuccess = () => resolve(openReq.result);
        }).catch(() => null);

        if (!db) return null;

        const storeToTab: Record<string, '图文笔记' | '长文笔记' | '视频笔记'> = {
            'image-draft': '图文笔记',
            'article-draft': '长文笔记',
            'video-draft': '视频笔记',
        };

        let preferred: { tab: '图文笔记' | '长文笔记' | '视频笔记'; timeStamp: number } | null = null;

        for (const storeName of Array.from(db.objectStoreNames)) {
            if (!(storeName in storeToTab)) continue;
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const all = await new Promise<any[]>((resolve, reject) => {
                const req = store.getAll();
                req.onerror = () => reject(req.error);
                req.onsuccess = () => resolve(req.result as any[]);
            }).catch(() => []);

            for (const item of all) {
                const timeStamp = Number(item?.timeStamp || 0);
                if (!preferred || timeStamp > preferred.timeStamp) {
                    preferred = { tab: storeToTab[storeName], timeStamp };
                }
            }
        }

        db.close();
        return preferred?.tab || null;
    });
}

async function openDraftBox(page: Page): Promise<void> {
    const draftButton = page.locator('text=/草稿箱/').first();
    await draftButton.waitFor({ state: 'visible', timeout: 10000 });
    await draftButton.click();
    await page.waitForTimeout(800);

    const preferredTab = await getPreferredDraftTab(page);
    if (!preferredTab) return;

    const tab = page.locator(`text=${preferredTab}`).first();
    if (await tab.count()) {
        await tab.click().catch(() => undefined);
        await page.waitForTimeout(500);
    }
}

function dataUrlToPayload(dataUrl: string, index: number): UploadPayload | null {
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;

    const mimeType = match[1];
    const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    return {
        name: `xiaohongshu-image-${index + 1}.${extension}`,
        mimeType,
        buffer: Buffer.from(match[2], 'base64'),
    };
}

async function uploadImages(page: Page, images: string[]): Promise<void> {
    const payloads = images
        .map((image, index) => dataUrlToPayload(image, index))
        .filter((payload): payload is UploadPayload => payload !== null)
        .slice(0, 18);

    if (payloads.length === 0) {
        console.log('No uploadable images found, skipping image upload.');
        return;
    }

    const uploadButtonSelectors = [
        'button:has-text("上传图片")',
        'button:has-text("上传图文")',
        'text=上传图片',
    ];

    for (const selector of uploadButtonSelectors) {
        const button = await page.$(selector);
        if (!button) continue;

        try {
            const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
            await button.click();
            const chooser = await fileChooserPromise;
            if (!chooser) continue;
            await chooser.setFiles(payloads);
            await waitForUploads(page);
            console.log(`已上传 ${payloads.length} 张图片`);
            return;
        } catch {
            // Fall through to other strategies.
        }
    }

    const selectors = [
        'input[type="file"][accept*="image"]',
        'input.upload-input',
        'input[type="file"]',
    ];

    for (const selector of selectors) {
        const input = await page.$(selector);
        if (!input) continue;
        await input.setInputFiles(payloads);
        await waitForUploads(page);
        console.log(`已上传 ${payloads.length} 张图片`);
        return;
    }

    await page.screenshot({ path: '/tmp/xiaohongshu-upload-debug.png' });
    throw new Error('找不到小红书图片上传控件，截图已保存到 /tmp/xiaohongshu-upload-debug.png');
}

async function waitForUploads(page: Page): Promise<void> {
    const maxWait = 120000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        const uploading = await page.evaluate(() => {
            const selectors = ['[class*="upload"][class*="progress"]', '[class*="upload"][class*="loading"]', '[class*="status"][class*="upload"]'];
            return selectors.some(selector => document.querySelector(selector) !== null);
        });

        if (!uploading) break;
        await page.waitForTimeout(1500);
    }
}

async function ensureEditorReadyAfterUpload(page: Page): Promise<void> {
    if (await waitForTitleInput(page, 15000)) return;

    await page.screenshot({ path: '/tmp/xiaohongshu-upload-state-debug.png' });
    throw new Error('图片上传后未进入小红书编辑态，截图已保存到 /tmp/xiaohongshu-upload-state-debug.png');
}

async function hasTitleInput(page: Page): Promise<boolean> {
    const titleSelectors = [
        'input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        '[contenteditable="true"][placeholder*="标题"]',
        '[contenteditable="true"][data-placeholder*="标题"]',
    ];

    for (const selector of titleSelectors) {
        if (await page.$(selector)) return true;
    }
    return false;
}

async function waitForTitleInput(page: Page, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await hasTitleInput(page)) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function fillInput(handle: ElementHandle<HTMLElement>, value: string): Promise<void> {
    await handle.click({ clickCount: 3 });
    await handle.press(`${MODIFIER_KEY}+A`);
    await handle.press('Backspace');

    const tagName = await handle.evaluate(node => node.tagName);
    if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
        await handle.fill(value);
        return;
    }

    await handle.evaluate((node, nextValue) => {
        node.textContent = '';
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '' }));
        node.textContent = nextValue;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue, inputType: 'insertText' }));
    }, value);
}

async function setTitle(page: Page, title: string): Promise<void> {
    const selectors = [
        'input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        '[contenteditable="true"][placeholder*="标题"]',
        '[contenteditable="true"][data-placeholder*="标题"]',
    ];

    for (const selector of selectors) {
        const handle = await page.$(selector) as ElementHandle<HTMLElement> | null;
        if (!handle) continue;
        await fillInput(handle, title);
        console.log(`标题已设置: ${title}`);
        return;
    }

    await page.screenshot({ path: '/tmp/xiaohongshu-title-debug.png' });
    throw new Error('找不到小红书标题输入框，截图已保存到 /tmp/xiaohongshu-title-debug.png');
}

async function setBody(page: Page, draft: XiaohongshuDraft): Promise<void> {
    const { bodyText, bodyHtml, mode } = draft;
    const selectors = [
        '[contenteditable="true"][data-placeholder*="正文"]',
        '[contenteditable="true"][placeholder*="正文"]',
        '.ql-editor',
        '.ProseMirror',
        'textarea[placeholder*="正文"]',
    ];

    let editor = null as ElementHandle<HTMLElement> | null;
    for (const selector of selectors) {
        editor = await page.$(selector) as ElementHandle<HTMLElement> | null;
        if (editor) break;
    }

    if (!editor) {
        const editors = await page.$$('[contenteditable="true"]') as ElementHandle<HTMLElement>[];
        editor = editors[editors.length - 1] || null;
    }

    if (!editor) {
        await page.screenshot({ path: '/tmp/xiaohongshu-editor-debug.png' });
        throw new Error('找不到小红书正文编辑器，截图已保存到 /tmp/xiaohongshu-editor-debug.png');
    }

    await editor.click();
    await page.waitForTimeout(300);
    await page.keyboard.press(`${MODIFIER_KEY}+A`);
    await page.keyboard.press('Backspace');

    if (mode === 'longform') {
        if (containsUnsupportedBoldMarkup(bodyHtml)) {
            console.log('检测到加粗格式，但当前小红书长文编辑器只支持标题、列表、引用和高亮，不支持加粗 mark，已按普通文本写入该部分内容。');
        }

        const appliedByEditor = await editor.evaluate((node, html) => {
            const tiptapEditor = (node as HTMLElement & { editor?: { commands?: Record<string, (...args: unknown[]) => unknown> } }).editor;
            if (!tiptapEditor?.commands?.setContent) return false;

            tiptapEditor.commands.focus?.();
            tiptapEditor.commands.clearContent?.();
            return tiptapEditor.commands.setContent(html);
        }, bodyHtml).catch(() => false);

        if (appliedByEditor) {
            await page.waitForTimeout(400);
            if (await hasExpectedLongformStructure(editor, bodyText, bodyHtml)) {
                console.log('正文已写入');
                return;
            }
        }
    }

    await page.evaluate(({ html, text, useHtml }) => {
        const clipboardData = new DataTransfer();
        if (useHtml && html) {
            clipboardData.setData('text/html', html);
        }
        clipboardData.setData('text/plain', text);
        const event = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData,
        });
        const active = document.activeElement as HTMLElement | null;
        active?.dispatchEvent(event);
    }, {
        html: mode === 'longform' ? bodyHtml : '',
        text: bodyText,
        useHtml: mode === 'longform',
    });

    await page.waitForTimeout(600);

    const hasExpectedStructure = mode === 'longform'
        ? await hasExpectedLongformStructure(editor, bodyText, bodyHtml)
        : await editor.evaluate((node, text) => {
            const current = (node.textContent || '').trim();
            return current.length > 0 && current.includes(text.slice(0, Math.min(8, text.length)));
        }, bodyText);

    if (!hasExpectedStructure) {
        await page.keyboard.insertText(bodyText);
    }

    console.log('正文已写入');
}

function containsUnsupportedBoldMarkup(html: string): boolean {
    return /<(strong|b)[\s>]/i.test(html);
}

async function hasExpectedLongformStructure(
    editor: ElementHandle<HTMLElement>,
    bodyText: string,
    bodyHtml: string
): Promise<boolean> {
    return await editor.evaluate((node, payload) => {
        const current = (node.textContent || '').trim();
        if (!(current.length > 0 && current.includes(payload.text.slice(0, Math.min(8, payload.text.length))))) {
            return false;
        }

        const html = (node as HTMLElement).innerHTML || '';
        const checks: Array<[boolean, boolean]> = [
            [/<h1[\s>]/i.test(payload.html), /<h1[\s>]/i.test(html)],
            [/<h2[\s>]/i.test(payload.html), /<h2[\s>]/i.test(html)],
            [/<ul[\s>]/i.test(payload.html), /<ul[\s>]/i.test(html)],
            [/<ol[\s>]/i.test(payload.html), /<ol[\s>]/i.test(html)],
            [/<blockquote[\s>]/i.test(payload.html), /<blockquote[\s>]/i.test(html)],
            [/<mark[\s>]/i.test(payload.html), /<mark[\s>]/i.test(html)],
        ];

        return checks.every(([expected, actual]) => !expected || actual);
    }, { text: bodyText, html: bodyHtml });
}

async function saveDraft(page: Page, noteMode: 'image' | 'longform'): Promise<void> {
    const saveSelectors = [
        'button:has-text("暂存离开")',
        'button:has-text("保存草稿")',
        'button:has-text("保存")',
        'button:has-text("草稿")',
    ];

    await dismissTransientOverlays(page);

    for (const selector of saveSelectors) {
        const button = await page.$(selector);
        if (!button) continue;

        try {
            await button.click({ timeout: 2000 });
        } catch {
            await button.evaluate(node => (node as HTMLElement).click());
        }

        await waitForDraftSave(page);
        if (noteMode === 'image') {
            console.log('文章已保存为草稿。注意：小红书图文草稿保存在当前 Playwright 浏览器本地，不会自动同步到你日常浏览器。');
        } else {
            console.log('文章已保存为长文草稿。注意：小红书长文草稿同样保存在当前 Playwright 浏览器本地，不会自动同步到你日常浏览器。');
        }
        return;
    }

    await page.keyboard.press(`${MODIFIER_KEY}+s`).catch(() => undefined);
    await page.waitForTimeout(2500);
    console.log('未找到显式草稿按钮，已等待自动保存完成。请在小红书草稿箱确认。');
}

async function dismissTransientOverlays(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(150);

    await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        active?.blur();
        const body = document.body as HTMLElement | null;
        body?.click();
    }).catch(() => undefined);

    await page.mouse.click(12, 12).catch(() => undefined);
    await page.waitForTimeout(300);
}

async function waitForDraftSave(page: Page): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 15000) {
        const url = page.url();
        if (url.includes('/new/home') || url.includes('/publish/success') || url.includes('/manage')) {
            return;
        }

        const bodyText = await page.locator('body').innerText().catch(() => '');
        if (bodyText.includes('笔记管理') || bodyText.includes('发布成功') || bodyText.includes('全部笔记')) {
            return;
        }

        await page.waitForTimeout(500);
    }
}
