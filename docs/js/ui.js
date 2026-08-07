// DOM 元件層。無框架：每個元件是一個工廠函式，建立 DOM 一次、之後差異更新。
//
// 與原 Android 客戶端的關鍵差異：本層只讀 store、只呼叫 sendCommand，
// 從不解析協議。協議解析全在 protocol.js。

import { parseStyled, classifyLink } from './ansi.js';

// ── DOM 小工具 ──────────────────────────────────────

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 捲到底。
 *
 * 【為什麼不直接用 scrollTo】
 * `Element.scrollTo()` 不是所有執行環境都有（jsdom 沒有，部分 WebView 也缺）。
 * 先前這裡直接呼叫 `parentElement.scrollTo(...)`，在缺少該方法的環境會拋 TypeError，
 * 而它是在 mount() 期間被呼叫的 —— 一拋就中斷整個 mount，導致後面的
 * bindConnectForm() 從未執行，畫面看起來正常但「連線」鈕完全沒有反應。
 * 指派 scrollTop 是各環境都支援的等價作法。
 */
export function scrollToBottom(node) {
  if (!node) return;
  try {
    node.scrollTop = node.scrollHeight;
  } catch { /* 非可捲動節點，忽略 */ }
}

/**
 * 把樣式片段陣列轉成 DOM。
 * 這是 ansi.js（純資料）與 DOM 之間唯一的橋。
 */
export function renderStyled(raw, ctx) {
  const frag = document.createDocumentFragment();
  const { spans, clearScreen } = parseStyled(raw, { dayMode: ctx?.dayMode });

  for (const { text, style } of spans) {
    // 保留伺服器排版用的連續空白與換行
    const hasLink = Boolean(style.link);
    const node = el(hasLink ? 'a' : 'span', { class: hasLink ? 'lnk' : null });
    node.textContent = text;

    if (style.fg) node.style.color = style.fg;
    if (style.bg) node.style.backgroundColor = style.bg;
    if (style.bold) node.style.fontWeight = '700';
    if (style.size) node.style.fontSize = `${style.size}em`;

    if (hasLink) {
      const link = classifyLink(style.link);
      node.dataset.linkKind = link.kind;
      node.dataset.linkValue = link.value;
      node.href = '#';
      node.addEventListener('click', (e) => {
        e.preventDefault();
        ctx?.onLink?.(link);
      });
    }
    frag.append(node);
  }
  return { frag, clearScreen };
}

// ── 訊息串 ─────────────────────────────────────────

/**
 * 只 append 不重建的訊息串。主訊息區是唯一高頻更新處，
 * 整串重繪在 500 則時會明顯卡頓。
 */
export function MessageList(root, { channel, store, ctx, limit }) {
  let rendered = 0;

  function render(list) {
    // store 已裁切過陣列；若前端已渲染數 > 陣列長度，代表發生了裁切或清空
    if (rendered > list.length) {
      clear(root);
      rendered = 0;
    }
    // 裁切時前端多出來的舊節點要一起移除
    while (root.childElementCount > list.length) {
      root.removeChild(root.firstElementChild);
    }
    for (let i = rendered; i < list.length; i++) {
      const line = el('div', { class: 'msg' });
      const { frag, clearScreen } = renderStyled(list[i], ctx);
      if (clearScreen) {
        clear(root);
        rendered = 0;
      }
      line.append(frag);
      root.append(line);
    }
    rendered = list.length;
    if (limit && root.childElementCount > limit) {
      while (root.childElementCount > limit) root.removeChild(root.firstElementChild);
      rendered = root.childElementCount;
    }
    scrollToBottom(root.parentElement);
  }

  const off = store.sub('msgs.' + channel, render);
  render(store.get('msgs.' + channel));
  return { destroy: off };
}

// ── 房間標題 ────────────────────────────────────────

