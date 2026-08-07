#!/usr/bin/env node
// 批次匯入整個 zjmud 收藏。
//
// 【WHY】17 個 mudlib 一個一個手動處理不可行，而且人工處理的結果無法重跑。
// 這支把「來源目錄 → slug」的對應表釘在版控裡，任何人重跑都會得到同一份結果。
//
// 【推理】跨 WSL 的 9P 檔案系統對「大量小檔」極慢——**實測寫入只有 28 檔/分**，
// 而讀取有 ~2400 檔/分，相差 80 倍。所以整理過的 mudlib **不以檔案樹的形式進版控**，
// 而是 import 到本機暫存區（快），再打包成單一映像寫進 libs/<slug>/mudlib.data。
// 一個 lib 從「寫一萬個小檔」變成「寫兩個檔」，時間從 ~5 小時降到幾秒。
// 代價是 GitHub 上看不到 LPC 原始碼——這是刻意的取捨，理由與重建方式寫在 libs/README.md。
//
// 用法：
//   node tools/import-all.mjs --list                  列出對應表
//   node tools/import-all.mjs --slug nt7              只做一個
//   node tools/import-all.mjs --from 0 --count 4      做第 0..3 個（外層平行用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { importLib, renderNotes } from './import-lib.mjs';
import { buildImage } from './pack-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const LIBS = path.join(REPO, 'libs');

/** 收藏根目錄。可用 ZJMUD_COLLECTION 覆寫。 */
export const COLLECTION = process.env.ZJMUD_COLLECTION
  || '/mnt/g/GameDevZ/700600_ZJMUD_ALL/zjmud-collection-master';

/**
 * 來源目錄 → slug／標題。
 * 名稱取自收藏的資料夾名；slug 用拼音，因為它會出現在網址裡。
 */
export const CATALOGUE = [
  { dir: '谁与争锋(原版zj)', slug: 'shuiyuzhengfeng', title: '谁与争锋（原版）' },
  { dir: '执剑行(7.0)', slug: 'zhijianxing', title: '执剑行 7.0' },
  { dir: '仙武奇缘(zj)', slug: 'xianwuqiyuan', title: '仙武奇缘' },
  { dir: '文字江湖(zj)', slug: 'wenzijianghu', title: '文字江湖' },
  { dir: '江湖风雨情', slug: 'jianghufengyuqing', title: '江湖风雨情' },
  { dir: '天涯二(zj)', slug: 'tianya2', title: '天涯二' },
  { dir: '剑影江湖', slug: 'jianyingjianghu', title: '剑影江湖' },
  { dir: '91书剑(zj)', slug: '91shujian', title: '91 书剑' },
  { dir: '剑诀浮云气', slug: 'jianjuefuyunqi', title: '剑诀浮云气' },
  { dir: '终极地狱(zj)', slug: 'zhongjidiyu', title: '终极地狱' },
  { dir: '大梦江湖(新协议版)', slug: 'damengjianghu', title: '大梦江湖（新协议版）' },
  { dir: '四合一修复版', slug: 'siheyi', title: '四合一修复版' },
  { dir: '夺宝江湖(zj)', slug: 'duobaojianghu', title: '夺宝江湖' },
  { dir: 'nt7-main', slug: 'nt7', title: 'nt7' },
  { dir: '笑傲江湖(海洋二)', slug: 'xiaoaojianghu', title: '笑傲江湖（海洋二）' },
  { dir: '泥潭七(去后门zj)', slug: 'nitan7', title: '泥潭七（去后门）' },
];

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

if (process.argv.includes('--list')) {
  for (const [i, e] of CATALOGUE.entries()) console.log(`${i}\t${e.slug}\t${e.dir}`);
  process.exit(0);
}

const only = arg('slug', null);
const from = Number(arg('from', 0));
const count = Number(arg('count', CATALOGUE.length));
const force = process.argv.includes('--force');

const todo = (only ? CATALOGUE.filter((e) => e.slug === only) : CATALOGUE.slice(from, from + count));

for (const entry of todo) {
  const src = path.join(COLLECTION, entry.dir);
  const dstImage = path.join(LIBS, entry.slug, 'mudlib.data');
  const t0 = Date.now();

  if (!fs.existsSync(src)) { console.log(`[skip] ${entry.slug}：來源不存在 ${src}`); continue; }
  if (!force && fs.existsSync(dstImage)) {
    console.log(`[skip] ${entry.slug}：已經匯入過（--force 可重做）`);
    continue;
  }

  console.log(`[start] ${entry.slug} ← ${entry.dir}`);
  try {
    // 整理階段全部在本機暫存區進行（9P 寫入太慢，見檔頭）
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), `zjmud-${entry.slug}-`));
    const report = importLib(src, { slug: entry.slug, title: entry.title, stageDir: stage });
    // mud.json 的 subtitle 用收藏的原始資料夾名，保留出處線索
    // 打包成單一映像後才寫進版控目錄
    const { manifest, data } = buildImage(report.stageWork, {
      mount: '/mudlib', config: report.config || 'config.ini',
    });
    const libDir = path.join(LIBS, entry.slug);
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'mudlib.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(libDir, 'mudlib.data'), data);

    const metaPath = path.join(libDir, 'mud.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.subtitle = entry.dir;
    meta.image = 'mudlib.data';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    fs.writeFileSync(path.join(libDir, 'NOTES.md'), renderNotes(report));
    fs.rmSync(stage, { recursive: true, force: true });
    console.log(`[done ] ${entry.slug}：${manifest.files.length} 檔 / ${(data.length / 1e6).toFixed(1)} MB，`
      + `轉碼 ${report.converted.length}，丟棄存檔 ${report.droppedSaves.length}，`
      + `遮蔽 ${report.redacted.length}，耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    console.log(`[FAIL ] ${entry.slug}：${e.message}`);
  }
}
console.log('[batch-complete]');
