// WASM 交付路徑的測試。
//
// 分兩層：
//   ① 純函式層（永遠會跑）：映像格式的來回、telnet 位元組層的等價性。
//   ② 整合層（只有 driver 存在時才跑）：真的把 mudlib 開起來、登入、看 opcode。
// ② 需要 webclient/wasm/driver（gitignored，`node tools/fetch-driver.mjs` 取得），
// 所以在乾淨 checkout 上會自動跳過，不會讓 npm test 失敗。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { filterBytes, createLineReader } from '../src/js/telnet.js';
import { filter as bridgeFilter } from '../bridge/telnet.mjs';
import { IMAGE_FORMAT, unpackImage } from '../src/js/mudlibimage.js';
import { buildImage } from '../tools/pack-lib.mjs';
import { driverAvailable, loadGlue, DRIVER_DIR as DRIVER_DIR_FOR_TEST } from '../tools/wasm-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** driver 實測的第一包：6 組 IAC 協商 + 握手行。 */
const REAL_FIRST_PACKET = Uint8Array.from([
  0xff, 0xfd, 0x18, 0xff, 0xfd, 0x1f, 0xff, 0xfd, 0x27,
  0xff, 0xfb, 0x46, 0xff, 0xfb, 0x2a, 0xff, 0xfb, 0x5a,
  0x0d, 0x0a,
  ...Buffer.from('ver1.0:byz0rmpISExtQ', 'utf8'),
  0x0d, 0x0a,
]);

// 【WHY】GitHub Pages 的第一次部署失敗就死在這裡：driver 下載成功、檔案都在，
// 但 glue 是 CommonJS，而 webclient/package.json 的 `type: module` 會傳染到子
// 目錄，於是 require 回傳空命名空間，第一個 mud 一開機就
// `createFluffOS is not a function`，整個站台沒有發佈。
//
// 【推理】那個 bug 之所以能溜到 CI，是因為所有會碰 driver 的測試都要求
// 「driver ＋ 已建置的站台」兩個條件，在 npm test 階段都不成立而被跳過。
// 這一條把條件降到只剩「driver 目錄存在」——載得起來是 driver 唯一的義務，
// 不需要任何 mudlib 就能驗，因此它是這類故障最早、最便宜的攔截點。
test('★ driver 目錄一旦存在，glue 就必須真的載得起來（type=module 傳染防線）',
  { skip: !fs.existsSync(path.join(DRIVER_DIR_FOR_TEST, 'fluffos.js')) }, () => {
    const marker = path.join(DRIVER_DIR_FOR_TEST, 'package.json');
    assert.ok(fs.existsSync(marker), `缺少 ${marker}——重跑 node tools/fetch-driver.mjs`);
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).type, 'commonjs');
    assert.equal(typeof loadGlue(DRIVER_DIR_FOR_TEST), 'function');
    assert.ok(driverAvailable(), 'driverAvailable() 應該把可載入性算進去');
  });

// 【WHY】這個 bug 修了兩次還在。第一版把 Date.now()（epoch 毫秒）餵給
// fluffos_tick，等於第一拍就宣告過了 1.7 兆毫秒，所有 call_out 與 heartbeat
// 在開機瞬間全部到期——91书剑 的 30 秒登入逾時實測 15 毫秒就觸發。
// 第二版改成 performance.now() 仍然錯，只是錯得小：那是**分頁載入**起算的，
// 而使用者是先看清單、再等幾十 MB 下載完才開機的。
//
// 【推理】node 端的測試看不到這件事——那邊開機就在 process 起頭，
// performance.now() 還很小。所以要把「分頁已經開很久」這件事**做進測試裡**：
// 把時鐘來源整個墊高，再檢查 driver 收到的第一拍是不是仍然接近 0。
test('★ driver 時鐘從開機起算，不受分頁已開多久影響', async () => {
  const ticks = [];
  const M = {
    FS: {},
    ccall(fn, ret, sig, args) {
      if (fn === 'fluffos_tick') ticks.push(args[0]);
      return 0;
    },
  };
  const realNow = performance.now.bind(performance);
  performance.now = () => realNow() + 5_000_000;      // 假裝分頁已經開了 83 分鐘
  try {
    const { createWasmDriver } = await import('../src/js/wasmdriver.js');
    const driver = createWasmDriver(M, { onLine() {}, onClosed() {} });
    assert.equal(driver.boot('config.ini'), 0);
    // 等「至少送出一拍」這個條件，不要睡固定時間：CI 的機器忙起來時
    // 20ms 的 setInterval 不保證在 80ms 內跑到，那會變成假紅燈
    // （驗證器自己的競態，不是被驗證的東西壞了——這個坑 verify-fullstack 踩過一次）。
    const deadline = Date.now() + 5000;
    while (ticks.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    driver.shutdown();
    assert.ok(ticks.length > 0, '應該至少送出一次 tick');
    assert.ok(ticks[0] < 1000,
      `第一拍應該接近 0，實際 ${ticks[0]}——時鐘沒有以開機時刻為原點`);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.ok(ticks[i] >= ticks[i - 1], 'tick 必須單調遞增');
    }
  } finally {
    performance.now = realNow;
  }
});