export function RoomHeader(root, { store, ctx }) {
  const titleEl = el('button', { class: 'room-title', type: 'button' });
  const btnRow = el('div', { class: 'title-buttons' });
  const toggle = el('button', { class: 'icon-btn', type: 'button', title: '摺疊描述', text: '▾' });

  titleEl.addEventListener('click', () => {
    const cmd = store.get('room.titleCmd');
    if (cmd) ctx.send(cmd);
  });
  toggle.addEventListener('click', () => {
    const hidden = !store.get('room.descHidden');
    store.set('room.descHidden', hidden);
    ctx.savePref({ descHidden: hidden });
  });

  root.append(titleEl, btnRow, toggle);

  function renderTitle() {
    clear(titleEl);
    titleEl.append(renderStyled(store.get('room.title'), ctx).frag);
    titleEl.classList.toggle('clickable', Boolean(store.get('room.titleCmd')));
  }
  function renderButtons(buttons) {
    clear(btnRow);
    for (const b of buttons ?? []) {
      const btn = el('button', { class: 'chip', type: 'button' });
      btn.append(renderStyled(b.label, ctx).frag);
      btn.addEventListener('click', () => ctx.send(b.cmd));
      btnRow.append(btn);
    }
  }
  function renderToggle() {
    const hidden = store.get('room.descHidden') || store.get('room.descForcedHidden');
    toggle.textContent = hidden ? '▸' : '▾';
    toggle.title = hidden ? '顯示描述' : '隱藏描述';
  }

  store.sub('room.title', renderTitle);
  store.sub('room.titleCmd', renderTitle);
  store.sub('room.titleButtons', renderButtons);
  store.sub('room.descHidden', renderToggle);
  store.sub('room.descForcedHidden', renderToggle);
  renderTitle();
  renderButtons(store.get('room.titleButtons'));
  renderToggle();
}

// ── 房間描述 ────────────────────────────────────────

export function RoomDesc(root, { store, ctx }) {
  function render() {
    const hidden = store.get('room.descHidden') || store.get('room.descForcedHidden');
    root.hidden = hidden;
    if (hidden) return;
    clear(root);
    root.append(renderStyled(store.get('room.desc'), ctx).frag);
  }
  store.sub('room.desc', render);
  store.sub('room.descHidden', render);
  store.sub('room.descForcedHidden', render);
  render();
}

// ── 物件清單（含雙層血條）────────────────────────────

export function EntityList(root, { store, ctx }) {
  function render(objects) {
    clear(root);
    for (const obj of objects ?? []) {
      const item = el('button', { class: 'entity', type: 'button' });
      const name = el('span', { class: 'entity-name' });
      name.append(renderStyled(obj.label, ctx).frag);
      item.append(name);

      if (obj.bar && obj.bar.max > 0) {
        const pctA = Math.max(0, Math.min(100, (obj.bar.a / obj.bar.max) * 100));
        const pctB = Math.max(0, Math.min(100, (obj.bar.b / obj.bar.max) * 100));
        item.append(
          el('span', { class: 'entity-bar' }, [
            el('i', { class: 'bar-b', style: { width: pctB + '%' } }),
            el('i', { class: 'bar-a', style: { width: pctA + '%' } }),
          ]),
        );
      }
      item.addEventListener('click', () => ctx.selectTarget(obj));
      root.append(item);
    }
    root.hidden = !(objects && objects.length);
  }
  store.sub('room.objects', render);
  render(store.get('room.objects'));
}

// ── 方向盤 ─────────────────────────────────────────

const SLOT_ORDER = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se'];
const SLOT_GLYPH = { nw: '↖', n: '↑', ne: '↗', w: '←', e: '→', sw: '↙', s: '↓', se: '↘' };

