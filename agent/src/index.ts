#!/usr/bin/env node
import { program } from 'commander';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFeishuDocument } from './feishu.js';
import { makeZhihuCompatibleHtml } from './zhihuTransform.js';
import { loginZhihu, publishToZhihu } from './publishers/zhihu.js';

// Load .env from agent/ directory
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

// ─── login command ────────────────────────────────────────────────────────────

program
    .command('login <platform>')
    .description('Log in to a publishing platform (saves session)')
    .action(async (platform: string) => {
        if (platform === 'zhihu') {
            await loginZhihu();
        } else {
            console.error(`Unknown platform: ${platform}. Supported: zhihu`);
            process.exit(1);
        }
    });

// ─── publish command ──────────────────────────────────────────────────────────

program
    .command('publish')
    .description('Publish a Feishu document to Zhihu')
    .requiredOption('--doc <url>', 'Feishu document or wiki URL')
    .option('--publish', 'Publish immediately instead of saving as draft', false)
    .action(async (opts: { doc: string; publish: boolean }) => {
        const appId = requireEnv('FEISHU_APP_ID');
        const appSecret = requireEnv('FEISHU_APP_SECRET');
        const imgbbApiKey = requireEnv('IMGBB_API_KEY');

        console.log('Step 1/3: Reading Feishu document...');
        const doc = await readFeishuDocument(opts.doc, appId, appSecret);
        console.log(`Title: ${doc.title}`);

        console.log('Step 2/3: Transforming HTML for Zhihu...');
        const zhihuHtml = await makeZhihuCompatibleHtml(doc.html, imgbbApiKey);

        console.log('Step 3/3: Publishing to Zhihu...');
        await publishToZhihu({
            title: doc.title,
            html: zhihuHtml,
            publish: opts.publish,
        });

        console.log('\nDone!');
    });

program.parse();
