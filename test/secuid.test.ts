import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractSecUid, isSecUid, resolveSecUid } from '../src/secuid.js';
import { loadConfig } from '../src/config.js';

const SEC = 'MS4wLjABAAAAdu8I0mIDajXSXZZvtY79M';

test('纯 sec_user_id 直接命中，不发网络请求', async () => {
  const r = await resolveSecUid(SEC, { fetchImpl: (async () => { throw new Error('不应发请求'); }) as typeof fetch });
  assert.equal(r.secUid, SEC);
  assert.equal(r.source, 'sec_uid');
});

test('主页链接（带 query）与分享文案都能抠出 /user/ 后的 id', async () => {
  assert.equal(extractSecUid(`https://www.douyin.com/user/${SEC}?from_tab_name=main`), SEC);
  assert.equal((await resolveSecUid(`https://www.douyin.com/user/${SEC}`)).source, 'user_url');
  const share = `长按复制此条消息，打开抖音搜索，查看TA的主页 https://www.douyin.com/user/${SEC} 复制此链接`;
  const r = await resolveSecUid(share);
  assert.equal(r.secUid, SEC);
  assert.equal(r.source, 'share_text');
});

test('非法输入给出可操作提示，不抛异常', async () => {
  assert.equal(extractSecUid(''), null);
  assert.equal(extractSecUid('随便一段文字'), null);
  const r = await resolveSecUid('随便一段文字');
  assert.equal(r.secUid, undefined);
  assert.match(r.error ?? '', /未找到抖音链接/);
  const evil = await resolveSecUid('https://evil.example.com/user/abc');
  assert.match(evil.error ?? '', /只允许解析 douyin.com/);
});

test('短链 HEAD 跟重定向拿到主页 id，且只请求抖音域', async () => {
  const calls: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(null, {
      status: 302,
      headers: { location: `https://www.douyin.com/user/${SEC}?from=share` },
    });
  }) as typeof fetch;
  const r = await resolveSecUid('https://v.douyin.com/abc123/', { fetchImpl: fake });
  assert.equal(r.secUid, SEC);
  assert.equal(r.source, 'short_link');
  assert.equal(calls.length, 1);
});

test('短链多跳：中途无 /user/ 时继续跟，命中即停', async () => {
  let hop = 0;
  const fake = (async () => {
    hop += 1;
    return new Response(null, {
      status: 302,
      headers: {
        location: hop === 1
          ? 'https://www.douyin.com/share/redirect/'
          : `https://www.douyin.com/user/${SEC}`,
      },
    });
  }) as typeof fetch;
  const r = await resolveSecUid('https://v.douyin.com/xyz/', { fetchImpl: fake });
  assert.equal(r.secUid, SEC);
  assert.equal(hop, 2);
});

test('重定向到非抖音域名一律拒绝（防 SSRF）', async () => {
  const fake = (async () => new Response(null, {
    status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' },
  })) as typeof fetch;
  const r = await resolveSecUid('https://v.douyin.com/abc/', { fetchImpl: fake });
  assert.equal(r.secUid, undefined);
  assert.match(r.error ?? '', /非抖音域名/);
});

test('短链网络失败时降级为「改粘主页链接」，不抛异常', async () => {
  const fake = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  const r = await resolveSecUid('https://v.douyin.com/abc/', { fetchImpl: fake });
  assert.equal(r.secUid, undefined);
  assert.match(r.error ?? '', /改粘/);
});

test('重跳用尽仍无 /user/ 时明确报错', async () => {
  const fake = (async () => new Response(null, {
    status: 302, headers: { location: 'https://www.douyin.com/still-short/' },
  })) as typeof fetch;
  const r = await resolveSecUid('https://v.douyin.com/abc/', { fetchImpl: fake, maxRedirects: 2 });
  assert.equal(r.secUid, undefined);
  assert.match(r.error ?? '', /没拿到 \/user\//);
});

test('isSecUid 能挡住占位值与短链', () => {
  assert.equal(isSecUid(SEC), true);
  assert.equal(isSecUid('MS4wLjABAAAA_REPLACE_ME'), true, '占位值形状合法，由 doctor 单独识别');
  assert.equal(isSecUid('https://v.douyin.com/abc/'), false);
  assert.equal(isSecUid('MS4w'), false);
});

test('accounts.yaml 里直接粘主页链接时，loadConfig 同步归一化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-secuid-'));
  const previous = process.env['ACCOUNTS_FILE'];
  try {
    const accountsPath = path.join(dir, 'accounts.yaml');
    fs.writeFileSync(
      accountsPath,
      `accounts:\n  - name: "A"\n    sec_user_id: "https://www.douyin.com/user/${SEC}?from=main"\n    enabled: true\n`,
      'utf8',
    );
    // ROOT 是模块加载时固定的，所以用绝对路径覆盖，而不是 chdir
    process.env['ACCOUNTS_FILE'] = accountsPath;
    const config = loadConfig();
    assert.equal(config.accounts.length, 1);
    assert.equal(config.accounts[0]?.secUserId, SEC);
  } finally {
    if (previous === undefined) delete process.env['ACCOUNTS_FILE'];
    else process.env['ACCOUNTS_FILE'] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
