#!/usr/bin/env node
// 把建置時實測到的開機結果寫回 libs/<slug>/NOTES.md。
//
// 【WHY】NOTES.md 是給人看的那一份「這個 lib 現在到底能不能玩、為什麼」。
// 匯入時寫的那半份只有「改了什麼」，缺了最重要的一半：**改完之後跑起來如何**。
// 兩份分開放會過期；合在一起、而且由建置產生，才不會出現「文件說可玩、實際打不開」。
//
// 【推理】boot-test 的結果已經以 JSON 落在 site/libs/<slug>/boot-test.json，
// 所以這裡只做格式化與覆寫，不重跑測試——同一個事實只量一次。
//
// 用法：node tools/write-notes.mjs [site 目錄]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const site = path.resolve(process.argv[2] || path.join(REPO, 'site'));
const LIBS = path.join(REPO, 'libs');

const MARK = '<!-- boot-test:begin -->';
const END = '<!-- boot-test:end -->';

const BADGE_TEXT = {
  playable: '**playable** — 註冊 → 建角 → 進世界整條走得完',
  limited: '**limited** — 開得起來，但登入流程沒走完',
  noboot: '**noboot** — 目前開不起來（映像不會發佈到站台）',
};

function render(res, driver) {
  const L = [MARK];
  L.push('## WASM 開機測試（由建置產生，勿手改）', '');
  L.push(`driver \`${driver}\`　最後測試：${res.testedAt}`, '');
  L.push(`分級：${BADGE_TEXT[res.badge] ?? res.badge}`, '');
  L.push(`> ${res.reason}`, '');
  L.push('| 項目 | 值 |', '|------|-----|');
  L.push(`| 映像 | ${res.files} 檔 / ${res.megabytes} MB |`);
  L.push(`| 收到 | ${res.lines} 行，耗時 ${res.elapsedMs ?? '-'} ms |`);
  L.push(`| 握手 | \`${res.handshake ?? '（無）'}\` |`);
  L.push(`| 方言 | ${res.dialect ?? '（未判定）'} |`);
  L.push(`| opcode | ${res.opcodes?.length ? res.opcodes.join(' ') : '（無）'} |`);
  L.push('');
  if (res.loadFailures?.length) {
    L.push('### 載入失敗的物件', '',
      'WASM build 關掉了 sockets/db/external/ffi/crypto/async/compress，'
      + '用到那些 efun 的檔案會在載入時編譯失敗。driver 仍會繼續開機，'
      + '只是那些物件不存在（多半是對外連線用的 daemon，在沒有網路的分頁裡本來就沒有意義）。', '');
    for (const f of res.loadFailures) L.push(`- \`${f}\``);
    L.push('');
  }
  if (res.undefinedFuncs?.length) {
    L.push(`缺少的 efun：${res.undefinedFuncs.map((f) => '`' + f + '`').join('、')}`, '');
  }
  L.push(END);
  return L.join('\n');
}

const index = JSON.parse(fs.readFileSync(path.join(site, 'libs', 'index.json'), 'utf8'));
let n = 0;
for (const mud of index.muds) {
  const jsonPath = path.join(site, 'libs', mud.slug, 'boot-test.json');
  if (!fs.existsSync(jsonPath)) continue;
  const res = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  res.testedAt = index.generated.slice(0, 10);

  const notesPath = path.join(LIBS, mud.slug, 'NOTES.md');
  let text = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : `# ${mud.title}\n\n`;
  const block = render(res, index.driver);
  if (text.includes(MARK)) {
    text = text.replace(new RegExp(`${MARK}[\\s\\S]*?${END}`), block);
  } else {
    text = text.replace(/\s*$/, '\n\n') + block + '\n';
  }
  fs.writeFileSync(notesPath, text);
  n += 1;
}
console.log(`已更新 ${n} 份 NOTES.md`);
