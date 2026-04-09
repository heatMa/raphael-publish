#!/usr/bin/env node
import { program } from 'commander';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { readFeishuDocument } from './feishu.js';
import { makeZhihuCompatibleHtml } from './zhihuTransform.js';
import { makeWeChatCompatibleHtml } from './wechatTransform.js';
import { makeXiaohongshuCompatibleDraft } from './xiaohongshuTransform.js';
import { loginZhihu, publishToZhihu } from './publishers/zhihu.js';
import { loginWechat, publishToWechat } from './publishers/wechat.js';
import { loginXiaohongshu, openXiaohongshuProfile, publishToXiaohongshu } from './publishers/xiaohongshu.js';
import { THEMES } from '../../src/lib/themes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env') });

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) {
        console.error(`Error: ${key} is not set in agent/.env`);
        process.exit(1);
    }
    return val;
}

function resolveTheme(themeId: string): string {
    const normalizedThemeId = themeId.trim().toLowerCase();
    const isSupported = THEMES.some(theme => theme.id === normalizedThemeId);

    if (!isSupported) {
        const supportedThemes = THEMES.map(theme => `${theme.id} (${theme.name})`).join(', ');
        console.error(`Unknown theme: ${themeId}`);
        console.error(`Supported themes: ${supportedThemes}`);
        process.exit(1);
    }

    return normalizedThemeId;
}

function getProfileDir(platform: string): string {
    const profileBaseDir = path.join(process.env.HOME || '', '.raphael-agent');
    const profileMap: Record<string, string> = {
        zhihu: path.join(profileBaseDir, 'zhihu-profile'),
        wechat: path.join(profileBaseDir, 'wechat-profile'),
        xiaohongshu: path.join(profileBaseDir, 'xiaohongshu-profile'),
    };

    const profileDir = profileMap[platform];
    if (!profileDir) {
        console.error(`Unknown platform: ${platform}. Supported: zhihu, wechat, xiaohongshu`);
        process.exit(1);
    }
    return profileDir;
}

function getProfileUrl(platform: string): string {
    const urlMap: Record<string, string> = {
        zhihu: 'https://zhuanlan.zhihu.com/write',
        wechat: 'https://mp.weixin.qq.com/',
        xiaohongshu: 'https://creator.xiaohongshu.com/new/home',
    };

    const profileUrl = urlMap[platform];
    if (!profileUrl) {
        console.error(`Unknown platform: ${platform}. Supported: zhihu, wechat, xiaohongshu`);
        process.exit(1);
    }
    return profileUrl;
}

function getChromiumAppPath(): string {
    const executablePath = chromium.executablePath();
    if (process.platform === 'darwin') {
        return executablePath.replace(/\/Contents\/MacOS\/[^/]+$/, '.app');
    }
    return executablePath;
}

function openBrowserProfile(platform: string): void {
    const profileDir = getProfileDir(platform);
    const profileUrl = getProfileUrl(platform);
    const appPath = getChromiumAppPath();

    if (process.platform === 'darwin') {
        const child = spawn('open', ['-na', appPath, '--args', `--user-data-dir=${profileDir}`, profileUrl], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();

        const appName = path.basename(appPath, '.app');
        const activator = spawn('osascript', [
            '-e',
            `tell application "${appName}" to activate`,
            '-e',
            `tell application "${appName}" to open location "${profileUrl}"`,
        ], {
            detached: true,
            stdio: 'ignore',
        });
        activator.unref();
    } else {
        const child = spawn(appPath, [`--user-data-dir=${profileDir}`, profileUrl], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }

    console.log(`Opened ${platform} Playwright profile: ${profileDir}`);
}

// ─── login ────────────────────────────────────────────────────────────────────

program
    .command('login <platform>')
    .description('Log in to a publishing platform and save session (zhihu | wechat | xiaohongshu)')
    .action(async (platform: string) => {
        if (platform === 'zhihu') {
            await loginZhihu();
        } else if (platform === 'wechat') {
            await loginWechat();
        } else if (platform === 'xiaohongshu') {
            await loginXiaohongshu();
        } else {
            console.error(`Unknown platform: ${platform}. Supported: zhihu, wechat, xiaohongshu`);
            process.exit(1);
        }
    });

program
    .command('open-profile <platform>')
    .description('Open a saved Playwright browser profile (zhihu | wechat | xiaohongshu)')
    .action(async (platform: string) => {
        if (platform === 'xiaohongshu') {
            await openXiaohongshuProfile();
            return;
        }
        openBrowserProfile(platform);
    });

// ─── publish ──────────────────────────────────────────────────────────────────

program
    .command('publish')
    .description('Publish a Feishu document to one or more platforms')
    .requiredOption('--doc <url>', 'Feishu document or wiki URL')
    .option('--to <platforms>', 'Comma-separated platforms: zhihu, wechat, xiaohongshu (default: zhihu)', 'zhihu')
    .option('--theme <themeId>', 'Theme id for WeChat output (for example: apple, claude, github)', 'apple')
    .option('--publish', 'Publish immediately instead of saving as draft', false)
    .action(async (opts: { doc: string; to: string; theme: string; publish: boolean }) => {
        const appId = requireEnv('FEISHU_APP_ID');
        const appSecret = requireEnv('FEISHU_APP_SECRET');

        const platforms = opts.to.split(',').map(s => s.trim().toLowerCase());
        const toZhihu = platforms.includes('zhihu');
        const toWechat = platforms.includes('wechat');
        const toXiaohongshu = platforms.includes('xiaohongshu');
        const themeId = resolveTheme(opts.theme);

        if (!toZhihu && !toWechat && !toXiaohongshu) {
            console.error('Unknown platforms. Use --to zhihu, --to wechat, --to xiaohongshu, or combine them with commas');
            process.exit(1);
        }

        console.log(`\nPublishing to: ${platforms.join(', ')}`);
        console.log('─'.repeat(40));

        // Step 1: Read Feishu document (shared)
        console.log('\n[1/3] Reading Feishu document...');
        const doc = await readFeishuDocument(opts.doc, appId, appSecret);
        console.log(`Title: ${doc.title}`);

        // Step 2 & 3: Transform + publish per platform
        if (toZhihu) {
            const imgbbApiKey = requireEnv('IMGBB_API_KEY');
            console.log('\n[Zhihu] Transforming HTML...');
            const zhihuHtml = await makeZhihuCompatibleHtml(doc.html, imgbbApiKey);
            console.log('[Zhihu] Publishing...');
            await publishToZhihu({ title: doc.title, html: zhihuHtml, publish: opts.publish });
        }

        if (toWechat) {
            console.log(`\n[WeChat] Transforming HTML with theme: ${themeId}...`);
            const wechatHtml = makeWeChatCompatibleHtml(doc.html, themeId);
            console.log('[WeChat] Publishing...');
            await publishToWechat({ title: doc.title, html: wechatHtml, publish: opts.publish });
        }

        if (toXiaohongshu) {
            console.log('\n[Xiaohongshu] Transforming content...');
            const xiaohongshuDraft = makeXiaohongshuCompatibleDraft(doc);
            console.log('[Xiaohongshu] Publishing...');
            await publishToXiaohongshu({ draft: xiaohongshuDraft, publish: opts.publish });
        }

        console.log('\nAll done!');
    });

program.parse();
