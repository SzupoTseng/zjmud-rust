// telnet 登入接應器 —— 讓 zjmud 客戶端玩「非 zjmud」的 mudlib。
//
// 【WHY】收藏之外還有一整個世界（mudlibs-main 的 98 個經典 lib），它們講的是
// 傳統 telnet：連線後印 ANSI 招牌、問「请输入您的英文名字：」。zjmud 客戶端
// 在登入視窗收到帳密後送的是 `账号║密码║密文║email`，telnet lib 看不懂 `║`——
// 於是「連得上、看得到招牌、進不去」。nt7 嫁接後的畫面就是活生生的示範。
//
// 【推理】會話層（招呼→帳號→建角）是一段與遊戲內容無關的固定對話，所以可以
// 由客戶端**按提示演完**：伺服器每印一行，接應器比對這一行像哪一步，把對應的
// 輸入送回去。帳密仍然來自登入視窗（使用者打的），接應器只是代替使用者
// 一行一行回答。這整層都在客戶端，mudlib 一個位元組都不動、driver 也不用改。
//
// 【邊界】這裡只做第一層（登入→進世界→純文字可玩）。房間面板／血條那些
// 需要結構化資料的 GUI 不在此層——那要嘛剖析文字（脆），要嘛回頭改 mudlib
// （那就是 SOP 的路線 B）。設計取捨見 docs/zjmud_migration_SOP.md §5。
//
// 【證據】profile 的每一條 pattern 都出自對應 lib 的 logind 原始碼（確切字串，
// 不是猜的）；generic-cn 的字眼取自 mudlibs-main 多個家族 logind 的交集。

/**
 * 一條規則：這一行像什麼 → 回什麼。
 * send 裡的 {id}/{pw}/{name} 會被實際值取代；null 表示「這一步不用回」。
 */
/**
 * 「祈使句型提問」——沒有問號也沒有冒號，但確實在等你按鍵。
 *
 * 【WHY 要抽成常數】這個判斷本來寫了**兩份**：一份在 `enter` 規則裡，
 * 一份在 `isPrompt` 守衛裡。放寬規則卻忘了守衛，結果規則永遠沒機會被評估
 * ——风云Ⅱ 的「请敲回车键［ＲＥＴＵＲＮ］」照樣沒人答，改了等於沒改。
 * 同一個概念只能有一個定義，否則兩份必然漂移。
 */
export const IMPERATIVE_PROMPT =
  // 【WHY 不再要求行首】模拟华附 的是
  //   `欢迎你第一次来到模拟华附！请敲回车键［ＥＮＴＥＲ］．．．．．`
  // ——祈使句接在歡迎詞後面，`^` 錨點直接漏掉，而這是登入的最後一關。
  // 【WHY 仍然安全】條件很具體：`按/敲/直接` 緊接 `回车/任意`，
  // 敘述文字不會出現這個組合。另加英文的 `Press … Enter`（隨缘洗剑录）。
  /(请|請)?\s*(按|敲|直接)(一下)?(回车|回車|任意)|Press\s+(?:any\s+key|Enter|Return)/i;

const P = (match, send, note = '', opts = {}) => ({ match, send, note, req: opts.req !== false });

/**
 * profile 註冊表。每個 telnet lib 家族一份；`generic-cn` 是共同字眼的退路。
 *
 * 規則由上往下比對，**一行最多觸發一條**；`once` 類的步驟觸發過就不再觸發
 * （由 seen 集合控制），避免伺服器重印提示時重覆送。
 */