export function ExitPad(root, { store, ctx }) {
  const pad = el('div', { class: 'exit-pad' });
  const extra = el('div', { class: 'exit-extra' });
  const cells = {};

  for (const slot of SLOT_ORDER) {
    if (slot === 'center') {
      cells.center = el('button', { class: 'exit-cell exit-center', type: 'button', text: '⌂', title: '地圖' });
      cells.center.addEventListener('click', () => ctx.requestMap());
      pad.append(cells.center);
    } else {
      const c = el('button', { class: 'exit-cell', type: 'button' });
      c.hidden = true;
      cells[slot] = c;
      pad.append(c);
    }
  }
  root.append(pad, extra);

  function render(exits) {
    for (const slot of SLOT_ORDER) {
      if (slot === 'center') continue;
      cells[slot].hidden = true;
      cells[slot].onclick = null;
    }
    clear(extra);

    // 非標準方向名（例如「1、2、3、4」這種數字出口）先填進方向盤的**空格**，
    // 填滿了才排到下面那一列。
    // 【WHY】星戰英雄的出口全是數字，八個方向格一個都沒用到，四個出口卻被
    // 擠到「其他出口」列——而手機版的面板高度有限，那一列直接看不到，
    // 玩家等於無路可走。空著的格子就該拿來用。
    const list = exits ?? [];
    const freeSlots = SLOT_ORDER
      .filter((s) => s !== 'center' && !list.some((e) => e.slot === s));
    let freeAt = 0;

    for (const raw of list) {
      const ex = (!raw.slot && freeAt < freeSlots.length)
        ? { ...raw, slot: freeSlots[freeAt++], borrowed: true }
        : raw;
      if (ex.slot && cells[ex.slot]) {
        const c = cells[ex.slot];
        c.hidden = false;
        clear(c);
        // 借來的格子不畫方向箭頭——那個箭頭會騙人（出口叫「3」不是「往東北」）
        if (!ex.borrowed) c.append(el('span', { class: 'exit-glyph', text: SLOT_GLYPH[ex.slot] }));
        const lbl = el('span', { class: 'exit-label' });
        lbl.append(renderStyled(ex.label, ctx).frag);
        c.append(lbl);
        c.title = ex.label;
        c.onclick = () => ctx.send(ex.cmd);
      } else {
        const b = el('button', { class: 'chip', type: 'button' });
        b.append(renderStyled(ex.label, ctx).frag);
        b.addEventListener('click', () => ctx.send(ex.cmd));
        extra.append(b);
      }
    }
  }
  store.sub('room.exits', render);
  render(store.get('room.exits'));
}

// ── 屬性條 ─────────────────────────────────────────

export function StatBars(root, { store, ctx }) {
  function render() {
    const { bars, layout } = store.get('stats');
    clear(root);
    root.style.setProperty('--stat-cols', String(layout?.cols ?? 2));
    for (const b of bars ?? []) {
      if (b.mode === 'text') {
        const cell = el('div', { class: 'stat stat-text' }, [`${b.label}：${b.text}`]);
        if (b.cmd) { cell.classList.add('clickable'); cell.onclick = () => ctx.send(b.cmd); }
        root.append(cell);
        continue;
      }
      const pctA = b.max > 0 ? Math.max(0, Math.min(100, (b.a / b.max) * 100)) : 0;
      const pctB = b.max > 0 ? Math.max(0, Math.min(100, (b.b / b.max) * 100)) : 0;
      const cell = el('div', { class: 'stat' }, [
        el('div', { class: 'stat-track' }, [
          el('i', { class: 'bar-b', style: { width: pctB + '%' } }),
          el('i', { class: 'bar-a', style: { width: pctA + '%', background: b.color || 'var(--accent)' } }),
        ]),
        el('span', { class: 'stat-label', text: `${b.label} ${b.a}/${b.max}` }),
      ]);
      if (b.cmd) { cell.classList.add('clickable'); cell.onclick = () => ctx.send(b.cmd); }
      root.append(cell);
    }
  }
  store.sub('stats', render);
  render();
}

// ── 快捷指令列 ──────────────────────────────────────

/** 自訂按鈕的槽位定義。b1–b10 在主面板，b11–b17 在底部工具列。 */
export const QUICK_MAIN = ['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10'];
export const QUICK_BOTTOM = ['b11','b12','b13','b14','b15','b16','b17'];

