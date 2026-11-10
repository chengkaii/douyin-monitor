import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { countAccounts, upsertAccountText } from '../src/account-file.js';

const SEC_A = 'MS4wLjABAAAAdu8I0mIDajXSXZZvtY79M';
const SEC_B = 'MS4wLjABAAAAanotherAccount1234567';

const TEMPLATE = fs.readFileSync(path.resolve('accounts.example.yaml'), 'utf8');

test('从模板录入：保留注释与其它配置段，清掉 REPLACE_ME 占位账号', () => {
  assert.equal(countAccounts(TEMPLATE), 1);
  const r = upsertAccountText(TEMPLATE, SEC_A, '账号1');
  assert.equal(r.added, true);
  assert.equal(r.existingCount, 1);

  assert.match(r.text, /# 监测账号清单/);
  assert.match(r.text, /polling:/);
  assert.match(r.text, /timeZone: Asia\/Shanghai/);
  assert.match(r.text, /retry:/);
  assert.doesNotMatch(r.text, /REPLACE_ME/);
  assert.match(r.text, /enabled: true\n\npolling:/, '账号段与下一个顶级段之间保留空行');

  const doc = parseYaml(r.text) as Record<string, unknown>;
  const accounts = doc['accounts'] as Array<Record<string, unknown>>;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.['name'], '账号1');
  assert.equal(accounts[0]?.['sec_user_id'], SEC_A);
  assert.equal(accounts[0]?.['enabled'], true);
});

test('重复 sec_user_id 原样返回，不改动文件', () => {
  const first = upsertAccountText(TEMPLATE, SEC_A, '账号1');
  const again = upsertAccountText(first.text, SEC_A, '换个名字');
  assert.equal(again.added, false);
  assert.match(again.reason ?? '', /已在账号清单/);
  assert.equal(again.text, first.text);
});

test('追加第二个账号时保留已有条目与顺序', () => {
  const first = upsertAccountText(TEMPLATE, SEC_A, '账号1');
  const second = upsertAccountText(first.text, SEC_B, '账号2');
  assert.equal(second.added, true);
  const doc = parseYaml(second.text) as Record<string, unknown>;
  const accounts = doc['accounts'] as Array<Record<string, unknown>>;
  assert.deepEqual(accounts.map((a) => a['sec_user_id']), [SEC_A, SEC_B]);
  assert.ok(second.text.indexOf(SEC_A) < second.text.indexOf(SEC_B));
});

test('原文件没有 accounts 段时，在末尾追加且保留原内容', () => {
  const original = '# 只有注释\npolling:\n  intervalMinutes: 5\n';
  const r = upsertAccountText(original, SEC_A, 'A');
  assert.equal(r.added, true);
  assert.match(r.text, /# 只有注释/);
  assert.match(r.text, /polling:/);
  const doc = parseYaml(r.text) as Record<string, unknown>;
  assert.equal((doc['accounts'] as unknown[]).length, 1);
});

test('accounts: [] 空列表写法能正确转成块列表', () => {
  const original = 'accounts: []\npolling:\n  intervalMinutes: 5\n';
  const r = upsertAccountText(original, SEC_A, 'A');
  const doc = parseYaml(r.text) as Record<string, unknown>;
  const accounts = doc['accounts'] as Array<Record<string, unknown>>;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.['sec_user_id'], SEC_A);
  assert.equal(doc['polling'] !== undefined, true);
});

test('昵称里的引号与换行被转义，不破坏 YAML', () => {
  const r = upsertAccountText(TEMPLATE, SEC_A, '带"引号"\n换行');
  const doc = parseYaml(r.text) as Record<string, unknown>;
  const accounts = doc['accounts'] as Array<Record<string, unknown>>;
  assert.equal(accounts[0]?.['name'], '带"引号" 换行');
});