export const PROFILES = {
  // 东方故事Ⅱ（mudlibs-main dongfanggushi2）。
  // 每一條 pattern 都是該 lib logind.lpc 的**確切提示字串**（全形冒號、無空格），
  // 順序照登入流程：英文名 → 確認 → 密碼×2 → email → 種族 → 性別 → 中文名。
  // 兩個已知地雷：①性別要一次答對 m/f（logind 的 retry 分支有 bug，答錯直接
  // runtime error）；②中文名必須過 is_chinese，所以送固定合法中文名。
  dongfanggushi2: [
    P(/您的英文名字：/, '{id}', 'name'),
    P(/新的人物.*\(y\/n\)|您确定吗\(y\/n\)/, 'y', 'confirm'),
    P(/请再输入一次您的密码/, '{pw}', 'pw-confirm'),
    // 拒絕/重設類提示也要接住：「密码…太短，请重设您的密码」「您两次输入的
    // 密码不一样，请重新设定一次密码」——第一版只認「请设定您的密码：」，
    // 使用者的密碼一被打回票，接應器就啞了（實測卡死點）。
    P(/重设您的密码|重新设定.{0,6}密码|请设定您的密码：/, '{pw}', 'pw'),
    P(/电子邮件地址：/, 'player@example.com', 'email'),
    P(/你的选择：/, 'human', 'race'),
    P(/男性\(m\)的角色或女性\(f\)/, '{gender}', 'gender'),
    P(/您的中文名字：/, '{name}', 'cname'),
  ],

  // nt7（泥潭七＋nitan170911 嫁接）：zjmud 握手殼＋telnet 互動登入的混血。
  // jiance() 收任何非空輸入就放行（實測 nitan 家族皆然），所以第一條規則
  // 是「看到 ver1.0 挑戰行就隨便答一個」；之後是 nitan 系的互動提示。
  nt7: [
    P(/^ver1\.0[,:]/, 'zjclient', 'challenge', { req: false }),
    P(/请输入您的英文名字/, '{id}', 'name'),
    P(/再[输輸]入一次|重复.{0,4}密码|确认.{0,4}密码/, '{pw}', 'pw-confirm', { req: false }),
    P(/密码/, '{pw}', 'pw'),
    P(/\(y\/n\)|是否正确|确定吗/, 'y', 'confirm', { req: false }),
    P(/性别|男性|\(m\/f\)/, '{gender}', 'gender', { req: false }),
    P(/中文名字/, '{name}', 'cname', { req: false }),
    P(/e-?mail|电子邮件/i, 'player@example.com', 'email', { req: false }),
  ],

  'generic-cn': [
    // 名字（帳號）。各家寫法：英文名字／英文姓名／your name／ID
    P(/英文名字|英文姓名|您的名字|你的名字|What is your name|your name|请输入.{0,6}(ID|id|帐号|账号)/, '{id}', 'name'),
    // 新帳號：設定密碼 → 再輸入一次。「再/重/确认」要排在一般「密码」之前
    P(/再[输輸]入一次|重[复覆].{0,4}密[码碼]|[确確][认認].{0,4}密[码碼]|Retype|again/, '{pw}', 'pw-confirm', { req: false }),
    P(/密[码碼]/, '{pw}', 'pw'),
    // 確認類：新名字 (y/n)、是否正確——不是每台都有，不列入必經
    // 【WHY 要涵蓋「同意」】侠客行系會反覆擲天賦骰：
    //   `膂力[19]， 悟性[25]， 根骨[18]， 身法[19]， 耐力[19]`
    //   `您同意这一组天赋吗？`
    // 原本只認「确定吗」「(y/n)」，這句沒人答（或被選單規則搶去答數字），
    // 伺服器就一直重骰重問——實測 14 台一起卡在這個迴圈。
    // ★ BIG5 詢問是**唯一要答 n 的是非題**，必須先攔下來。
    // 【WHY】书剑天下 開場問 `Are you using BIG5 font(Y/N)?`，
    // 通用 confirm 規則看到 `(Y/N)` 就回 `y`——等於選了 BIG5，
    // 後面整份中文（名字檢查、房間描述）全用錯碼表。
    // 與 `encoding` 規則同源：**一律選 GB**。
    P(/(?:BIG5|Big5|big5).{0,20}[（(]\s*[YyNn]\s*\/\s*[YyNn]\s*[）)]/, 'n', 'not-big5', { req: false, first: true }),
    // 【WHY 不能用 `[\s\S]*?` 當前綴來排除 BIG5】那會讓匹配從**位置 0** 開始，
    // 而規則排序的判準是「命中位置越後面越優先」（同一行有兩個提示時答後面那個）。
    // confirm 因此從第一名掉到最後——星戰英雄那句
    //   「您的英文名字：…使用 wasmtest 这个名字…您确定吗(y/n)？」
    // 會回去答已經過去的那一題（又送一次名字），卡在原地。
    // 單元測試「同一行有兩個提示時，答後面那個」正是為這個場景寫的，
    // 而我改壞它之後**跑了幾十輪都沒發現**——因為那幾十輪都沒跑 npm test。
    // 【正解】BIG5 的排除交給 not-big5 規則自己（它比 confirm 更specific），
    // confirm 維持原本的、錨在真實位置上的寫法。
    P(/\(y\/n\)|\(Y\/N\)|是否正[确確]|[确確]定[吗嗎]|同意.{0,10}[吗嗎]|接受.{0,10}[吗嗎]|[（(]\s*y\s*[）)][^\n]{0,10}[（(]\s*n\s*[）)]/, 'y', 'confirm', { req: false }),
    P(/性[别別]|男性|女性|\(m\/f\)|\(M\/F\)/, '{gender}', 'gender', { req: false }),
    // 中文名字：ES2／金庸系都會問，而且必須真的是漢字（is_chinese 把關）。
    // 【WHY 補這條】星戰英雄實測卡在這一題——generic-cn 原本沒有它，
    // 接應器對「您的中文名字：」一聲不吭，登入就停在那裡。
// 姓氏與名字可能**分兩題問**（終極地獄：「您的中文姓氏(不要超过两个汉字)」
    // →「您的中文名字(不要超过两个汉字)」），所以要涵蓋「姓氏」且**可重答**。
    // 預設值取兩個字，剛好符合這類「不超過兩個漢字」的限制。
    P(/中文名字|中文姓名|中文姓氏|您的姓名|贵姓|姓氏/, '{cname}', 'cname', { req: false }),
    // 「請輸入您的全名(即姓和名字的組合)」——終極地獄在姓、名分開問完之後，
    // 還要你把兩者合起來再打一次確認。送同一個兩字名即可（姓名各一字時亦可）。
    P(/全名|姓和名字的组合|姓和名字的組合/, '{fullname}', 'fullname', { req: false }),
    // 天賦／屬性擲骰確認：ES2 系建角的最後一關（星戰英雄實測）。
    // 沒有這條規則時接應器對它一聲不吭，而「連續幾行沒命中」的完成判定
    // 會誤以為登入結束——**新問題被當成安靜**。
    // 同一題會換句話問（實測：「您接受这一组天赋吗？」→「您同意这一组天赋吗？」），
    // 所以要涵蓋同義詞；而且**必須可重答**——它會一直重擲直到你點頭。
    P(/(接受|同意|满意|滿意).{0,4}(天赋|天賦|属性|屬性)/, 'y', 'talent', { req: false }),
    // 數字選單：「请输入您的选择(0-4)：」——0 通常是「由系統隨機」，
    // 那正是自動登入要的（書劍系實測）。限定 0 開頭的範圍以免誤觸其他選單。
    P(/(选择|選擇)\s*[（(]\s*0\s*[-－]/, '0', 'choice', { req: false }),
    // 「您要扮演角色的类型？ [1. 猛士型 2. 智慧型 …]」這種**編號選單**：
    // 送 1（第一項）。限定「型／类／種族／职业」等字眼，避免打到一般問句。
    // ── 以下五條都是實測「登入沒走完」的主因，各自影響一整群 lib ──

    // ① 內碼選擇（GB／Big5）——**登入的第一道門**，過不了後面全部免談。
    // 【WHY】`Please select 国标码〖GB〗or き絏〖Big5〗(GB/Big5):` 一連問兩次，
    // 不答就停在這裡。實測 7 台卡在這（海洋、逍遥仙境系、笑傲系…）。
    // 一律選 gb：本專案的字串處理與 is_chinese 修正都以 GB 為前提，
    // 選 Big5 會讓後面的中文名字檢查用錯碼表。
    P(/[（(]\s*(?:GB|Gb|gb)\s*\/\s*(?:BIG5|Big5|big5)\s*[）)]|国标码.{0,12}(?:BIG5|Big5|big5)/, 'gb', 'encoding', { req: false }),

    // ② 天賦分配的「隨機」選項。
    // 【WHY】`您可以输入 (1-4) 指定其中的一项值，或者输入 0 由系统随机选择。`
    // 「您的选择是 (0-4)：」——實測 8 台卡在這一句。
    // 送 `0`（系統隨機）最穩：指定某一項還要接著問點數，
    // 而各家的點數規則都不一樣，一路猜下去必然出錯。
    // 第三種寫法：`请输入您的选择(0-4)：`——沒有「是」字，範圍直接跟在後面。
    // 書劍系用這種，漏掉它就會退回去問逐項數值，而那條路各家規則都不同。
    P(/(?:输入|輸入)\s*0\s*(?:表示|由).{0,10}(?:随机|隨機)|(?:选择|選擇)是?\s*[（(]\s*0\s*[-－~～]\s*\d/, '0', 'talent-random', { req: false }),

    // ③ 四項天賦一次輸入。
    // 【WHY】大唐双龙：`四项之和必须等于八十点…例如：20 20 20 20`
    // 直接抄它自己給的範例——那是它保證收得下的組合，不必自己算總和。
    P(/(膂力|臂力)\s+(悟性|智力)\s+(根骨|体质|體質)\s+(身法|敏捷)|四项之和|四項之和/, '20 20 20 20', 'talent-four', { req: false }),

    // ④ 逐項詢問點數。
    // 【WHY】`请问您希望的膂力是多少? 合法的值是 10-30, 目前剩下 160 :`
    // 以及 `请输入您的膂力点数(10到30)：`——會問四到八次，每次都要合法值。
    // 取範圍**中點**最安全：取下限有些台嫌太低會重問，
    // 取上限會把總點數提早用光，後面幾項就湊不出合法值。
    P(/(?:合法的值是|点数|點數|是多少)[^0-9]{0,16}(\d{1,3})\s*[到\-－~～]\s*(\d{1,3})/, '{mid}', 'talent-one', { req: false }),

    // ⑧ 新玩家要先送 `new` 才進註冊流程。
    // 【WHY】仙侣情缘：`您的英文名字：（新玩家请键入 new 注册）`
    // 直接送帳號名會被當成「查詢既有玩家」而查無此人，一路重問。
    // 提示就寫在括號裡——**答案在題目上**，抓它就好。
    // 【WHY 能贏過 name 規則】規則排序是「命中位置越後面越優先」，
    // `new` 出現在「英文名字：」之後，自然勝出；送完 `new`
    // 伺服器才會問名字，那時才輪到 name 規則。
    P(/(?:新玩家|新人|新用户)[^\n]{0,8}(?:键入|鍵入|输入|輸入)\s*[「『"]?\s*new\b/i, 'new', 'new-player', { req: false, bracketOk: true }),

    // ⑥ 「進入遊戲／退出」的圈號選單。
    // 【WHY】小雨西游：`请您做出选择：① 进入游戏(Enter)  ② 立即退出(Exit)`
    // 括號裡就寫著要按什麼——`Enter` 即空行。答 `1` 或 `2` 都不對，
    // 而答錯 `2` 會直接退出遊戲，比不答更糟。
    P(/[①1][^\n]{0,6}(?:进入游戏|進入遊戲)[^\n]{0,12}Enter/i, '', 'enter-game', { req: false }),

    // ⑦ 未成年詢問——**唯一必須答 no 的是非題**。
    // 【WHY】逍遥情缘：`您是否是中小学学生或年龄更小？(yes/no)`
    // 通用 confirm 不認 `(yes/no)` 全寫；就算認了也會答 yes，
    // 那等於自報未成年 → 伺服器直接請你離開。
    P(/(?:中小学|中小學|未成年|年龄更小|年齡更小)[^\n]{0,12}[（(]?\s*(?:yes\/no|y\/n)/i, 'no', 'not-minor', { req: false }),

    // ⑤ 身份標識（自殺／找回密碼用），要求 ≥9 字元。
    // 【WHY】龙云梦／炎龙风隐：`身份标识的长度至少要九个字符，请重设您的身份标识：`
    // 這是密碼之後的**額外一關**，規則表裡完全沒有對應，登入就停在這裡。
    P(/身份标识|身份標識|识别码|識別碼/, 'zjmudguest99', 'identity', { req: false }),

    // 【WHY 關鍵字與標點之間要放寬到 12 字】风云Ⅱ 實測卡在
    //   「请选择你在风云Ⅱ中的民族（0，1，2，3）：」
    // 關鍵字後面夾著一整組選項括號，`.{0,3}` 完全構不到冒號，
    // 於是這一題沒人答，登入停在這裡（33 台「登入沒走完」裡的一群）。
    // 【WHY 仍然安全】命中條件綁在**這些名詞**上（民族／职业／门派…），
    // 敘述文字不會把它們擺在問句結尾；放寬的只是「名詞到標點的距離」。
    // ★ 是非題要先排除掉。
    // 【WHY】把「天赋」加進關鍵字之後，`您同意这一组天赋吗？` 也被判成選單，
    // 於是回了 `1` 而不是 `y`；伺服器重骰再問，一來一回撞上迴圈防線——
    // **一次放寬讓 14 台從 playable 退回 limited**。
    // 選單題是「要你選一個」，是非題是「要你同意」，兩者答案型別根本不同。
    // 判準：整行只要出現 `吗？`／`嗎？` 就不是選單，直接讓 confirm 去接。
    // ★ 光有「關鍵字＋冒號」不算提問，還必須有**要求作答的動詞**。
    // 【WHY】书剑天下 的天賦說明開頭是
    //   `书剑天下中的人物具有以下四项天赋：`
    // ——這是**清單標題**，冒號後面接的是 1./2./3./4. 的說明。
    // 接應器把它當選單答了 `1`，伺服器收下當成「指定第 1 項」，
    // 接著問「请输入您想要的数值(10-30)：」，我們原本要給選擇題的 `0`
    // 就變成了數值 → `数值错误，请重新输入：` → 一路錯到底。
    // 這正是「規則要綁在**提問**上，不是綁在關鍵字上」的又一次現形。
    // ★ 兩種形態要分開，因為**標點決定了它是不是提問**：
    //   `您要扮演角色的类型？`            → 問號結尾＝真提問，直接答
    //   `书剑天下中的人物具有以下四项天赋：` → 冒號結尾＝清單標題，還要看有沒有動詞
    // 【WHY】先前為了擋掉清單標題，一律要求句中有「请／选择／输入」，
    // 結果把 `您要扮演角色的类型？` 也擋掉了（它一個動詞都沒有），
    // 侠客新传／終極地獄艾若幽蘭 因此停在選型別那一題。
    // **收緊過頭和放寬過頭一樣會壞事**，差別只在壞的是哪一群。
    P(/^(?![\s\S]*[吗嗎]\s*[？?])[\s\S]*?(类型|類型|种类|種類|职业|職業|门派|門派|种族|種族|民族|性格|资质|資質|出生|出身|天赋|天賦|魔法|属性|屬性).{0,16}[？?]\s*$/, '1', 'menu-q', { req: false }),
    P(/^(?![\s\S]*[吗嗎]\s*[？?])(?=[\s\S]*(?:请|請|选择|選擇|输入|輸入))[\s\S]*?(类型|類型|种类|種類|职业|職業|门派|門派|种族|種族|民族|性格|资质|資質|出生|出身|天赋|天賦|魔法|属性|屬性).{0,16}[？?：:]/, '1', 'menu', { req: false }),
    // 「请选择一种绝学。」這類編號選單（句號結尾），送 1。
    P(/(请|請)(选择|選擇).{0,8}[。.：:]?\s*$/, '1', 'menu2', { req: false }),
    // 「按回车键由系统随机产生」——這類提示沒有問號也沒有冒號，
    // 但它確實在等輸入；送空行即可（金庸文字版的屬性分配）。
    // 必須是**整行**的祈使句（行首就是「按…回車」）。
    // 【WHY】只要包含就作答的話，說明文字也會中：泥潭系的建角解說有一句
    // 「…可以不输入姓，直接敲回车略过。」——接應器在解說階段就送了空行，
    // 被伺服器當成「姓氏」的答案，整個登入從此錯位。
    // 【WHY 允許「请」開頭】风云Ⅱ 的是「请敲回车键［ＲＥＴＵＲＮ］．．．」，
    // 只認 `^(按|敲|直接)` 會漏掉——而這是登入的**最後一關**，
    // 漏掉就等於前面全白做。祈使句前面加個「请」是最常見的寫法。
    P(IMPERATIVE_PROMPT, '', 'enter', { req: false }),
    // 「请输入任意键继续或 N 秒后自动进入游戏」——建角完成後的最後一關。
    // 不答也會自動進去，但那要等好幾秒；直接送空行省下等待。
    P(/任意[键鍵]|按任意/, '', 'anykey', { req: false }),
// 必須要求「地址」二字。
    // 【WHY】只比對 "email" 會被**開場招牌**打中——星戰英雄的歡迎畫面有一行
    //   「有任何意见请 email : czb@mail.zz.hn.cninfo.net」
    // 接應器於是在還沒被問任何問題時就把 a@b.c 送出去，變成英文名字，
    // 伺服器回「你的英文名字必须是 3 到 12 个英文字母」——一路連鎖錯到底。
    // 這是「規則要綁在**提問**上，不是綁在關鍵字上」的血淚版。
    // 位址要「像樣」：a@b.c 被書劍系判為不合格式（它要求 id@address），
    // 用完整網域最保險，各家的檢查都過得了。
    P(/(电子)?邮件地址|(電子)?郵件地址|e-?mail address/i, 'player@example.com', 'email', { req: false }),
  ],
};

/**
 * **進世界之後**才會遇到的關卡。
 *
 * 【WHY】登入流程結束（收到第一個 opcode）不等於「可以玩了」。泥潭系實測：
 * 建角完成後玩家被丟進 `/d/register/regroom`——一個**沒有出口、沒有物件**
 * 的註冊室，要先下 `reg <email>` 才會被移進真正的世界。
 * 接應器一看到 opcode 就收工，於是使用者永遠卡在那裡；而閘門只檢查
 * 「有沒有收到 opcode」，照樣判 playable——**假綠燈**。
 *
 * 【推理】這類關卡的共同形狀是「已經在世界裡，但伺服器要求先下某個指令」。
 * 它不屬於登入對話（沒有 `：` 提示、混在房間描述裡），所以不能塞進 PROFILES；
 * 但也不能無限期地繼續代答——那會變成「陪聊機器人」。
 * 折衷：獨立規則表 ＋ **獨立且很小的預算**（4 次），用完就真的收手。
 *
 * 【證據】`d/register/regroom.lpc` init()：`add_action("do_register", "reg")`
 * ／`"register"` ／`"zhuce"`；do_register 只驗 `%s@%s.%s` 格式，寄信那段
 * 已被原作者註解掉，所以送出後直接 `me->move("/d/register/entry")`。
 */
export const POST_RULES = [
  {
    // 要同時看到「註冊指令」與「email」才算數——只比對 email 會被
    // 開場招牌的聯絡信箱打中（星戰英雄那次的教訓）。
    // 兩種寫法都要接得住：
    //   泥潭 「现在，请输入 reg 您的email地址」    → 動詞在指示句裡
    //   北美 「(register xxxxx@yyyy.zzz)」        → 括號裡的**範例**
    // 只寫第一種的話北美會漏掉（實測停在「侠客岛挂名处」動不了），
    // 因為它的措辭是「登记的指令：」——沒有「使用指令」四個字。
    match: /(?:请|請)?(?:输入|輸入|使用指令|指令\s*[：:]|用)\s*(reg|register|zhuce)\b[^\n]{0,20}(?:e-?mail|邮件|郵件|信箱)|[(（]\s*(reg|register|zhuce)\s+[^)）]*@[^)）]*[)）]/i,
    send: (m) => `${(m[1] || m[2] || 'reg').toLowerCase()} player@example.com`,
    note: 'in-world-register',
  },
  {
    // 性格／資質選單：「您可以选择(choose)的角色性格如下：… (choose 1-4)」
    // 【WHY】泥潭系在註冊室之後還有一間「生命之谷」，要先 choose 再 born
    // 才走得出去。少了這一關，玩家停在一間**沒有出口**的房間，
    // 而閘門看到 002/004/005 照樣判 playable。
    match: /\(\s*choose\s|选择\s*\(\s*choose\s*\)|選擇\s*\(\s*choose\s*\)/i,
    send: () => 'choose 1',
    note: 'in-world-choose',
  },
  {
    // 婉拒 NPC 的問答關卡。
    // 【WHY】书剑天下系的新手在「武馆前院」被 `valid_leave` 鎖住：
    //   `if (dir != "enter" && me->query_temp("wgquestion"))`
    //   `  return notify_fail("你先回答了冯坦的问题再离开也不迟啊！\n");`
    // ——**四個出口全部走不出去**，而房間面板一切正常，
    // 看起來完全像「這台的移動壞了」。真相是 NPC 狄云 出了一份考卷。
    // 送 `answer n`（婉拒）而不是 `answer y`：答錯有懲罰，
    // 而我們的目的只是離開這間房、證明世界可走。
    // 【證據】`d/wuguan/dayuan.lpc` valid_leave()；
    // `d/wuguan/npc/diyun.lpc` `add_action("do_answer", "answer")`
    // 與提示「不愿意回答的话…请输入 answer n」。
    match: /(?:输入|輸入)\s*[「『"]?\s*(answer\s+n)\b/i,
    send: () => 'answer n',
    note: 'in-world-decline-quiz',
  },
  {
    // 跟隨引路人：`follow <id>`。
    // 【WHY】北美侠客行 的開場是**腳本化**的：`add_action("block_cmd", "", 1)`
    // 只放行 quit/goto/follow/tell/say/reply/look，房間 `set("exits", ([ ]))`
    // 完全沒有出口——唯一的出路是跟著「赏善罚恶使」走。
    // NPC 自己把指令印在畫面上（`command("say …(follow " + id + ")")`），
    // 照著送即可，不必猜。不跟的話它會等 15 秒硬把人拖走，
    // 但那已經超過閘門的等待窗口，看起來就像「卡住不動」。
    // 【證據】`d/xiakedao/npc/zhangli.h` greeting()／check_follow()。
    match: /\(\s*follow\s+([a-z][a-z0-9]*(?:\s+[a-z0-9]+)?)\s*\)/i,
    send: (m) => `follow ${m[1].trim()}`,
    note: 'in-world-follow',
  },
  {
    // 洗天賦：`washto <膂力> <悟性> <根骨> <身法>`。
    // 【WHY】新手關卡是**連鎖**的，不是單一路障：泥潭系實測
    // reg → choose → washto → born 四關，少解一關就停在原地。
    // 數值直接抄伺服器自己給的範例（「例　　如：washto 20 20 20 20」）——
    // 那是它保證收得下的組合，我們不必猜點數上限。
    match: /washto\s*[<＜]|(?:指令格式|例\s*如)\s*[：:]\s*washto/i,
    send: (m) => {
      const eg = /washto\s+((?:\d+\s+){1,5}\d+)/.exec(m.input ?? '');
      return `washto ${eg ? eg[1].trim() : '20 20 20 20'}`;
    },
    note: 'in-world-washto',
  },
  {
    // 投胎：`born <地名>`。地名**從提示文字裡抓**，不要寫死——
    // 各家的 born mapping 不一樣（泥潭有「扬州人氏」，別家可能只有「中原人氏」），
    // 寫死一個就等於賭。抓不到才退回最通用的「扬州人氏」
    // （金庸群侠传系的新手城，`/d/city/kedian`）。
    match: /born\s*[<＜]?\s*(?:地名|地点|地點)|投胎|(?:输入|輸入)\s*born\b/i,
    send: (m) => {
      const listed = /([\u4e00-\u9fff]{2,3}人氏)/.exec(m.input ?? '');
      return `born ${listed ? listed[1] : '扬州人氏'}`;
    },
    note: 'in-world-born',
  },
];

/**
 * 每個 profile 的**欄位規格**：telnet lib 會問什麼、各欄的硬性限制。
 *
 * 【WHY】沒有這張表以前，限制是靠伺服器的拒絕訊息才知道的——使用者
 * tttt/tttt 登入东方故事，密碼太短被「请重设您的密码」打回票，接應器
 * 對不上那句話就啞掉，使用者只看到靜止的畫面。**驗證要前移到 client**：
 * 登入視窗在送出前就照這張表把關、把要求講在欄位旁邊，
 * 伺服器的拒絕流程從此是備援，不是第一道防線。
 *
 * 【證據】每一格都出自對應 lib 的 logind 原始碼（mudlibs-main 調查）：
 * 东方故事Ⅱ id 3–12 個 a–z、密碼 ≥5、中文名 1–6 字且逐字過 is_chinese；
 * 山海战神 id 3–20、名字 1–10 **不限中文**；笑傲迷你 密碼 ≥6、中文名 2–5；
 * 模拟华附 密碼 ≥6 且必須含大寫+小寫+數字。generic-cn 取各家的**交集偏嚴**
 * （寧可多擋一點，也不要送出去被伺服器彈回來）。
 */
export const FIELD_SPECS = {
  dongfanggushi2: {
    id:     { min: 3, max: 12, charset: /^[a-z]+$/, hint: '3–12 個小寫英文字母（不能有數字）' },
    pw:     { min: 5, hint: '至少 5 個字元' },
    cname:  { min: 1, max: 6, chinese: true, hint: '1–6 個中文字' },
    gender: { options: ['m', 'f'], hint: '男 m／女 f' },
  },
  nt7: {
    id:     { min: 3, max: 12, charset: /^[a-z][a-z0-9]*$/, hint: '3–12 字元，小寫字母開頭' },
    pw:     { min: 5, hint: '至少 5 個字元' },
    cname:  { min: 2, max: 4, chinese: true, hint: '2–4 個中文字' },
    gender: { options: ['m', 'f'], hint: '男 m／女 f' },
  },
  'generic-cn': {
    id:     { min: 3, max: 12, charset: /^[a-z]+$/, hint: '3–12 個小寫英文字母' },
    pw:     { min: 6, hint: '至少 6 個字元' },
    cname:  { min: 2, max: 4, chinese: true, hint: '2–4 個中文字' },
    gender: { options: ['m', 'f'], hint: '男 m／女 f' },
  },
};

const CJK = /^[\u3400-\u9fff\uf900-\ufaff]+$/u;

/**
 * 送出前的把關。回傳 { ok, errors: [{field, msg}] }；欄位缺規格就放行。
 * 這裡只驗，不改值——修正（補長、淨化）仍留在接應器當備援，
 * 但走到那一步應該越來越罕見。
 */
export function validateCreds(profile, { id = '', pw = '', name = '', gender = '' } = {}) {
  const spec = FIELD_SPECS[profile] ?? FIELD_SPECS['generic-cn'];
  const errors = [];
  const push = (field, msg) => errors.push({ field, msg });

  if (spec.id) {
    if (id.length < spec.id.min || id.length > spec.id.max) push('id', `帳號需 ${spec.id.hint}`);
    else if (spec.id.charset && !spec.id.charset.test(id)) push('id', `帳號需 ${spec.id.hint}`);
  }
  if (spec.pw && pw.length < spec.pw.min) push('pw', `密碼${spec.pw.hint}`);
  if (spec.cname && name) {   // 中文名選填：留空由接應器用預設
    const n = [...name].length;
    if (n < spec.cname.min || n > spec.cname.max) push('name', `角色名需 ${spec.cname.hint}`);
    else if (spec.cname.chinese && !CJK.test(name)) push('name', '角色名只能用中文字');
  }
  if (spec.gender && gender && !spec.gender.options.includes(gender)) {
    push('gender', `性別需 ${spec.gender.hint}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 給登入視窗顯示的「這台的要求」一句話。 */
export function specSummary(profile) {
  const spec = FIELD_SPECS[profile] ?? FIELD_SPECS['generic-cn'];
  return [
    spec.id && `帳號：${spec.id.hint}`,
    spec.pw && `密碼：${spec.pw.hint}`,
    spec.cname && `角色名：${spec.cname.hint}`,
  ].filter(Boolean).join('；');
}

/** 註冊（或覆蓋）一個 profile。匯入工具在 mud.json 裡帶 loginProfile 名稱。 */
export function registerProfile(name, rules) {
  PROFILES[name] = rules;
}

/** 註冊（或覆蓋）一個欄位規格。 */
export function registerFieldSpec(name, spec) {
  FIELD_SPECS[name] = spec;
}

/**
 * 從 metadata JSON 載入一個 telnet lib 的登入知識。
 *
 * 【WHY】profile 原本寫死在 client 原始碼裡——每接一台新 lib 就要改 client、
 * 重新部署。使用者點名的正確形態：**每台 lib 一份 `zjmud.metadata.<slug>.json`**，
 * 不改 mudlib 本體，但把「它會問什麼、每欄的限制、每一步怎麼答」抽成資料，
 * 跟映像放在一起發佈。client 啟動那台時動態載入；沒有 metadata 的退回內建 profile。
 *
 * 格式（rules 的 match 是 RegExp 原始碼字串）：
 *   { name, rules: [{match, send, note, req?}], specs: {id, pw, cname, gender} }
 */
export function loadMetadata(meta, fallbackName = 'generic-cn') {
  if (!meta || !Array.isArray(meta.rules)) return fallbackName;
  const name = meta.name || fallbackName;
  try {
    registerProfile(name, meta.rules.map((r) => ({
      match: new RegExp(r.match, r.flags || ''),
      send: r.send ?? '',
      note: r.note ?? '',
      req: r.req !== false,
    })));
    if (meta.specs) {
      registerFieldSpec(name, {
        ...meta.specs,
        // charset 序列化成字串，載入時編回 RegExp
        id: meta.specs.id
          ? { ...meta.specs.id, charset: meta.specs.id.charset ? new RegExp(meta.specs.id.charset) : undefined }
          : undefined,
      });
    }
    return name;
  } catch {
    return fallbackName;   // 壞掉的 metadata 不可讓整台開不了機
  }
}

/** 把一個內建 profile 匯出成 metadata JSON（extract 工具用）。 */
export function exportMetadata(name) {
  const rules = PROFILES[name];
  if (!rules) return null;
  const spec = FIELD_SPECS[name] ?? FIELD_SPECS['generic-cn'];
  return {
    name,
    generatedBy: 'webclient/tools/extract-zjmud-metadata.mjs',
    rules: rules.map((r) => ({
      match: r.match.source, flags: r.match.flags || undefined,
      send: r.send, note: r.note, ...(r.req === false ? { req: false } : {}),
    })),
    specs: {
      ...spec,
      id: spec.id ? { ...spec.id, charset: spec.id.charset ? spec.id.charset.source : undefined } : undefined,
    },
  };
}

/**
 * 建一個接應器。
 *
 * @param {object} opts
 * @param {string} opts.profile   PROFILES 的鍵；查無此鍵退回 generic-cn
 * @param {{id:string,pw:string,name?:string}} opts.creds  登入視窗收到的帳密
 * @param {(line:string)=>void} opts.send    往伺服器送一行
 * @param {()=>void} [opts.onDone]           判定已進世界時呼叫一次
 * @returns {{feed:(line:string)=>boolean, done:boolean}}
 */
export function createTelnetLogin({
  profile, creds, send, onDone = () => {}, onStalled = () => {},
  // 一連串提示只回答**最後一個**：伺服器常常把「拒絕訊息 + 重新提問」
  // 和「下一題」在同一個 burst 裡送出，逐行作答會多送一次，
  // 而多出來的那一行會被當成**下一題的答案**——炎黃英雄史實測：
  // 名字送兩次，第二次被當成 (y/n) 的回答，於是走進「好吧，请重新输入」的分支，
  // 從此原地打轉。等 burst 結束再答，就不會錯位。
  debounceMs = 60,
  // ★ 密碼原樣送出，不做任何補強。
  //
  // 【WHY】補強邏輯（補大寫／補數字／太像帳號就整個換掉）是為了**開新帳號**
  // 時滿足各家的密碼政策。但北美侠客行 的登記流程以「伺服器發一組新密碼、
  // 要求你用它重連」收尾（`您的新密码是osoni`）——這時候密碼是**既有事實**，
  // 補強會把 `osoni` 變成 `osoniZ9`，第二次登入必然失敗，
  // 而畫面上只會顯示「密码不對」，看起來像規則寫錯。
  keepPw = false,
} = {}) {
  const rules = PROFILES[profile] ?? PROFILES['generic-cn'];
  const seen = new Set();
  // ★ 迴圈防線：每條規則最多答幾次、整場最多送幾行。
  //
  // 【WHY】把名字類規則改成「可重答」之後，終極地獄 出現無限迴圈——
  // 它會要求「再輸入一遍你的全名以確認」，我們照答，它再問，一來一回
  // **951 次**。同一類事故 zjmud 客戶端犯過：伺服器 log 累積五萬次登入。
  // 「可重答」是為了處理被打回票，不是為了無止境地陪聊。
  //
  // 【推理】防線要有兩層：單一步驟重試上限（處理正常的「再輸入一次」），
  // 以及整場總量上限（處理我們沒預料到的迴圈）。撞到就**停止作答**並回報，
  // 讓使用者手動接手——寧可停在那裡讓人看見，也不要安靜地打爆伺服器。
  // 單步 8 次、整場 60 行。
  // 【WHY 不是更小】書劍系的登入很長，密碼被組合政策退回兩三次是正常流程；
  // 上限 4 會把「進度中的重試」誤判成「原地打轉」（實測那台其實一路進了世界）。
  // 【WHY 不是更大】真正的迴圈是**每秒數十次**（終極地獄 951 次），
  // 8 與 951 之間差兩個數量級，訂在這裡不會漏掉真迴圈。
  const MAX_PER_RULE = 8;
  const MAX_TOTAL = 60;
  const count = new Map();
  let totalSent = 0;
  let stalled = false;
  let done = false;
  let quiet = 0;      // 連續幾行沒有任何規則命中——用來判定「已經在世界裡了」
  // 進世界後的關卡預算：刻意很小。它要解決的是「註冊室」這種一次性路障，
  // 不是繼續參與遊戲；預算大了就變成沒人看管的機器人。
  const MAX_POST = 6;
  const postSeen = new Set();
  let postSent = 0;

  // {id} 要淨化成純小寫字母：老 telnet lib 的英文名字多半只收 a-z
  // （东方故事Ⅱ實測：wasmtest01 被「只能用英文字母」打回票，還會重問到死）。
  // 使用者帳號裡的數字在這種台上本來就開不了戶，去掉數字仍是同一個人的慣用名。
  const cleanId = (creds.id ?? '').toLowerCase().replace(/[^a-z]/g, '') || 'wanderer';
  // 密碼保底 6 字元。老 lib 普遍要求 ≥5（东方故事Ⅱ實測：4 字密碼被
  // 「密码的长度至少要五个字元，请重设」無限打回票，使用者就卡死在那裡）。
  // telnet 台的世界是拋棄式的（MEMFS，重整即消失），帳號活不過這個分頁，
  // 所以確定性補長不會把使用者鎖在門外——下次進來又是新world、同樣補得出來。
  // 密碼要同時滿足**各家最嚴的組合政策**：≥6 字元、含小寫、含大寫、含數字。
  // 【WHY】書劍系實測：「密码必须包含数字和英文大写字母」，我們送 test1234
  // 被無限打回票（防線攔在第 5 次）。模拟华附 更嚴（大小寫＋數字）。
  // telnet 台的世界是拋棄式的（MEMFS 重整即消失、帳號活不過這個分頁），
  // 所以確定性補強不會把使用者鎖在門外——下次進來又是新世界。
  let cleanPw = creds.pw ?? '';
  if (keepPw) {
    // 既有帳號：密碼是事實，不是我們可以協商的東西
  } else {
  // 密碼不可以「像帳號」——書劍系會回「对不起，您的密码太简单。」並無限重問。
  // 使用者常常帳密同字（測試時尤其），所以撞到這條政策的機率很高。
  if (!cleanPw || cleanPw.toLowerCase().includes(cleanId) || cleanId.includes(cleanPw.toLowerCase())) {
    // 補在後面沒有用——`wasmtest` + `Xk7` 仍然「包含帳號」。要整個換掉。
    cleanPw = cleanId.includes('qw7') ? 'Pq4Tn8' : 'Qw7Kx9';
  }
  if (!/[a-z]/.test(cleanPw)) cleanPw += 'z';
  if (!/[A-Z]/.test(cleanPw)) cleanPw += 'Z';
  if (!/\d/.test(cleanPw)) cleanPw += '9';
  if (cleanPw.length < 6) cleanPw = (cleanPw + 'zjMud9').slice(0, 8);
  }
  // 同一步被要求「換一個」時的備用密碼。
  // 【WHY】終極地獄：「系统要求你的管理密码和普通密码不能相同」——
  // 我們兩次都送同一個，於是無限重問。**被要求重設時就要真的換一個**，
  // 而不是把同一個再送一次。
  // 「全名」要送的是**前面答過的姓＋名的組合**。
  // 【WHY】泥潭系會分三題問：姓氏 → 名字 → 「请输入您的全名(即姓和名字的组合)」。
  // 我們三題都送同一個兩字名，第三題當然對不起來，伺服器把整個登入重來一遍，
  // 於是外表看起來是「cname 重複 9 次」——真因是**沒有記住自己答過什麼**。
  // 姓與名要**答不同的字**。
  // 【WHY】泥潭系分兩題問姓、名，兩題送同一個值會觸發它的疑問流程
  //   「系统发现你输入的姓和名字相同，这样你的名字将是『無名無名』…」
  // 進而要求重打全名，一路錯位。姓一個字、名一個字，合起來剛好是常見的兩字名。
  const CNAME_SEQ = ['風', '逸'];
  const cnameParts = [];
  const ALT_PW = ['Qw7Kx9', 'Rt5Nb3', 'Ym2Vc8'];
  let pwUses = 0;
  const nextPw = () => {
    const v = pwUses === 0 ? cleanPw : (ALT_PW.find((a) => a !== cleanPw) ?? cleanPw) + pwUses;
    return v;
  };

  const fill = (tpl, key) => tpl
    .replace('{id}', cleanId)
    .replace('{pw}', key === 'pw' ? nextPw() : cleanPw)
    .replace('{fullname}', cnameParts.length >= 2 ? cnameParts.join('') : (creds.name || '秦风'))
    .replace('{cname}', cnameParts.length < CNAME_SEQ.length
      ? CNAME_SEQ[cnameParts.length]
      : ((creds.name && creds.name.trim()) || '秦风'))
    // 角色名：使用者填了就用使用者的；沒填用預設中文名（ASCII id 過不了 is_chinese）
    .replace('{name}', (creds.name && creds.name.trim()) || '秦风')
    .replace('{gender}', creds.gender === 'f' ? 'f' : 'm');

  // burst 內只保留最後一個待答項
  let pending = null;
  let timer = null;
  function fire() {
    timer = null;
    // post 規則是**登入結束之後**才跑的，所以 done 不能一律擋下來
    if (!pending || (done && !pending.post)) return;
    const { key, rule, line } = pending;
    pending = null;
    // `{mid}` —— 從**這一題自己印出來的合法範圍**取中點。
    // 【WHY 不寫死一個數字】各家的範圍不同（10-30、5-25、1-100），
    // 寫死必然在某些台被判不合法而無限重問。範圍就印在問題裡，讀它最可靠。
    if (rule.send === '{mid}') {
      const r = /(?:合法的值是|点数|點數|是多少)[^0-9]{0,16}(\d{1,3})\s*[到\-－~～]\s*(\d{1,3})/.exec(line);
      const lo = r ? Number(r[1]) : 10;
      const hi = r ? Number(r[2]) : 30;
      totalSent += 1;
      send(String(Math.floor((lo + hi) / 2)));
      return;
    }
    if (key === 'pw' && /重新设置|重新設置|不能相同/.test(line)) pwUses += 1;
    const payload = fill(rule.send, key);
    if (key === 'cname') cnameParts.push(payload);
    totalSent += 1;
    send(payload);
  }
  function schedule(key, rule, line) {
    pending = { key, rule, line };
    if (debounceMs <= 0) { fire(); return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  }

  return {
    get done() { return done; },
    /** 是否因為重複作答而主動停手（與「成功進世界」要分得開）。 */
    get stalled() { return stalled; },
    /** 已經送出幾行。呼叫端用它判斷「要不要踢一腳」。 */
    get sentCount() { return totalSent; },
    /**
     * 餵一行伺服器輸出。回傳 true 表示這一行被接應器吃掉（已代答）。
     *
     * 進世界的判定：密碼步驟走過之後，連續多行都不再命中任何登入提示，
     * 就當作對話結束了。這比「認出第一個房間長相」可靠——房間長相每個
     * lib 都不同，而「不再被問問題」是登入結束的定義本身。
     */
    feed(line) {
      if (done) {
        // 進世界後的關卡：預算用完（或沒有規則命中）就真的收手。
        if (postSent >= MAX_POST) return false;
        const t = String(line ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        for (const r of POST_RULES) {
          const m = t.match(r.match);
          if (!m) continue;
          if (postSeen.has(r.note)) continue;   // 同一個關卡只解一次
          postSeen.add(r.note);
          postSent += 1;
          totalSent += 1;
          send(typeof r.send === 'function' ? r.send(m) : r.send);
          return true;
        }
        return false;
      }
      // 比對前剝掉 ANSI 色碼——有些 lib（xo）把提示包在色碼裡
      const text = String(line ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      if (text.trim() === '') return false;

      // ★ 一行裡有多個提示時，挑哪一個？兩條實測規則：
      //
      // 【WHY 要挑最後的】星戰英雄：伺服器把上一題與新的一題印在同一行——
      //   「您的英文名字：…使用 wasmtest 这个名字…您确定吗(y/n)？」
      // 「第一條規則優先」會去回答已經過去的那一題（又送一次名字），卡在原地。
      //
      // 【WHY 要排除括號內】只看「最後」又會打壞 nt7：
      //   「请输入您的英文名字(忘记密码请输入「pass」)：」
      // 括號裡的「密码」位置更後面，但那是**說明**不是提問。
      // 判準：匹配範圍**完全落在括號內部**（不含括號本身）者降級——
      //   `(y/n)` 這種「匹配把括號一起吃進去」的仍算正式提示（星戰要靠它）。
      const brackets = [];
      for (const m of text.matchAll(/[(（「【][^)）」】]*[)）」】]/g)) {
        brackets.push([m.index, m.index + m[0].length]);
      }
      const insideBracket = (a, b) => brackets.some(([o, c]) => a > o && b <= c - 1);
      // ★ 只有「行尾是提問符號」才作答。
      // 【WHY】開場招牌一再誤觸發：書劍系的歡迎畫面讓 confirm 與 email 兩條
      // 規則在**還沒被問任何問題**時就送出 y 與 email，白白吃掉重試額度，
      // 也把伺服器的狀態機弄亂（先前 email 那次更誇張，直接被當成英文名字）。
      // 提問一定以 ：／? 結尾（或 `> ` 提示符），敘述文字不會——
      // 這是「規則要綁在提問上」最直接的機械化判準。
      // 提問的形態有三種：以 ：／? 結尾、`> ` 提示符、
      // 以及「按回車鍵…」這種**祈使句**（沒有標點但確實在等輸入）。
      // 提問符號**不一定在行尾**：「您同意这一组天赋吗？(y 或 n)」的問號在句中，
      // 後面還跟著一段答法提示。允許它落在最後 14 個字元內即可——
      // 敘述文字若有問號，後面通常還有一長串，不會落在這個窗口裡。
      // 第四種形態：**句號結尾的祈使句**——「请选择一种绝学。」
      // 這類提示既沒有問號也沒有冒號，但「请/請 + 選擇/輸入」就是在要求作答。
      // 【WHY 從 14 放寬到 26】仙侣情缘的提問是
      //   `您的英文名字：（新玩家请键入 new 注册）`
      // 冒號後面跟著 15 個字的括號說明，剛好超出 14 的窗口，
      // 於是整行被判「不是提問」——連規則比對都沒進去，
      // 表面上看起來像「規則寫錯了」，其實是**守衛先把門關上**。
      // 26 仍然很緊：敘述文字裡的問號後面通常還有整段話。
      // 這是本檔第二次因為守衛與規則不同步而白改（見 IMPERATIVE_PROMPT）。
      const isPrompt = /[：:？?].{0,26}$/.test(text) || /[>＞]\s*$/.test(text)
        || IMPERATIVE_PROMPT.test(text)
        || /^[\s\S]{0,30}(请|請).{0,6}(选择|選擇|输入|輸入|决定|決定)/.test(text);
      if (!isPrompt) return false;

      const hits = rules
        .map((r, i) => {
          const m = text.match(r.match);
          if (!m) return null;
          const at = m.index;
          // `bracketOk`：這條規則**刻意**要接括號裡的指示。
          // 【WHY 需要例外】括號降級是為了 nt7 的
          //   `请输入您的英文名字(忘记密码请输入「pass」)：`
          // ——那是給「忘記密碼的人」的說明，不是給我們的。
          // 但仙侣情缘的 `您的英文名字：（新玩家请键入 new 注册）`
          // 括號裡裝的**正是給我們的指示**（我們就是新玩家），
          // 一律降級的話 name 規則會贏，送出帳號名換來「没有这个玩家．．．」，
          // 然後無限重問。差別在於「這段說明適不適用於我」，
          // 而那件事只有規則自己知道——所以做成規則層的明示旗標。
          // `first`：這條規則刻意要贏過同一行的其他命中（例如 BIG5 詢問
          // 必須答 n，而通用 confirm 看到 (Y/N) 會答 y）。
          return { r, i, at, hint: r.bracketOk ? 0 : insideBracket(at, at + m[0].length),
                   pri: r.first ? 0 : 1 };
        })
        .filter(Boolean)
        .sort((a, b) => (a.pri - b.pri) || (a.hint - b.hint) || (b.at - a.at) || (a.i - b.i));

      for (const { r } of hits) {
        // 「一次性」步驟：name / pw / pw-confirm / gender 各答一次就好。
        // 密碼類例外——有些 lib 密碼答錯格式會重問，所以 pw 允許重覆，
        // 但要靠 quiet 歸零避免跟 pw-confirm 打架。
        const key = r.note || String(rules.indexOf(r));
        // 可重答的步驟：名字（格式被打回票會重問）與密碼（同理）。
        // 其他步驟一次為限，避免伺服器重印畫面時重覆送。
        // pw-confirm 也要可重答：兩次密碼不一致被退回時，重設完伺服器會
        // **再問一次確認**，once-only 會讓第二次確認沒人答。
        const REPEATABLE = new Set(['pw', 'pw-confirm', 'name', 'talent', 'confirm', 'email', 'cname', 'choice', 'fullname', 'enter', 'menu', 'menu2', 'anykey',
          // 這幾步天生就會被問**很多次**：內碼一連問兩次、
          // 逐項天賦要問四到八項、選單被打回票會重印。
          'encoding', 'talent-one', 'talent-random', 'talent-four', 'identity',
          'menu-q', 'enter-game', 'not-minor', 'not-big5', 'new-player']);
        if (seen.has(key) && !REPEATABLE.has(key)) continue;
        // ★ 重試計數要**在有進展時歸零**。
        // 【WHY】書劍系的登入很長（名字→確認→密碼×N→屬性選單→email→…），
        // 期間密碼被政策打回票幾次是正常的。若計數只增不減，
        // 走到後面就會累積到上限而誤判「卡住」——實測這台其實一路進了世界，
        // 卻被報成 limited。**判準要區分「原地打轉」與「進度中的重試」**：
        // 只要換了一個新步驟，先前那些步驟的重試次數就該清掉。
        if (!seen.has(key)) count.clear();
        const n = (count.get(key) ?? 0) + 1;
        count.set(key, n);
        if (n > MAX_PER_RULE || totalSent >= MAX_TOTAL) {
          // 這一步一直重複＝我們答的東西伺服器不接受，繼續送只是打爆它
          stalled = true;
          done = true;
          onStalled(key, n);
          return false;
        }
        seen.add(key);
        quiet = 0;
        // 「請重新設置」類的提示 → 換一個密碼再送（同一個送兩次會被無限退回）
        if (key === 'pw' && /重新设置|重新設置|不能相同/.test(text)) pwUses += 1;
        schedule(key, r, text);
        return true;
      }

      // 完成判定＝**必經步驟全部走完**＋一小段沒有新提示。
      // 【WHY】第一版只數「連續幾行沒命中」，結果种族**選單**本身就是一串
      // 不命中的行，數到 5 就誤判完成——上層接著送 'look'，被伺服器當成
      // 種族答案打回票，badge 卻寫 playable。假綠燈比紅燈危險。
      // 「還有必經步驟沒走到」時，不管多安靜都不算完成。
      // ★ 進世界的**權威訊號**：收到 zjmud opcode（ESC + 三碼）。
      // 【WHY】原本靠「連續幾行沒命中」判定，星戰英雄的天賦說明是三行純文字，
      // 於是在**天賦問題還沒出現**時就誤判完成——接應器停止作答，登入卡死。
      // 轉換過的 lib 進世界時會送 ESC002（房間標題），那是協議層的事實，
      // 不是啟發式：看到它就是真的進去了。
      if (/^\x1b\d{3}/.test(text) || /\x1b00[24]/.test(text)) {
        done = true;
        onDone();
        return false;
      }

      const required = rules.filter((r) => r.req).map((r) => r.note);
      if (required.every((k) => seen.has(k))) {
        // `> `（或全形＞）單獨一行＝經典 MUD 的指令提示符，是「已在世界裡」
        // 最明確的訊號（东方故事Ⅱ實測：建角完成後只印一個 "> " 就安靜等指令，
        // 光靠 quiet 計數永遠湊不滿）。看到它直接判定完成。
        if (/^[>＞]\s*$/.test(text)) {
          done = true;
          onDone();
          return false;
        }
        // ★ 行尾是問號／冒號 ＝ 伺服器**還在等答案**，不管我們認不認得這一題。
        // 【WHY】北美侠客行的天賦說明有十幾行，數安靜行數到 8 就誤判完成，
        // 接應器停止作答，後面的「您接受这一组天赋吗？」永遠沒人回。
        // 「還有問題待答」是可以直接觀察的事實，不必靠猜。
        if (/[：:？?]\s*$/.test(text)) { quiet = 0; return false; }

        // 沒有 opcode 可依靠時（未轉換的 lib）才退回數安靜行數。
        // 門檻放寬到 30：寧可多等，也不要把還在進行的登入判定成結束。
        quiet += 1;
        if (quiet >= 30) {
          done = true;
          onDone();
        }
      }
      return false;
    },
  };
}
