// 極簡狀態容器 + pub/sub。
//
// 刻意不引入 Redux/Pinia：整個客戶端的狀態不到 20 個欄位，
// 而且資料流是單向的（伺服器事件 → store → UI），不需要中介軟體或時間旅行。
//
// 單向資料流原則（見 docs/ZJMUD_CLIENT_LOGIC_DESIGN.md §4.5）：
//   UI 永遠不直接改「遊戲狀態」，只送指令；狀態一律由伺服器回傳驅動。
//   例外是純本地偏好（主題、描述摺疊、字級）。

/** 訊息區容量上限。原版硬編 50/100/500，這裡可調。 */
export const DEFAULT_LIMITS = {
  main: 500,   // 原版是 50，太少了 —— MUD 玩家常需要往回捲
  chat: 500,
  sys: 500,
  combat: 200,
};

function initialState() {
  return {
    conn: {
      state: 'IDLE',     // IDLE | CONNECTING | OPEN | RECONNECTING | FAILED
      host: null,
      port: null,
      retries: 0,
      nextRetryMs: 0,
      multiline: true,   // ESC997/998
      lastError: null,
    },
    room: {
      title: '',
      titleCmd: null,    // ESC006 的 bs 槽位：房間名本身可點擊
      desc: '',
      descHidden: false,
      descForcedHidden: false, // ESC023 強制隱藏，優先於使用者偏好
      exits: [],
      titleButtons: [],
      objects: [],       // { label, cmd, bar?: {a,b,max} }
    },
    stats: { bars: [], layout: null },
    msgs: { main: [], chat: [], sys: [], combat: [] },
    target: { id: null, name: null },
    overlay: {
      kind: null,        // null | interact | dialog | map | paged | web | popmenu
      detail: '',
      promptTemplate: null,
      needNumber: false,
      actions1: null,
      actions2: null,
      dialog: null,
      map: '',
      paged: '',
      pagedPage: 0,
      story: null,       // 指游 ZYSTORYTEXT：{ text, speedMs, background }
      web: '',
      popMenu: null,
    },
    quick: {
      // 槽位 → { label, cmd }。bs 存在 room.titleCmd。
      slots: {},
      showCustom: false, // false = 顯示方向盤，true = 顯示自訂按鈕列
    },
    // 擴充方言面板（新協議 mudlib）。panels[名稱] = { title, slots{}, entities{} }
    ext: { panels: {}, active: null },
    ui: {
      theme: 'night',    // night | day | mud
      fontScale: 1,
      combatVisible: false,
      chatTab: 'chat',   // chat | sys
      netStatVisible: false, // 指游 ZYCLIENTSTATUS
    },
  };
}

