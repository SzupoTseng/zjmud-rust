#!/usr/bin/env node
// 依家族批次「匯入 → 相容性修正 → 轉換 → 開機測試」，並把結果寫成報告。
//
// 【WHY】97 台一台一台手動跑不可行，而且會失去可比性——批次跑才看得出
// 「這個家族的規則到底覆蓋多少」。SOP §B4 要求一個家族一批、範本先過，
// 這支工具就是那個「一批」的執行者。
//
// 【推理】每台都是獨立的子步驟，任何一步失敗都只影響那一台（記進報告、繼續下一台）；
// **不可以因為一台壞掉就中斷整批**——那會讓你永遠不知道其餘台的狀況。
// 判準用 SOP §B2：opcode 必須收到 002/004/003/012 四項，少一項就不算過。
//
// 用法：
//   node tools/batch-convert.mjs --family es2-inherit [--limit 5] [--skip-import]
//   node tools/batch-convert.mjs --slugs a,b,c --family es2-inherit

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const LIBS = path.join(REPO, 'libs');
const SRC = '/mnt/g/GameDevZ/mudlibs-main/mudlibs-main/libs';
const TSV = '/tmp/claude-1000/-mnt-g-GameDevZ-zjmud-rust/fe1ba9db-1b82-4c87-93de-bd8f976b2d01/scratchpad/mudlib_fingerprints.tsv';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * SOP §B2 的機器判準。
 *
 * 【為什麼是這三個而不是四個】原本把 003（出口）也列為必要，結果
 * 北美侠客行 被判失敗——但它其實完全正常：**起始房間（侠客岛挂名处）
 * 沒有出口**，所以沒有 003 可送。而同一段程式碼產生的 005（房間物件、
 * 「登记使」木老五）有出來，證明出口那條路本身是通的。
 *
 * 003/005/007/008 是**資料相依**（房間有沒有出口／物件、有沒有東西可點），
 * 002/004/006/012 才是「轉換有沒有生效」的充分證據——其中 006（底部快捷列）
 * 是後來補上的：少了它，使用者看到的就是「下方 GUI 選單沒有出來」。把資料相依的東西當成必要條件，
 * 會把好的轉換判成失敗——閘門要擋的是缺陷，不是內容差異。
 */
const REQUIRED_OPCODES = ['002', '004', '006', '012'];

const family = arg('family');
const limit = Number(arg('limit', '0'));
const only = arg('slugs');
if (!family) { console.error('需要 --family'); process.exit(2); }

const rows = fs.readFileSync(TSV, 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t'))
  .map((c) => ({ slug: c[0], group: c[1], sizeMB: +c[2], isZjmud: c[12] === 'yes' }));

let targets = only
  ? only.split(',').map((s) => rows.find((r) => r.slug === s.trim())).filter(Boolean)
  : rows.filter((r) => r.group === family && !r.isZjmud);
// 小的先跑：壞了早點知道，而且迭代快
targets.sort((a, b) => a.sizeMB - b.sizeMB);
if (limit) targets = targets.slice(0, limit);

const WEBCLIENT = path.resolve(HERE, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: WEBCLIENT, encoding: 'utf8', maxBuffer: 64 << 20 });

// boot-test 對 noboot 會以非零退出——那是**結果**不是工具故障。
// 【WHY】原本一律當成例外，於是報告上寫「boot 失敗：<一大段 JSON>」，
// 真正的結論（badge=noboot、reason=撥號失敗）反而看不見。
// 只要 stdout 是可解析的 JSON 就照常採用。
function runJson(cmd, args) {
  try {
    return JSON.parse(run(cmd, args));
  } catch (e) {
    const out = (e.stdout ?? '').toString();
    const i = out.indexOf('{');
    if (i !== -1) { try { return JSON.parse(out.slice(i)); } catch { /* 真的壞了 */ } }
    throw e;
  }
}

const report = [];
let i = 0;
for (const t of targets) {
  i += 1;
  const tag = `[${String(i).padStart(2)}/${targets.length}] ${t.slug.padEnd(28)}`;
  const dir = path.join(LIBS, t.slug);
  const row = { slug: t.slug, sizeMB: t.sizeMB, step: null, badge: null, opcodes: [], ok: false, note: '' };
  try {
    // ① 匯入（已存在就跳過，讓中斷後可續跑）
    if (!fs.existsSync(path.join(dir, 'mudlib.json')) || !process.argv.includes('--skip-import')) {
      row.step = 'import';
      run('node', [path.join(WEBCLIENT,'tools')+'/import-telnet.mjs', '--from', path.join(SRC, t.slug, 'work'),
        '--slug', t.slug, '--title', t.slug, '--profile', 'generic-cn',
        '--subtitle', `mudlibs-main · ${family} 家族`]);
    }
    // ② 相容性修正（is_chinese／名字長度／log 目錄…；telnet lib 一樣中招）
    row.step = 'fix';
    run('node', [path.join(WEBCLIENT,'tools')+'/fix-image.mjs', t.slug]);
    // ③ 轉換（注入 zjmud.h ＋ 面板 daemon ＋ look 的一行 hook）
    row.step = 'convert';
    run('node', [path.join(WEBCLIENT,'tools')+'/convert-to-zjmud.mjs', t.slug, '--family', family]);
    // ④ 開機測試（真的登入、真的進世界、真的收 opcode）
    row.step = 'boot';
    const res = runJson('node', [path.join(WEBCLIENT, 'tools') + '/boot-test.mjs',
      path.join('..', 'libs', t.slug), '--image', '--json']);
    row.badge = res.badge;
    row.opcodes = res.opcodes ?? [];
    // ★ 判準加上「走得動」。
    // 【WHY】舊判準只看 opcode，於是**卡在新手關卡**的台照樣過關：
    // 泥潭停在註冊室、北美停在腳本開場，兩台的面板都完整，
    // 但玩家一步都走不了。使用者點進去看到漂亮的介面然後動彈不得，
    // 比紅燈難受得多。boot-test 現在會實際送方向、比對房間指紋。
    row.moved = res.moved === true;
    row.ok = res.badge === 'playable' && row.moved
      && REQUIRED_OPCODES.every((o) => row.opcodes.includes(o));
    row.note = row.ok ? '' : (res.reason ?? '');
    // 驗證狀態寫回 mud.json，供 build-site 與人工複核參考
    const metaPath = path.join(dir, 'mud.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.convert) meta.convert.verified = { ...meta.convert.verified, bootTest: row.ok };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    }
  } catch (e) {
    row.note = `${row.step} 失敗：${(e.stderr || e.stdout || e.message || '').toString().slice(-200).trim()}`;
  }
  report.push(row);
  console.log(`${tag} ${row.ok ? '✓' : '✗'} ${row.badge ?? ''} ${row.opcodes.join(' ')} ${row.note}`);
}

const ok = report.filter((r) => r.ok);
fs.writeFileSync(path.join(HERE, '..', 'wasm', `batch-${family}.json`), JSON.stringify(report, null, 2));
console.log(`\n${family}：${ok.length}/${report.length} 通過（opcode 四項全中）`);
if (ok.length < report.length) {
  console.log('未過的：');
  for (const r of report.filter((x) => !x.ok)) console.log(`  ${r.slug}：${r.note || r.opcodes.join(' ') || '無 opcode'}`);
}
process.exit(0);