export function QuickBar(root, { store, ctx, slots }) {
  function render() {
    const map = store.get('quick.slots') ?? {};
    clear(root);
    for (const slot of slots) {
      const cfg = map[slot];
      const btn = el('button', {
        class: 'quick' + (cfg ? '' : ' quick-empty'),
        type: 'button',
        title: cfg ? cfg.cmd : '長按（或右鍵）設定',
      });
      if (cfg) btn.append(renderStyled(cfg.label, ctx).frag);
      else btn.textContent = '＋';

      btn.addEventListener('click', () => { if (cfg?.cmd) ctx.send(cfg.cmd); });
      // 桌面用右鍵、觸控用長按，都導向同一個設定流程
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); ctx.editQuickSlot(slot); });
      bindLongPress(btn, () => ctx.editQuickSlot(slot));
      root.append(btn);
    }
  }
  store.sub('quick.slots', render);
  render();
}

function bindLongPress(node, cb, ms = 550) {
  let timer = null;
  const start = () => { timer = setTimeout(cb, ms); };
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener('pointerdown', start);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('pointercancel', cancel);
}

// ── 疊層：互動面板 ───────────────────────────────────

export function InteractSheet(root, { store, ctx }) {
  // 手機版的暗幕：抽屜蓋在整個畫面上時，底下的狀態列／按鈕列還在，
  // 沒有暗幕的話 ①視覺上分不清哪層是活的，②誤觸會打到底下的快捷鈕。
  // 點暗幕＝關閉（行動裝置的慣例）。桌面版 CSS 直接 display:none。
  const backdrop = el('div', { class: 'sheet-backdrop' });
  backdrop.hidden = true;
  root.before(backdrop);
  backdrop.addEventListener('click', () => ctx.closeOverlay());

  const detail = el('div', { class: 'sheet-detail' });
  const numRow = el('div', { class: 'sheet-num' });
  // ESC001 的輸入是自由文字，不是數字：伺服器用它接角色名、四項屬性數列、聊天內容等
  // （world/adm/npc/ganjiang.c「請輸入想設定的【中文名字 英文名字】」、d/newtt/new2.c 洗點）。
  const numInput = el('input', { class: 'num-input num-input-wide', type: 'text' });
  const numOk = el('button', { class: 'btn', type: 'button', text: '確定' });
  const colA = el('div', { class: 'action-col' });
  const colB = el('div', { class: 'action-col' });
  const closeBtn = el('button', { class: 'icon-btn sheet-close', type: 'button', text: '✕', title: '關閉' });

  numRow.append(numInput, numOk);
  root.append(closeBtn, detail, numRow, el('div', { class: 'action-cols' }, [colA, colB]));

  closeBtn.addEventListener('click', () => ctx.closeOverlay());

  function submitPrompt() {
    ctx.submitPrompt(numInput.value);
    numInput.value = '';
  }
  numOk.addEventListener('click', submitPrompt);
  numInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
  });

  function renderActions(col, data) {
    clear(col);
    if (!data) return;
    col.style.setProperty('--action-cols', String(data.layout?.cols ?? 1));
    for (const item of data.items ?? []) {
      const b = el('button', { class: 'action', type: 'button' });
      const t = el('span', { class: 'action-title' });
      t.append(renderStyled(item.title, ctx).frag);
      b.append(t);
      if (item.sub) b.append(el('span', { class: 'action-sub', text: item.sub }));
      b.addEventListener('click', () => ctx.runAction(item));
      col.append(b);
    }
  }

  function render() {
    const o = store.get('overlay');
    root.hidden = o.kind !== 'interact';
    backdrop.hidden = root.hidden;
    if (root.hidden) return;
    clear(detail);
    detail.append(renderStyled(o.detail, ctx).frag);
    numRow.hidden = !o.needNumber;
    if (o.needNumber) numInput.focus();
    renderActions(colA, o.actions1);
    renderActions(colB, o.actions2);
    colB.hidden = !o.actions2;
  }
  store.sub('overlay', render);
  render();
}

// ── 疊層：彈出選單 ───────────────────────────────────

