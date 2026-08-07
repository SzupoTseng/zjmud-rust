#!/usr/bin/env node
// 為 telnet lib 產生 zjmud.metadata.<slug>.json —— 登入知識做成資料，不寫死在 client。
//
// 【WHY】使用者點名的形態：「所有 telnet mudlib 應該可以 extract 一份 zjmud
// 需要的 metadata，雖然不改他，但是可以產生 zjmud.metadata.mudname.json」。
// 這正是對的架構：profile 寫死在 client 裡，每接一台就要改 client 重部署；
// 抽成跟映像放在一起的 JSON 之後，接新 lib = 匯入映像 + 產生一份 metadata，
// client 一行都不用改。
//
// 【兩種來源】
//   ① 已調校的內建 profile（dongfanggushi2/nt7…）→ 直接匯出（權威）。
//   ② `--scan <logind檔>`：掃 mudlib 原始碼產生**草稿**——把已知的提示樣式
//      （英文名字/密码/性别/中文名字/email/(y/n)）與長度檢查（strlen<N）
//      抓出來預填。草稿標 draft:true，必須人工核對後拿掉標記才算數：
//      啟發式抓出來的是「像提示的字串」，不是「實測走得通的流程」。
//
// 用法：
//   node tools/extract-zjmud-metadata.mjs                 # 所有 telnet lib（來源①）
//   node tools/extract-zjmud-metadata.mjs --slug nt7
//   node tools/extract-zjmud-metadata.mjs --scan <path/logind.lpc> --slug <new>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportMetadata, PROFILES } from '../src/js/telnetlogin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBS = path.resolve(HERE, '..', '..', 'libs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** ② 啟發式草稿：從 logind 原始碼抓提示與限制。 */
function scanDraft(file, slug) {
  const text = fs.readFileSync(file, 'utf8');
  const rules = [];
  const seen = new Set();
  const KNOWN = [
    { re: /英文名字[^"\n]{0,20}[：:]/, send: '{id}', note: 'name' },
    { re: /再[输輸]入一次[^"\n]{0,12}密[码碼]/, send: '{pw}', note: 'pw-confirm', req: false },
    { re: /(设定|設定|重设|重設)[^"\n]{0,8}密[码碼]/, send: '{pw}', note: 'pw' },
    { re: /\(y\/n\)/, send: 'y', note: 'confirm', req: false },
    { re: /男性\(m\)|\(m\/f\)/, send: '{gender}', note: 'gender', req: false },
    { re: /中文名字/, send: '{name}', note: 'cname', req: false },
    { re: /(电子邮件|電子郵件|e-?mail)/i, send: 'a@b.c', note: 'email', req: false },
  ];
  // 只收 write()/tell_object 字串常值裡的樣式
  for (const m of text.matchAll(/"((?:[^"\\]|\\.){4,120})"/g)) {
    const lit = m[1];
    for (const k of KNOWN) {
      if (seen.has(k.note) || !k.re.test(lit)) continue;
      seen.add(k.note);
      // 取字面中命中前後最多 14 字當比對樣式（跳脫 regex 特殊字元）
      const at = lit.search(k.re);
      const frag = lit.slice(Math.max(0, at), at + 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push({ match: frag, send: k.send, note: k.note, ...(k.req === false ? { req: false } : {}) });
    }
  }
  // 長度限制：strlen(x) < N / > N
  const pwMin = [...text.matchAll(/密[码碼][^\n]{0,80}?(\d)\s*个字/g)].map((m) => +m[1])[0]
    ?? [...text.matchAll(/strlen\([^)]*pass[^)]*\)\s*<\s*(\d+)/gi)].map((m) => +m[1])[0];
  return {
    name: slug,
    draft: true,
    note: '啟發式草稿：必須人工核對＋boot-test 走通後移除 draft 標記',
    rules,
    specs: {
      id: { min: 3, max: 12, charset: '^[a-z]+$', hint: '3–12 個小寫英文字母' },
      pw: { min: pwMin || 6, hint: `至少 ${pwMin || 6} 個字元` },
      cname: { min: 2, max: 4, chinese: true, hint: '2–4 個中文字' },
      gender: { options: ['m', 'f'], hint: '男 m／女 f' },
    },
  };
}

const scan = arg('scan');
const only = arg('slug');

if (scan) {
  if (!only) { console.error('--scan 需要 --slug'); process.exit(2); }
  const meta = scanDraft(scan, only);
  const out = path.join(LIBS, only, `zjmud.metadata.${only}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(meta, null, 2) + '\n');
  console.log(`[draft] ${path.relative(process.cwd(), out)}：${meta.rules.length} 條規則（待人工核對）`);
  process.exit(0);
}

// 來源①：所有 protocol=telnet 的 lib，用內建（已實測）的 profile 匯出
let n = 0;
for (const slug of fs.readdirSync(LIBS)) {
  if (only && slug !== only) continue;
  const metaPath = path.join(LIBS, slug, 'mud.json');
  if (!fs.existsSync(metaPath)) continue;
  const mud = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (mud.protocol !== 'telnet') continue;
  const profile = mud.loginProfile || 'generic-cn';
  if (!PROFILES[profile]) { console.warn(`  ⚠ ${slug}：沒有內建 profile ${profile}，跳過`); continue; }
  const meta = exportMetadata(profile);
  meta.name = slug;                       // metadata 以 slug 為名，與 lib 一一對應
  const out = path.join(LIBS, slug, `zjmud.metadata.${slug}.json`);
  fs.writeFileSync(out, JSON.stringify(meta, null, 2) + '\n');
  console.log(`  ${slug} ← profile ${profile}（${meta.rules.length} 條規則）`);
  n += 1;
}
console.log(`共 ${n} 份 zjmud.metadata.*.json`);