export function createStore(limits = DEFAULT_LIMITS) {
  let state = initialState();
  const subs = new Map(); // path → Set<cb>

  /**
   * notify 的遞迴深度上限。
   *
   * 【WHY】2026-07-29 事故的教訓：一個「自己造成的事件被當成外部事件、於是再做一次」
   * 的迴圈，在傳輸層造成了每秒一次、累計五萬次的伺服器登入。
   *
   * 【推理】同樣的形狀在狀態層也成立：訂閱回呼裡若寫回同一個 path，
   * notify → 回呼 → set → notify 就是無限遞迴。目前 21 個訂閱者都只做渲染、
   * 沒有寫回狀態，所以還沒發生；但**沒有任何機制擋著**，
   * 而這類迴圈的症狀（畫面凍住／記憶體爆掉）極難從現象推回原因。
   * 與其等它發生，不如現在就讓它「當場說出自己是誰」。
   *
   * 【證據】net.js connect() 的事故註解；world/log/debug.log 50,251 次登入。
   */
  const MAX_NOTIFY_DEPTH = 20;
  let notifyDepth = 0;

  function notify(path) {
    if (notifyDepth >= MAX_NOTIFY_DEPTH) {
      // 不丟例外：狀態更新失敗不該把整個畫面帶掉。但一定要吵。
      console.error(
        `[store] notify 遞迴超過 ${MAX_NOTIFY_DEPTH} 層，已中止（path=${path}）。`
        + '通常是某個訂閱回呼在自己被通知時又寫回同一份狀態。');
      return;
    }
    notifyDepth += 1;
    try {
      notifyInner(path);
    } finally {
      notifyDepth -= 1;
    }
  }

  function notifyInner(path) {
    // 往上：通知該 path 與所有祖先 path 的訂閱者。
    const parts = path.split('.');
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join('.');
      const set = subs.get(p);
      if (set) for (const cb of set) cb(get(p), p);
    }

    // 往下：也要通知所有後代 path 的訂閱者。
    // 少了這段會有實際 bug —— 例如 resetRoom() 只 notify('room')，
    // 訂閱 'room.titleButtons' 的元件收不到通知，換房間後舊按鈕會殘留在畫面上。
    const prefix = path + '.';
    for (const p of subs.keys()) {
      if (p !== '*' && p.startsWith(prefix)) {
        const set = subs.get(p);
        if (set) for (const cb of set) cb(get(p), p);
      }
    }

    const root = subs.get('*');
    if (root) for (const cb of root) cb(state, path);
  }

  function get(path) {
    if (!path || path === '*') return state;
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
  }

  function set(path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    const parent = parts.reduce((o, k) => (o[k] ??= {}), state);
    if (parent[last] === value) return; // 值沒變就不通知
    parent[last] = value;
    notify(path);
  }

  /** 就地更新物件的部分欄位。 */
  function patch(path, partial) {
    const cur = get(path) ?? {};
    Object.assign(cur, partial);
    notify(path);
  }

  /** 追加一則訊息並套用容量上限。 */
  function pushMessage(channel, msg) {
    const arr = state.msgs[channel];
    if (!arr) return;
    arr.push(msg);
    const cap = limits[channel] ?? 500;
    if (arr.length > cap) arr.splice(0, arr.length - cap);
    notify('msgs.' + channel);
  }

  function clearMessages(channel) {
    if (!state.msgs[channel]) return;
    state.msgs[channel].length = 0;
    notify('msgs.' + channel);
  }

  function sub(path, cb) {
    if (!subs.has(path)) subs.set(path, new Set());
    subs.get(path).add(cb);
    return () => subs.get(path)?.delete(cb);
  }

  /** 換房間時的重置（ESC002 的副作用，見協議 §2.3）。 */
  function resetRoom() {
    state.room.exits = [];
    state.room.objects = [];
    state.room.titleButtons = [];
    state.room.titleCmd = null;
    state.ui.combatVisible = false;
    state.msgs.combat.length = 0;
    state.quick.showCustom = false;
    notify('room');
    notify('ui.combatVisible');
    notify('msgs.combat');
    notify('quick');
  }

  /** 擴充面板：寫入某個 slot 的內容。 */
  function extSet(panel, patch) {
    const panels = state.ext.panels;
    panels[panel] ??= { title: '', slots: {}, entities: { ally: [], enemy: [] } };
    Object.assign(panels[panel], patch);
    if (!state.ext.active) state.ext.active = panel;
    notify('ext');
  }

  function extSlot(panel, slot, entry) {
    const panels = state.ext.panels;
    panels[panel] ??= { title: '', slots: {}, entities: { ally: [], enemy: [] } };
    panels[panel].slots[slot ?? 'body'] = entry;
    if (!state.ext.active) state.ext.active = panel;
    notify('ext');
  }

  function extEntity(panel, side, entity) {
    const panels = state.ext.panels;
    panels[panel] ??= { title: '', slots: {}, entities: { ally: [], enemy: [] } };
    const list = panels[panel].entities[side] ??= [];
    const i = list.findIndex((e) => e.id === entity.id);
    if (i >= 0) list[i] = entity; else list.push(entity);
    if (!state.ext.active) state.ext.active = panel;
    notify('ext');
  }

  function extEntityRemove(panel, side, id) {
    const p = state.ext.panels[panel];
    if (!p) return;
    p.entities[side] = (p.entities[side] ?? []).filter((e) => e.id !== id);
    notify('ext');
  }

  function extClose(panel) {
    delete state.ext.panels[panel];
    if (state.ext.active === panel) {
      state.ext.active = Object.keys(state.ext.panels)[0] ?? null;
    }
    notify('ext');
  }

  function reset() {
    state = initialState();
    notify('*');
  }

  return { get, set, patch, sub, pushMessage, clearMessages, resetRoom, reset,
           extSet, extSlot, extEntity, extEntityRemove, extClose,
           get state() { return state; } };
}