export function PopMenu(root, { store, ctx }) {
  function render() {
    const o = store.get('overlay');
    root.hidden = o.kind !== 'popmenu';
    if (root.hidden) return;
    clear(root);
    const grid = el('div', { class: 'pop-grid' });
    grid.style.setProperty('--pop-cols', String(o.popMenu?.layout?.cols ?? 1));
    for (const item of o.popMenu?.items ?? []) {
      const b = el('button', { class: 'pop-item', type: 'button' });
      b.append(renderStyled(item.label, ctx).frag);
      b.addEventListener('click', () => { ctx.send(item.cmd); ctx.closeOverlay(); });
      grid.append(b);
    }
    root.append(grid);
  }
  store.sub('overlay', render);
  render();
}

// ── 疊層：NPC 對話框 ─────────────────────────────────

export function DialogModal(root, { store, ctx }) {
  function render() {
    const o = store.get('overlay');
    root.hidden = o.kind !== 'dialog';
    if (root.hidden) return;

    const d = o.dialog;
    clear(root);
    const box = el('div', { class: 'dialog-box' });
    const body = el('div', { class: 'dialog-body' });

    const itemRow = el('div', { class: 'dialog-items' });
    for (const b of d.blocks ?? []) {
      if (b.kind === 'item') {
        const it = el('button', { class: `dialog-item tier-${b.tier}`, type: 'button', title: b.tag });
        it.textContent = b.image || '?';
        it.addEventListener('click', () => ctx.send('litem ' + b.tag));
        itemRow.append(it);
      } else if (b.kind === 'exp') {
        body.append(el('div', { class: 'dialog-exp', text: b.text }));
      } else if (b.kind === 'money') {
        body.append(el('div', { class: 'dialog-money', text: b.text }));
      } else {
        const line = el('div', { class: 'dialog-line' });
        if (b.color) line.style.color = b.color;
        line.append(renderStyled(b.text, ctx).frag);
        body.append(line);
      }
    }
    box.append(body);
    if (itemRow.childElementCount) box.append(itemRow);

    let numInput = null;
    if (d.needNumber) {
      numInput = el('input', { class: 'num-input', type: 'number', min: '1', value: '1' });
      box.append(el('div', { class: 'dialog-num' }, [numInput]));
    }

    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '確 定' });
    ok.addEventListener('click', () => ctx.confirmDialog(numInput ? numInput.value : null));
    const row = el('div', { class: 'dialog-actions' }, [ok]);

    if (d.cancelCmd != null) {
      const cancel = el('button', { class: 'btn', type: 'button', text: '取 消' });
      cancel.addEventListener('click', () => ctx.cancelDialog());
      row.append(cancel);
    }
    box.append(row);
    root.append(box);
    numInput?.focus();
  }
  store.sub('overlay', render);
  render();
}

// ── 疊層：地圖 / 長文本 / 網頁 ────────────────────────

export function SimpleOverlay(root, { store, ctx, kind, mono }) {
  function render() {
    const o = store.get('overlay');
    root.hidden = o.kind !== kind;
    if (root.hidden) return;
    clear(root);
    const close = el('button', { class: 'icon-btn sheet-close', type: 'button', text: '✕' });
    close.addEventListener('click', () => ctx.closeOverlay());
    const body = el('pre', { class: mono ? 'overlay-mono' : 'overlay-text' });
    const text = kind === 'map' ? o.map : o.paged;
    body.append(renderStyled(String(text).split('$br#').join('\n'), ctx).frag);
    root.append(close, body);
  }
  store.sub('overlay', render);
  render();
}

// ── 頂部橫幅與飄字 ──────────────────────────────────

/** 同時最多顯示幾則 toast。超過就把最舊的擠掉。 */
const TOAST_MAX = 3;

/**
 * 短暫提示。**同一則訊息會合併，不會疊成一整排。**
 *
 * 【WHY】使用者截圖：「登录成功，正在加载世界…」同時疊了五個，畫面被蓋掉一半。
 *
 * 【推理】直接原因是傳輸層的重連迴圈每秒登入一次（見 net.js connect()），
 * 但 Toast 本身也有責任：它對同一則文字無條件新增節點、沒有數量上限，
 * 於是把「每秒一次」放大成「滿版」。根因與放大器要分開修 ——
 * 根因修好後，任何未來的高頻事件仍不該有能力洗版。
 *
 * 【證據】使用者截圖（2026-07-29）五則相同 toast 並存；
 * 伺服器 world/log/debug.log 同期每秒一次 get_user 驗證。
 */
