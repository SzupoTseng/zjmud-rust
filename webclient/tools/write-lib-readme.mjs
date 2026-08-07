#!/usr/bin/env node
// 為每個收錄的 mud 產生 README.md（出處、授權、現況）。
//
// 【WHY】libs/ 底下每一個 mudlib 都是**別人的著作**。本 fork 只做了轉碼、
// 去識別化與相容性修正，那些改動不構成新的著作權主張。既然如此，出處與
// 「我們改了什麼」就必須逐一寫清楚——這不是文件品質問題，是授權問題。
//
// 【推理】人工寫 17 份會漏、會過期。改由建置產生：來源與設定取自 mud.json，
// 現況取自 boot-test 的實測結果，改動明細已經在 NOTES.md 裡，README 只做索引。
//
// 用法：node tools/write-lib-readme.mjs [site 目錄]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const site = path.resolve(process.argv[2] || path.join(REPO, 'site'));
const LIBS = path.join(REPO, 'libs');

const BADGE = {
  playable: '✅ 可玩（註冊 → 建角 → 進世界整條走得完）',
  limited: '🟡 部分可用（開得起來，登入流程未走完）',
  noboot: '🔴 待修（目前開不起來，映像不發佈到站台）',
};

const index = JSON.parse(fs.readFileSync(path.join(site, 'libs', 'index.json'), 'utf8'));
let n = 0;

for (const mud of index.muds) {
  const dir = path.join(LIBS, mud.slug);
  const metaPath = path.join(dir, 'mud.json');
  if (!fs.existsSync(metaPath)) continue;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const readme = path.join(dir, 'README.md');

  // 手寫過的不覆蓋（lpmudname 有一份說明「為什麼 work 是指標」）
  if (fs.existsSync(readme) && !fs.readFileSync(readme, 'utf8').includes('<!-- generated -->')) continue;

  const L = ['<!-- generated -->', `# ${meta.title || mud.slug}`, ''];
  L.push('| 項目 | 值 |', '|------|-----|');
  L.push(`| 現況 | ${BADGE[mud.badge] ?? mud.badge} |`);
  L.push(`| 收藏來源 | \`${meta.subtitle || '—'}\` |`);
  L.push(`| 設定檔 | \`${meta.config || 'config.ini'}\` |`);
  L.push(`| 方言 | ${mud.dialect || '（未判定）'} |`);
  L.push(`| 映像 | ${mud.sizeMB ? mud.sizeMB + ' MB' : '（不發佈）'} |`);
  L.push('');
  L.push('## 授權與出處', '');
  L.push('這份 mudlib **不是本 fork 的著作**。它來自公開流傳的 zjmud 收藏，');
  L.push('原作者與授權條款以 mudlib 內的檔頭註解與說明檔為準；本倉庫未變更、');
  L.push('也未主張任何著作權。若你是原作者且不希望它出現在這裡，開一個 issue，我會移除。');
  L.push('');
  L.push('本 fork 對它做過的事只有三類，全部逐項記在 [`NOTES.md`](NOTES.md)：', '');
  L.push('1. **轉碼**：GBK → UTF-8（WASM driver 沒有表格式字集）');
  L.push('2. **去識別化**：刪除含密碼欄的玩家存檔、遮蔽寫死的憑證');
  L.push('3. **相容性修正**：讓它能在現代 FluffOS 的 WASM build 上開機');
  L.push('');
  L.push('## 重建', '');
  L.push('```bash');
  L.push('# 從收藏重新匯入（來源對應表在 webclient/tools/import-all.mjs）');
  L.push(`node webclient/tools/import-all.mjs --slug ${mud.slug} --force`);
  L.push('# 解開映像來看 LPC 原始碼');
  L.push(`node webclient/tools/unpack-lib.mjs libs/${mud.slug} --out /tmp/${mud.slug}`);
  L.push('```');
  L.push('');

  fs.writeFileSync(readme, L.join('\n'));
  n += 1;
}
console.log(`已產生 ${n} 份 libs/<slug>/README.md`);