test('★ WASM driver 的第一包：IAC 全剝、協商全拒、握手行完整', () => {
  const { data, reply } = filterBytes(REAL_FIRST_PACKET);
  assert.equal(Buffer.from(data).toString('utf8'), '\r\nver1.0:byz0rmpISExtQ\r\n');
  // 3 個 DO → WONT，3 個 WILL → DONT，共 6 組 × 3 bytes
  assert.equal(reply.length, 18);
  assert.deepEqual([...reply.slice(0, 3)], [255, 252, 24]);   // DO TTYPE → WONT
  assert.deepEqual([...reply.slice(9, 12)], [255, 254, 70]);  // WILL MSSP → DONT
});

test('src/js/telnet.js 與 bridge/telnet.mjs 行為完全一致（同一份實作）', () => {
  const a = filterBytes(REAL_FIRST_PACKET);
  const b = bridgeFilter(Buffer.from(REAL_FIRST_PACKET));
  assert.equal(Buffer.from(a.data).toString('hex'), b.data.toString('hex'));
  assert.equal(Buffer.from(a.reply).toString('hex'), b.reply.toString('hex'));
});

test('分行器：跨 chunk 的一行不會被切斷，\\r 會去掉', () => {
  const r = createLineReader();
  const first = r.push(Buffer.from('ver1.0:ab'));
  assert.deepEqual(first.lines, []);
  const second = r.push(Buffer.from('cd\r\n下一行\r\n'));
  assert.deepEqual(second.lines, ['ver1.0:abcd', '下一行']);
});