export function Toast(root, { ctx }) {
  /** 文字 → { node, count, timer, countEl }，用來合併重複訊息。 */
  const live = new Map();

  function drop(key) {
    const rec = live.get(key);
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.node.remove();
    live.delete(key);
  }

  return {
    show(text) {
      const key = String(text ?? '');
      const existing = live.get(key);

      if (existing) {
        // 相同訊息再來一次 → 只更新次數並重新計時，不新增節點
        existing.count += 1;
        existing.countEl.textContent = ` ×${existing.count}`;
        existing.countEl.hidden = false;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => drop(key), 5000);
        return;
      }

      const node = el('div', { class: 'toast' });
      node.append(renderStyled(key, ctx).frag);
      const countEl = el('span', { class: 'toast-count', hidden: true });
      node.append(countEl);
      root.append(node);

      const rec = { node, countEl, count: 1, timer: setTimeout(() => drop(key), 5000) };
      live.set(key, rec);

      // 超過上限就擠掉最舊的（Map 保序）
      while (live.size > TOAST_MAX) drop(live.keys().next().value);
    },
  };
}

export function FloatText(root, { ctx }) {
  return {
    show(text) {
      const node = el('div', { class: 'float-text' });
      // $br# 是 zjmud 的段內換行標記——飄浮字的 payload 也會帶（實錄：更新公告
      // 整段原字印出 $br#），在這裡換成真換行
      node.append(renderStyled(String(text ?? '').split('$br#').join('\n'), ctx).frag);
      root.append(node);
      node.addEventListener('animationend', () => node.remove());
      setTimeout(() => node.remove(), 2500); // 保險：動畫事件沒觸發時也會清掉
    },
  };
}

// ── 連線狀態指示 ────────────────────────────────────

const CONN_LABEL = {
  IDLE: '未連線', CONNECTING: '連線中…', OPEN: '已連線',
  RECONNECTING: '重連中…', FAILED: '連線失敗',
};

export function ConnBadge(root, { store, ctx }) {
  const dot = el('i', { class: 'dot' });
  const label = el('span', { class: 'conn-label' });
  const retry = el('button', { class: 'btn btn-sm', type: 'button', text: '重新連線' });
  retry.addEventListener('click', () => ctx.retryNow());
  root.append(dot, label, retry);

  function render(conn) {
    root.dataset.state = conn.state;
    label.textContent = CONN_LABEL[conn.state] ?? conn.state;
    if (conn.state === 'RECONNECTING' && conn.nextRetryMs) {
      label.textContent += `（${Math.round(conn.nextRetryMs / 1000)} 秒後第 ${conn.retries} 次）`;
    }
    retry.hidden = conn.state === 'OPEN' || conn.state === 'CONNECTING';
  }
  store.sub('conn', render);
  render(store.get('conn'));
}


// ── 擴充方言面板 ────────────────────────────────────
//
// 新協議 mudlib（大梦江湖等）多出 60+ 個 opcode，但它們的內容結構只有幾種
// （標題／文字／清單／動作網格／數值條／實體增刪）。與其為每個功能寫一套 UI，
// 這裡用一個分頁式容器承載全部，內容依 dialects.js 給的 kind 決定怎麼畫。
// 見 docs/ZJMUD_CLIENT_LOGIC_DESIGN.md §4.8。

