#!/usr/bin/env node
import { program } from 'commander';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFeishuDocument } from './feishu.js';
import { makeZhihuCompatibleHtml } from './zhihuTransform.js';
import { makeWeChatCompatibleHtml } from './wechatTransform.js';
import { loginZhihu, publishToZhihu } from './publishers/zhihu.js';
import { loginWechat, publishToWechat } from './publishers/wechat.js';
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

// ─── login ────────────────────────────────────────────────────────────────────

program
    .command('login <platform>')
    .description('Log in to a publishing platform and save session (zhihu | wechat)')
    .action(async (platform: string) => {
        if (platform === 'zhihu') {
            await loginZhihu();
        } else if (platform === 'wechat') {
            await loginWechat();
        } else {
            console.error(`Unknown platform: ${platform}. Supported: zhihu, wechat`);
            process.exit(1);
        }
    });

// ─── publish ──────────────────────────────────────────────────────────────────

program
    .command('publish')
    .description('Publish a Feishu document to one or more platforms')
    .requiredOption('--doc <url>', 'Feishu document or wiki URL')
    .option('--to <platforms>', 'Comma-separated platforms: zhihu, wechat (default: zhihu)', 'zhihu')
    .option('--theme <themeId>', 'Theme id for WeChat output (for example: apple, claude, github)', 'apple')
    .option('--publish', 'Publish immediately instead of saving as draft', false)
    .action(async (opts: { doc: string; to: string; theme: string; publish: boolean }) => {
        const appId = requireEnv('FEISHU_APP_ID');
        const appSecret = requireEnv('FEISHU_APP_SECRET');

        const platforms = opts.to.split(',').map(s => s.trim().toLowerCase());
        const toZhihu = platforms.includes('zhihu');
        const toWechat = platforms.includes('wechat');
        const themeId = resolveTheme(opts.theme);

        if (!toZhihu && !toWechat) {
            console.error('Unknown platforms. Use --to zhihu, --to wechat, or --to zhihu,wechat');
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

        console.log('\nAll done!');
    });

program.parse();