test('★ 映像打包 → 載入：檔案內容與目錄結構完整還原', () => {
  const tmp = fs.mkdtempSync(path.join(HERE, '.imgtest-'));
  try {
    fs.mkdirSync(path.join(tmp, 'adm', 'single'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config.ini'), 'name : 測試\n');
    fs.writeFileSync(path.join(tmp, 'adm', 'single', 'master.c'), 'int x;\n');
    fs.mkdirSync(path.join(tmp, 'backup'));
    fs.writeFileSync(path.join(tmp, 'backup', 'old.o'), 'x');   // 應被排除

    const { manifest, data } = buildImage(tmp, { mount: '/m', config: 'config.ini' });
    assert.equal(manifest.format, IMAGE_FORMAT);
    assert.ok(!manifest.files.some((f) => f.path.startsWith('backup/')), 'backup/ 不該被打包');

    // 假的 MEMFS：只要有 mkdir / writeFile 就能驗證載入端邏輯
    const written = new Map();
    const dirs = new Set();
    const FS = {
      mkdir: (d) => { if (dirs.has(d)) throw new Error('exists'); dirs.add(d); },
      writeFile: (p, bytes) => written.set(p, Buffer.from(bytes)),
    };
    unpackImage(FS, manifest, new Uint8Array(data));

    assert.ok(dirs.has('/m/adm/single'), '目錄要建到底');
    assert.equal(written.get('/m/config.ini').toString('utf8'), 'name : 測試\n');
    assert.equal(written.get('/m/adm/single/master.c').toString('utf8'), 'int x;\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 整合層：需要 driver ──────────────────────────────
const site = path.resolve(HERE, '..', '..', 'site');
const hasBuiltSite = fs.existsSync(path.join(site, 'libs', 'index.json'));

test('★ 建置好的站台：每個 mud 的映像都能真的開機並登入', { skip: !(driverAvailable() && hasBuiltSite) }, async () => {
  const { bootTest } = await import('../tools/boot-test.mjs');
  const cat = JSON.parse(fs.readFileSync(path.join(site, 'libs', 'index.json'), 'utf8'));
  assert.ok(cat.muds.length > 0, 'catalogue 不能是空的');

  // ★ `--link-libs` 建的站台裡沒有大檔（刻意留在 libs/ 由伺服器回退供應），
  // 這時要去原處開機——同一個檔案，發佈的位元組也是它。
  // 索引裡的 `linkedLibs` 就是為了讓這裡知道該去哪找（見 build-site 的說明）。
  const repoLibs = path.resolve(HERE, '..', '..', 'libs');

  // ★ 逐台決定去哪開機，判準與 `serve-site` 的回退**完全一致**：
  // 站台裡有映像就用站台的，沒有就回倉庫 libs/ 拿。
  //
  // 【WHY 不用單一 libsRoot】原本靠索引的 `linkedLibs` 一次決定全部，
  // 但 `--only` 建出來的局部站台會讓索引說「自足」而實際上只有幾台有映像
  // （見 build-site 對這件事的說明），於是這裡 ENOENT，看起來像測試壞了。
  // 產品端早就有這條回退了——閘門比產品嚴一格，紅燈就會是假的。
  const imageDir = (slug) => {
    const inSite = path.join(site, 'libs', slug);
    const ok = fs.existsSync(path.join(inSite, 'mudlib.data.gz'))
      || fs.existsSync(path.join(inSite, 'mudlib.data'));
    return ok ? inSite : path.join(repoLibs, slug);
  };

  const bootable = cat.muds.filter((m) => m.badge !== 'noboot');
  assert.ok(bootable.length > 0, '不能一台可開機的都沒有——空集合會讓下面的斷言恆真');

  // ① 全量：索引的 badge 不可以與那台自己的紀錄不一致。
  //
  // 【WHY 不在這裡重跑全部】214 台逐一啟動 driver 要數小時，而 npm test 是
  // 每幾輪就要跑一次的快速回歸。全量開機是 builder 與 build-site 的職責。
  // 【WHY 不驗 boot-test.json】上一版斷言「每台都要有建置時的開機紀錄」，
  // 而那個檔**只有帶開機測試的建置才會寫**——標準建置（含 CI）用的是
  // `--skip-boot-test`，於是這個斷言在正常產物上一定失敗。
  // 閘門要求的東西，產品在正常路徑上必須真的會產生（CLAUDE.md 核心原則）。
  // 【判準】改驗隨時都成立的那一條：索引是從各台的 `mud.json` 產生的，
  // 兩者的 badge 必須相等；不等就代表索引過期或有人改了東西沒重建。
  for (const mud of cat.muds) {
    const mj = path.join(repoLibs, mud.slug, 'mud.json');
    if (!fs.existsSync(mj)) continue;          // 原始碼打包的台（work 指向倉庫別處）
    const meta = JSON.parse(fs.readFileSync(mj, 'utf8'));
    const own = meta.badge || meta.convert?.lastCheck?.badge || 'unknown';
    assert.equal(mud.badge, own, `${mud.slug} 索引寫 ${mud.badge}，這台自己記的是 ${own}`);
  }

  // ② 抽樣：真的開機。挑法固定（等距取樣，不是隨機），這樣紅燈可以重現；
  // 涵蓋清單頭尾與中段，家族分佈自然被打散。
  const step = Math.max(1, Math.floor(bootable.length / 8));
  const sample = bootable.filter((_, i) => i % step === 0).slice(0, 8);
  for (const mud of sample) {
    const res = await bootTest({ image: imageDir(mud.slug) });
    assert.notEqual(res.badge, 'noboot', `${mud.slug} 應該開得起來`);
    assert.ok(res.handshake, `${mud.slug} 應該送出版本挑戰行`);
  }
});

// 全鏈路驗證（真 DOM ＋ 真 driver ＋ 真 HTTP）不放在這裡，改成獨立腳本
// `node tools/verify-fullstack.mjs`。
// 【WHY】它會把整台 FluffOS 跑起來，而 driver 的 tick 與 emscripten runtime
// 會讓 node --test 的事件迴圈永遠不結束——測試通過了，程序卻不退出。
// 與其在測試框架裡跟生命週期搏鬥，不如讓它是一支「跑完就 exit」的驗證腳本，
// 在 CI 裡當成獨立一步（見 .github/workflows/pages.yml）。