export function ExtPanels(root, { store, ctx, panelTitles }) {
  const tabs = document.getElementById('ext-tabs');
  const body = document.getElementById('ext-body');
  document.getElementById('ext-close')?.addEventListener('click', () => ctx.closeExtPanel());

  function render() {
    const panels = store.get('ext.panels') ?? {};
    const active = store.get('ext.active');
    const names = Object.keys(panels);

    root.hidden = names.length === 0;
    if (root.hidden) return;

    // 分頁
    clear(tabs);
    for (const name of names) {
      const b = el('button', {
        class: 'tab' + (name === active ? ' active' : ''),
        type: 'button',
        text: panelTitles[name] ?? name,
      });
      b.addEventListener('click', () => ctx.setExtPanel(name));
      tabs.append(b);
    }

    // 內容
    clear(body);
    const p = panels[active] ?? panels[names[0]];
    if (!p) return;

    if (p.title) {
      const t = el('div', { class: 'ext-title' });
      t.append(renderStyled(p.title, ctx).frag);
      body.append(t);
    }

    // 實體（戰鬥的敵我雙方）
    for (const side of ['ally', 'enemy']) {
      const list = p.entities?.[side];
      if (!list || !list.length) continue;
      body.append(el('div', { class: 'ext-side-label', text: side === 'ally' ? '我方' : '敵方' }));
      const box = el('div', { class: 'ext-entities' });
      for (const e of list) {
        const item = el('button', { class: 'entity', type: 'button' });
        const nm = el('span', { class: 'entity-name' });
        nm.append(renderStyled(e.label, ctx).frag);
        item.append(nm);
        if (e.bar && e.bar.max > 0) {
          const pa = Math.max(0, Math.min(100, (e.bar.a / e.bar.max) * 100));
          const pb = Math.max(0, Math.min(100, (e.bar.b / e.bar.max) * 100));
          item.append(el('span', { class: 'entity-bar' }, [
            el('i', { class: 'bar-b', style: { width: pb + '%' } }),
            el('i', { class: 'bar-a', style: { width: pa + '%' } }),
          ]));
        }
        item.addEventListener('click', () => ctx.send(e.id));
        box.append(item);
      }
      body.append(box);
    }

    // 依 slot 順序輸出其餘內容
    for (const [slot, entry] of Object.entries(p.slots ?? {})) {
      if (entry.kind === 'text') {
        const d = el('div', { class: 'ext-text' });
        d.append(renderStyled(String(entry.text).split('$br#').join('\n'), ctx).frag);
        body.append(d);
      } else if (entry.kind === 'list') {
        const g = el('div', { class: 'ext-grid' });
        g.style.setProperty('--ext-cols', '2');
        for (const it of entry.items ?? []) {
          const b = el('button', { class: 'chip', type: 'button' });
          b.append(renderStyled(it.label, ctx).frag);
          b.addEventListener('click', () => ctx.send(it.cmd));
          g.append(b);
        }
        body.append(g);
      } else if (entry.kind === 'actions') {
        const g = el('div', { class: 'ext-grid' });
        g.style.setProperty('--ext-cols', String(entry.layout?.cols ?? 3));
        for (const it of entry.items ?? []) {
          const b = el('button', { class: 'action', type: 'button' });
          const t = el('span', { class: 'action-title' });
          t.append(renderStyled(it.title, ctx).frag);
          b.append(t);
          if (it.sub) b.append(el('span', { class: 'action-sub', text: it.sub }));
          b.addEventListener('click', () => ctx.runAction(it));
          g.append(b);
        }
        body.append(g);
      } else if (entry.kind === 'bars') {
        const box = el('div', { class: 'stat-bars' });
        box.style.setProperty('--stat-cols', String(entry.layout?.cols ?? 2));
        for (const bar of entry.bars ?? []) {
          if (bar.mode === 'text') {
            box.append(el('div', { class: 'stat stat-text', text: `${bar.label}：${bar.text}` }));
            continue;
          }
          const pa = bar.max > 0 ? Math.max(0, Math.min(100, (bar.a / bar.max) * 100)) : 0;
          const pb = bar.max > 0 ? Math.max(0, Math.min(100, (bar.b / bar.max) * 100)) : 0;
          box.append(el('div', { class: 'stat' }, [
            el('div', { class: 'stat-track' }, [
              el('i', { class: 'bar-b', style: { width: pb + '%' } }),
              el('i', { class: 'bar-a', style: { width: pa + '%', background: bar.color || 'var(--accent)' } }),
            ]),
            el('span', { class: 'stat-label', text: `${bar.label} ${bar.a}/${bar.max}` }),
          ]));
        }
        body.append(box);
      }
    }
  }

  store.sub('ext', render);
  render();
}
