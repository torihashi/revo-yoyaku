/**
 * 鳥はし PWA → 予約カレンダー Webhook
 *
 * PWAからのHTTPリクエストを受けて予約カレンダーにイベントを作成・更新・キャンセル・取得する。
 *
 * 認証:
 *   Script Properties に WEBHOOK_SECRET を設定（プロジェクト設定→スクリプトプロパティ）。
 *   PWA側にも同じ値を持たせて、リクエストごとに送る。
 *
 * デプロイ:
 *   1) このコードを Apps Script の新規プロジェクトに貼る
 *   2) プロジェクト設定 → スクリプトプロパティ で WEBHOOK_SECRET を設定（任意の文字列）
 *   3) testCalendarAccess を実行して権限承認
 *   4) 「デプロイ」→「新しいデプロイ」→「種類：ウェブアプリ」
 *      - 説明: 「PWA Webhook v1」
 *      - 次のユーザーとして実行: 自分
 *      - アクセスできるユーザー: 全員（リンクを知っている誰でも）
 *   5) 公開された URL（https://script.google.com/macros/s/.../exec）をPWAに設定
 */

const CALENDAR_ID = '695af47cf6da3b104909b5fec1302ce60fd325bf6e15c39d3e569e11bd54c24b@group.calendar.google.com';
const CALENDAR_ID_REVOLVERD = 'f93c8580e6556779c5f9d7beb4bdef5850b0e949c6ff2c360b2afc82ff99b0cb@group.calendar.google.com';
// バイトカレンダー（スタッフシフト用）
const CALENDAR_ID_STAFF_TORIHASHI = 'bd5d30f9d879aa70cd5e59f78917efd8bfa8ef36e2c90a1073fce2e5d73c46bd@group.calendar.google.com';
const CALENDAR_ID_STAFF_REVOLVERD = '7cae9c77e4da51289bc9bad756ed03bdfa8e965102d0da2f79ea165b98455f19@group.calendar.google.com';

// 営業カレンダー（休業日）
const CALENDAR_ID_HOLIDAY_TORIHASHI = 'torihashi221631@gmail.com';
const CALENDAR_ID_HOLIDAY_REVOLVERD = 'b6211efbde482c912c4fe0d71584af7027cea84dcf6d1360f19303e741c55630@group.calendar.google.com';

function getHolidayCalendarIdForStore(store) {
  return store === 'revolverd' ? CALENDAR_ID_HOLIDAY_REVOLVERD : CALENDAR_ID_HOLIDAY_TORIHASHI;
}
function getHolidayCalendarForStore(store) {
  return CalendarApp.getCalendarById(getHolidayCalendarIdForStore(store));
}

// 従業員マスタ（タイムカードv4スプレッドシート）
const TIMECARD_SPREADSHEET_ID = '1YPXSROVmyA-g0KwSa_pPtBbwgqh2Lm46OY3XQp-Y0q4';
// 従業員マスタシート名（実際の名前に合わせる必要があるかも。複数候補を試す）
const STAFF_MASTER_SHEET_CANDIDATES = ['従業員マスタ', '従業員', 'スタッフ', 'マスタ', 'employees'];
// 列マッピング（タイムカードv4 実シートに準拠）
// 従業員マスタ：A=氏名、B=区分、C=グループ（店舗）、D=時給/月給、E=金額…
const STAFF_COL_NAME = 0;   // A列：氏名
const STAFF_COL_STORE = 2;  // C列：グループ（"鳥はし" or "リボルバード"）
const STAFF_COL_LINE_ID = 14;     // O列：LINE_ID（既存）
const STAFF_COL_ADMIN = 15;       // P列：管理者（チェックボックス TRUE/FALSE）
const STAFF_COL_EMAIL = 16;       // Q列：メールアドレス
const STAFF_COL_PWA_ENABLED = 17; // R列：PWA利用可（チェックボックス TRUE/FALSE）
const STAFF_COL_PWA_PIN = 18;     // S列：PIN（6桁数字）

// タイムカードシート（1行=1打刻）
const TIMECARD_SHEET_CANDIDATES = ['タイムカード', 'タイムカードv4', 'timecard', '勤怠'];
// 列マッピング：A=日付、B=グループ（店舗）、C=従業員名、D=打刻種別（出勤/退勤）、E=時刻
const TC_COL_DATE = 0;       // A列：日付
const TC_COL_STORE = 1;      // B列：グループ（店舗）
const TC_COL_NAME = 2;       // C列：従業員名
const TC_COL_TYPE = 3;       // D列：打刻種別（"出勤" / "退勤"）
const TC_COL_TIME = 4;       // E列：時刻

// 店舗→予約カレンダーID マッピング
function getCalendarIdForStore(store) {
  return store === 'revolverd' ? CALENDAR_ID_REVOLVERD : CALENDAR_ID;
}
function getCalendarForStore(store) {
  return CalendarApp.getCalendarById(getCalendarIdForStore(store));
}
// 店舗→バイトカレンダーID マッピング
function getStaffCalendarIdForStore(store) {
  return store === 'revolverd' ? CALENDAR_ID_STAFF_REVOLVERD : CALENDAR_ID_STAFF_TORIHASHI;
}
function getStaffCalendarForStore(store) {
  return CalendarApp.getCalendarById(getStaffCalendarIdForStore(store));
}

function isTruthyCell_(v) {
  return v === true || v === 'TRUE' || v === '✓' || v === '○' || v === 1
      || String(v).toLowerCase() === 'true';
}

function parseLaborTimeToMinutes_(timeText) {
  let s = String(timeText || '').trim();
  if (!s) return null;
  let addDay = 0;
  if (s.indexOf('翌') === 0) {
    addDay = 24 * 60;
    s = s.replace(/^翌/, '');
  }
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return addDay + parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// ★ Codex (2026-07-07): 深夜時間は 22:00〜翌5:00 を同一基準で集計する。
// ★ Claude (2026-07-08 revised): タイムカードv4側の集計をこちらに合わせる方針に変更。
//   - 深夜時間帯: 22:00〜翌5:00（オリジナル通り）
//   - 休憩控除: 打刻された休憩開始/終了ペアのみ差し引く（自動控除なし）
const NIGHT_START_MIN = 22 * 60;        // 22:00 開始
const NIGHT_END_MIN   = 29 * 60;        // 翌5:00 終了（=29:00）

function calcNightMinutesBetween_(startText, endText) {
  let start = parseLaborTimeToMinutes_(startText);
  let end = parseLaborTimeToMinutes_(endText);
  if (start == null || end == null) return 0;
  if (end <= start) end += 24 * 60;
  let total = 0;
  for (let base = -24 * 60; base <= 48 * 60; base += 24 * 60) {
    const nightStart = base + NIGHT_START_MIN;
    const nightEnd = base + NIGHT_END_MIN;
    const overlap = Math.min(end, nightEnd) - Math.max(start, nightStart);
    if (overlap > 0) total += overlap;
  }
  return total;
}

function isAdminEmail_(email) {
  email = (email || '').toString().toLowerCase().trim();
  if (!email) return false;
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    let sh = null;
    for (let i = 0; i < STAFF_MASTER_SHEET_CANDIDATES.length; i++) {
      sh = ss.getSheetByName(STAFF_MASTER_SHEET_CANDIDATES[i]);
      if (sh) break;
    }
    if (!sh) return false;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return false;
    const range = sh.getRange(2, 1, lastRow - 1, Math.max(STAFF_COL_PWA_PIN + 1, sh.getLastColumn()));
    const data = range.getValues();
    for (let i = 0; i < data.length; i++) {
      const rowEmail = (data[i][STAFF_COL_EMAIL] || '').toString().toLowerCase().trim();
      if (rowEmail === email) return isTruthyCell_(data[i][STAFF_COL_ADMIN]);
    }
  } catch (e) {}
  return false;
}

// ============================================================
// HTTP エンドポイント
// ============================================================

function doGet(e) {
  if (!authenticate(e.parameter)) return jsonResp({ ok: false, error: 'unauthorized' });

  const action = e.parameter.action;
  if (action === 'ping')             return jsonResp({ ok: true, time: new Date().toISOString() });
  if (action === 'authorize')        return authorizeUser(e.parameter);
  if (action === 'verifyStaffPin')   return verifyStaffPin(e.parameter);
  if (action === 'listLogs')         return listActivityLogs(e.parameter);
  if (action === 'list')             return listReservations(e.parameter);
  if (action === 'listStaff')        return listStaffSchedule(e.parameter);
  if (action === 'listStaffMonth')   return listStaffMonth(e.parameter);
  if (action === 'listEmployees')    return listEmployees(e.parameter);
  if (action === 'listTimecard')     return listTimecard(e.parameter);
  if (action === 'listHolidays')     return listHolidays(e.parameter);
  if (action === 'listMonthlyLabor') return listMonthlyLabor(e.parameter);
  if (action === 'listStaffMonthDays') return listStaffMonthDays(e.parameter);
  // ★ Claude (2026-06-22): 商品マスタ取得（タイムカードv4の「商品マスタ」シートから）
  if (action === 'getProducts')      return getProducts(e.parameter);
  // ★ Claude (2026-07-08): 従業員マスタ取得（給料計算用）
  if (action === 'getEmployeeMaster') return getEmployeeMaster(e.parameter);
  return jsonResp({ ok: false, error: 'unknown action' });
}

// ============================================================
// 個人の月別シフト一覧（タイムカードから日別に集計）
// ============================================================
function listStaffMonthDays(p) {
  const store = p.store || 'torihashi';
  const name = (p.name || '').trim();
  const year = parseInt(p.year, 10);
  const month = parseInt(p.month, 10); // 1〜12
  if (!name) return jsonResp({ ok: false, error: 'name required' });
  if (!year || !month) return jsonResp({ ok: false, error: 'year and month required' });

  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    let sheet = null;
    for (let i = 0; i < TIMECARD_SHEET_CANDIDATES.length; i++) {
      sheet = ss.getSheetByName(TIMECARD_SHEET_CANDIDATES[i]);
      if (sheet) break;
    }
    if (!sheet) return jsonResp({ ok: false, error: 'timecard sheet not found' });

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonResp({ ok: true, items: [], store: store, name: name });

    const storeKey = store === 'revolverd' ? 'リボ' : '鳥はし';
    const formatTime = function(v) {
      if (v instanceof Date) {
        return String(v.getHours()).padStart(2,'0') + ':' + String(v.getMinutes()).padStart(2,'0');
      }
      if (v) return String(v).trim();
      return '';
    };

    // 日付ごとの打刻を集める
    const byDate = {}; // dateStr → [{type, time}]
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rawDate = row[TC_COL_DATE];
      if (!(rawDate instanceof Date)) continue;
      if (rawDate.getFullYear() !== year || rawDate.getMonth() + 1 !== month) continue;

      const rawStore = (row[TC_COL_STORE] || '').toString().trim();
      if (rawStore && rawStore.indexOf(storeKey) < 0) continue;

      const rowName = (row[TC_COL_NAME] || '').toString().trim();
      if (rowName !== name) continue;

      const punchType = (row[TC_COL_TYPE] || '').toString().trim();
      const timeStr = formatTime(row[TC_COL_TIME]);
      if (!timeStr) continue;

      const type = punchType.indexOf('出') >= 0 ? '出'
                 : punchType.indexOf('退') >= 0 ? '退'
                 : '?';
      const dateStr = rawDate.getFullYear() + '-' + String(rawDate.getMonth()+1).padStart(2,'0') + '-' + String(rawDate.getDate()).padStart(2,'0');
      if (!byDate[dateStr]) byDate[dateStr] = [];
      byDate[dateStr].push({ type: type, time: timeStr });
    }

    // 日付ごとにセグメント化＋時間集計（タイムカード実打刻）
    const toMin = function(t) {
      const m = t.split(':');
      return parseInt(m[0]) * 60 + parseInt(m[1]);
    };
    // 翌日に「退」のみがある場合、前日の未閉鎖「出」と結合（日跨ぎ営業の対応）
    // 朝6時(06:00)以前の「退」を「前日の退勤」として扱う閾値
    const NEXT_DAY_RETIRE_THRESHOLD_HOUR = 3;
    const sortedDates = Object.keys(byDate).sort();
    for (let i = 0; i < sortedDates.length; i++) {
      const cur = sortedDates[i];
      const punches = byDate[cur];
      if (!punches || punches.length === 0) continue;
      const sorted = punches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
      // 当日の先頭が「退」かつ朝早い時刻なら、前日の最後の「出」と結合
      const firstP = sorted[0];
      if (firstP.type === '退' && parseInt(firstP.time.split(':')[0]) < NEXT_DAY_RETIRE_THRESHOLD_HOUR) {
        // 前日を探す（直近の日付）
        const curDate = new Date(cur + 'T00:00:00');
        const prevDate = new Date(curDate.getTime() - 24 * 60 * 60 * 1000);
        const prevStr = prevDate.getFullYear() + '-' + String(prevDate.getMonth()+1).padStart(2,'0') + '-' + String(prevDate.getDate()).padStart(2,'0');
        const prevPunches = byDate[prevStr];
        if (prevPunches && prevPunches.length > 0) {
          const prevSorted = prevPunches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
          const lastPrev = prevSorted[prevSorted.length - 1];
          if (lastPrev.type === '出') {
            // 前日に「翌日退」マーカーを追加（時刻は +24h 換算）
            const h = parseInt(firstP.time.split(':')[0]);
            const m = parseInt(firstP.time.split(':')[1]);
            const overTime = String(h + 24).padStart(2,'0') + ':' + String(m).padStart(2,'0');
            byDate[prevStr].push({ type: '退', time: overTime, overnight: true });
            // 当日の先頭の「退」を取り除く
            byDate[cur] = sorted.slice(1);
          }
        }
      }
    }

    const itemsMap = {}; // dateStr → item
    Object.keys(byDate).forEach(function(dateStr) {
      const punches = byDate[dateStr];
      if (!punches || punches.length === 0) return;
      const sorted = punches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
      const segments = [];
      let openStart = null;
      let totalMin = 0;
      let nightMin = 0;
      sorted.forEach(function(p) {
        if (p.type === '出') {
          if (openStart) segments.push({ start: openStart, end: '' });
          openStart = p.time;
        } else if (p.type === '退') {
          if (openStart) {
            // 翌日退勤の場合は時刻が >24h 換算なので分計算は変わらない（toMin が 24h+ も処理可能）
            const diff = toMin(p.time) - toMin(openStart);
            if (diff > 0) totalMin += diff;
            nightMin += calcNightMinutesBetween_(openStart, p.time);
            // 表示用の終了時刻：翌日退勤なら24を引いて元に戻す（02:00 など）
            let endTime = p.time;
            if (p.overnight) {
              const h = parseInt(p.time.split(':')[0]);
              const m = parseInt(p.time.split(':')[1]);
              endTime = '翌' + String(h - 24).padStart(2,'0') + ':' + String(m).padStart(2,'0');
            }
            segments.push({ start: openStart, end: endTime });
            openStart = null;
          } else {
            segments.push({ start: '', end: p.time });
          }
        }
      });
      if (openStart) segments.push({ start: openStart, end: '' });
      itemsMap[dateStr] = { date: dateStr, segments: segments, totalMinutes: totalMin, nightMinutes: nightMin, source: 'timecard' };
    });

    // ★ バイトカレンダー（シフト予定）からも当月分を取得 → 未来のシフトも表示
    try {
      const cal = getStaffCalendarForStore(store);
      if (cal) {
        const monthStart = new Date(year, month - 1, 1, 0, 0, 0);
        const monthEnd   = new Date(year, month, 1, 0, 0, 0);
        const events = cal.getEvents(monthStart, monthEnd);
        events.forEach(function(ev) {
          const title = ev.getTitle() || '';
          // タイトルが本人名の場合のみ拾う。
          // 出勤不可・公休は「勤務予定」ではないため個別詳細には出さない。
          if (title.indexOf('❌') >= 0 || title.indexOf('不可') >= 0
              || title.indexOf('🏖') >= 0 || title.indexOf('公休') >= 0) return;
          if (title.indexOf(name) < 0) return;

          const evStart = ev.getStartTime();
          const evEnd   = ev.getEndTime();
          const dateStr = evStart.getFullYear() + '-'
                       + String(evStart.getMonth() + 1).padStart(2,'0') + '-'
                       + String(evStart.getDate()).padStart(2,'0');
          const startStr = String(evStart.getHours()).padStart(2,'0') + ':' + String(evStart.getMinutes()).padStart(2,'0');
          const endStr   = String(evEnd.getHours()).padStart(2,'0') + ':' + String(evEnd.getMinutes()).padStart(2,'0');
          const diffMin  = Math.max(0, Math.round((evEnd.getTime() - evStart.getTime()) / 60000));
          const nightMin = calcNightMinutesBetween_(startStr, endStr);

          if (!itemsMap[dateStr]) {
            // 未来 or 未打刻の予定 → 予定として追加
            itemsMap[dateStr] = {
              date: dateStr,
              segments: [{ start: startStr, end: endStr }],
              totalMinutes: diffMin,
              nightMinutes: nightMin,
              source: 'calendar'  // 予定（実打刻なし）
            };
          } else {
            // 既に実打刻あり：予定としてフラグ追加（実打刻優先）
            itemsMap[dateStr].planned = { start: startStr, end: endStr };
          }
        });
      }
    } catch (e) {
      // カレンダー取得失敗してもタイムカード分は返す
    }

    const items = Object.keys(itemsMap).sort().map(function(k) { return itemsMap[k]; });
    return jsonResp({ ok: true, items: items, store: store, name: name, year: year, month: month });
  } catch (e) {
    return jsonResp({ ok: false, error: 'spreadsheet error: ' + e.message });
  }
}

// ============================================================
// 月間労働集計（店舗・年月単位）
// 出勤日数と総勤務時間（分）を従業員別に集計
// ============================================================
function listMonthlyLabor(p) {
  const store = p.store || 'torihashi';
  const year = parseInt(p.year, 10);
  const month = parseInt(p.month, 10); // 1〜12
  if (!year || !month) return jsonResp({ ok: false, error: 'year and month required' });

  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    let sheet = null;
    for (let i = 0; i < TIMECARD_SHEET_CANDIDATES.length; i++) {
      sheet = ss.getSheetByName(TIMECARD_SHEET_CANDIDATES[i]);
      if (sheet) break;
    }
    if (!sheet) return jsonResp({ ok: false, error: 'timecard sheet not found' });

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonResp({ ok: true, items: [], store: store, year: year, month: month });

    const storeKey = store === 'revolverd' ? 'リボ' : '鳥はし';
    const formatTime = function(v) {
      if (v instanceof Date) {
        return String(v.getHours()).padStart(2,'0') + ':' + String(v.getMinutes()).padStart(2,'0');
      }
      if (v) return String(v).trim();
      return '';
    };

    // 「名前 → 日付 → [打刻]」のネスト
    const byPerson = {}; // name → { date → punches[] }
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rawDate = row[TC_COL_DATE];
      if (!(rawDate instanceof Date)) continue;
      if (rawDate.getFullYear() !== year || rawDate.getMonth() + 1 !== month) continue;

      const rawStore = (row[TC_COL_STORE] || '').toString().trim();
      if (rawStore && rawStore.indexOf(storeKey) < 0) continue;

      const name = (row[TC_COL_NAME] || '').toString().trim();
      if (!name) continue;

      const punchType = (row[TC_COL_TYPE] || '').toString().trim();
      const timeStr = formatTime(row[TC_COL_TIME]);
      if (!timeStr) continue;

      const type = punchType.indexOf('出') >= 0 ? '出'
                 : punchType.indexOf('退') >= 0 ? '退'
                 : '?';
      const dateStr = rawDate.getFullYear() + '-' + String(rawDate.getMonth()+1).padStart(2,'0') + '-' + String(rawDate.getDate()).padStart(2,'0');

      if (!byPerson[name]) byPerson[name] = {};
      if (!byPerson[name][dateStr]) byPerson[name][dateStr] = [];
      byPerson[name][dateStr].push({ type: type, time: timeStr });
    }

    // 集計
    const toMin = function(t) {
      const m = t.split(':');
      return parseInt(m[0]) * 60 + parseInt(m[1]);
    };
    // 日跨ぎ退勤の処理：各従業員ごとに、翌日早朝（<06:00）の「退」のみを前日に移動
    const NEXT_DAY_RETIRE_THRESHOLD_HOUR = 3;
    Object.keys(byPerson).forEach(function(name) {
      const days = byPerson[name];
      const sortedDates = Object.keys(days).sort();
      for (let i = 0; i < sortedDates.length; i++) {
        const cur = sortedDates[i];
        const punches = days[cur];
        if (!punches || punches.length === 0) continue;
        const sorted = punches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
        const firstP = sorted[0];
        if (firstP.type === '退' && parseInt(firstP.time.split(':')[0]) < NEXT_DAY_RETIRE_THRESHOLD_HOUR) {
          const curDate = new Date(cur + 'T00:00:00');
          const prevDate = new Date(curDate.getTime() - 24 * 60 * 60 * 1000);
          const prevStr = prevDate.getFullYear() + '-' + String(prevDate.getMonth()+1).padStart(2,'0') + '-' + String(prevDate.getDate()).padStart(2,'0');
          const prevPunches = days[prevStr];
          if (prevPunches && prevPunches.length > 0) {
            const prevSorted = prevPunches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
            const lastPrev = prevSorted[prevSorted.length - 1];
            if (lastPrev.type === '出') {
              // 前日に「翌日退勤（+24h換算）」を追加
              const h = parseInt(firstP.time.split(':')[0]);
              const m = parseInt(firstP.time.split(':')[1]);
              const overTime = String(h + 24).padStart(2,'0') + ':' + String(m).padStart(2,'0');
              days[prevStr].push({ type: '退', time: overTime });
              days[cur] = sorted.slice(1);
            }
          }
        }
      }
    });

    const items = [];
    Object.keys(byPerson).forEach(function(name) {
      const days = byPerson[name];
      let workDays = 0;
      let totalMinutes = 0;
      let nightMinutes = 0;
      Object.keys(days).forEach(function(dateStr) {
        const punches = days[dateStr];
        if (!punches || punches.length === 0) return;
        const sorted = punches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
        let openStart = null;
        let breakStart = null;
        let dayMinutes = 0;
        let dayNightMinutes = 0;
        // ★ Claude (2026-07-08): 打刻された休憩は差し引く（自動控除はしない）。
        //   打刻種別: '出'=出勤 / '退'=退勤 / '休入'=休憩開始 / '休戻'=休憩終了
        //   休憩が打刻されていない日は休憩時間ゼロ扱い。
        sorted.forEach(function(p) {
          if (p.type === '出') {
            openStart = p.time;
          } else if (p.type === '退') {
            if (openStart) {
              const diff = toMin(p.time) - toMin(openStart);
              if (diff > 0) dayMinutes += diff;
              dayNightMinutes += calcNightMinutesBetween_(openStart, p.time);
              openStart = null;
            }
          } else if (p.type === '休入') {
            breakStart = p.time;
          } else if (p.type === '休戻') {
            if (breakStart) {
              const breakMin = toMin(p.time) - toMin(breakStart);
              if (breakMin > 0) {
                dayMinutes -= breakMin;
                // 深夜時間帯にかかる休憩はそこからも差し引く
                dayNightMinutes -= calcNightMinutesBetween_(breakStart, p.time);
              }
              breakStart = null;
            }
          }
        });
        if (dayMinutes > 0 || sorted.length > 0) workDays++;
        totalMinutes += dayMinutes;
        nightMinutes += dayNightMinutes;
      });
      items.push({ name: name, workDays: workDays, totalMinutes: totalMinutes, nightMinutes: nightMinutes });
    });

    items.sort(function(a, b) { return b.totalMinutes - a.totalMinutes; });
    return jsonResp({ ok: true, items: items, store: store, year: year, month: month });
  } catch (e) {
    return jsonResp({ ok: false, error: 'spreadsheet error: ' + e.message });
  }
}

// ============================================================
// 営業カレンダーから休業日を取得（店舗別）
// ============================================================
function listHolidays(p) {
  const store = p.store || 'torihashi';
  const cal = getHolidayCalendarForStore(store);
  if (!cal) return jsonResp({ ok: false, error: 'holiday calendar not found for store=' + store });

  // 過去1年〜未来1年（年末年始や過去確認も含めて広めに）
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setFullYear(end.getFullYear() + 1);

  const events = cal.getEvents(start, end);
  const items = [];

  const fmtDate = function(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  };

  events.forEach(function(ev) {
    const title = ev.getTitle() || 'お休み';
    let kind = '休業';
    if (title.indexOf('特別') >= 0) kind = '特別';
    else if (title.indexOf('年末') >= 0 || title.indexOf('大晦日') >= 0) kind = '年末';
    else if (title.indexOf('定休') >= 0 || title.indexOf('お休み') >= 0) kind = '定休';

    // ★ 複数日にまたがる終日イベントは各日に展開する
    const isAllDay = (typeof ev.isAllDayEvent === 'function') ? ev.isAllDayEvent() : false;
    if (isAllDay) {
      const startD = ev.getAllDayStartDate();
      const endD = ev.getAllDayEndDate(); // 排他的（最終日の翌0時）
      const cur = new Date(startD.getTime());
      while (cur < endD) {
        items.push({ date: fmtDate(cur), reason: title, kind: kind });
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      // 時刻指定イベント（複数日に跨る場合もありうる）
      const startD = ev.getStartTime();
      const endD = ev.getEndTime();
      const cur = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate());
      const stop = new Date(endD.getFullYear(), endD.getMonth(), endD.getDate());
      // 同日内なら 1回、跨ぐ場合は跨いだ最終日まで
      while (cur <= stop) {
        items.push({ date: fmtDate(cur), reason: title, kind: kind });
        cur.setDate(cur.getDate() + 1);
      }
    }
  });

  // 同じ日付の重複（複数の休業イベントが同日にある場合）はまとめる
  const dedup = {};
  items.forEach(function(it) {
    if (!dedup[it.date]) dedup[it.date] = it;
    else if (dedup[it.date].reason !== it.reason) {
      dedup[it.date] = { date: it.date, reason: dedup[it.date].reason + '/' + it.reason, kind: dedup[it.date].kind };
    }
  });
  const result = Object.keys(dedup).sort().map(function(d) { return dedup[d]; });

  return jsonResp({ ok: true, items: result, store: store });
}

// バイトカレンダーからシフトを取得（時間・名前のリスト）
function listStaffSchedule(p) {
  const store = p.store || 'torihashi';
  const cal = getStaffCalendarForStore(store);
  if (!cal) return jsonResp({ ok: false, error: 'staff calendar not found for store=' + store });

  // 指定日（または当日）から1日分のシフトを取得
  const dayStr = p.date;
  const start = dayStr ? new Date(dayStr + 'T00:00:00+09:00') : new Date();
  if (!dayStr) {
    start.setHours(0, 0, 0, 0);
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const events = cal.getEvents(start, end);
  const items = events.map(function(ev) {
    return {
      id: ev.getId(),
      name: ev.getTitle(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString()
    };
  });
  // 開始時刻順にソート
  items.sort(function(a, b) { return a.start.localeCompare(b.start); });
  return jsonResp({ ok: true, items: items, store: store, date: dayStr || start.toISOString().slice(0, 10) });
}

// ============================================================
// 従業員マスタ取得（タイムカードv4スプレッドシート）
// ============================================================
function listEmployees(p) {
  const store = p.store || 'torihashi';
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    // シート名候補のいずれかを探す
    let sheet = null;
    for (let i = 0; i < STAFF_MASTER_SHEET_CANDIDATES.length; i++) {
      sheet = ss.getSheetByName(STAFF_MASTER_SHEET_CANDIDATES[i]);
      if (sheet) break;
    }
    if (!sheet) {
      // 最初のシートをフォールバック
      sheet = ss.getSheets()[0];
    }
    if (!sheet) return jsonResp({ ok: false, error: 'staff master sheet not found' });

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonResp({ ok: true, items: [], store: store, sheet: sheet.getName() });

    // ヘッダ行スキップ、空白名は除外、店舗フィルタ
    // グループ列の値：「鳥はし」「リボルバード」「管理者」 + 任意
    const storeKey = store === 'revolverd' ? 'リボ' : '鳥はし';
    const items = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const name = (row[STAFF_COL_NAME] || '').toString().trim();
      if (!name) continue;
      const groupFlag = (row[STAFF_COL_STORE] || '').toString().trim();
      // 管理者チェックがTRUEなら両店舗共通として両方に出す。それ以外は店舗キーを含むか判定
      const isAdmin = isTruthyCell_(row[STAFF_COL_ADMIN]);
      const matched = isAdmin || groupFlag.indexOf(storeKey) >= 0;
      if (matched) items.push({ name: name, store: groupFlag });
    }
    return jsonResp({ ok: true, items: items, store: store, sheet: sheet.getName() });
  } catch (e) {
    return jsonResp({ ok: false, error: 'spreadsheet error: ' + e.message });
  }
}

// ============================================================
// タイムカード取得（出退勤実績）
// 1行=1打刻 を集計：同日同名の打刻を時系列でセグメント化
// 中抜け対応：「出勤→退勤→出勤→退勤」の複数セグメントを保持
// ============================================================
function listTimecard(p) {
  const store = p.store || 'torihashi';
  const targetDate = p.date; // YYYY-MM-DD
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    let sheet = null;
    for (let i = 0; i < TIMECARD_SHEET_CANDIDATES.length; i++) {
      sheet = ss.getSheetByName(TIMECARD_SHEET_CANDIDATES[i]);
      if (sheet) break;
    }
    if (!sheet) return jsonResp({ ok: false, error: 'timecard sheet not found' });

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonResp({ ok: true, items: [], store: store, sheet: sheet.getName() });

    const storeKey = store === 'revolverd' ? 'リボ' : '鳥はし';
    const formatTime = function(v) {
      if (v instanceof Date) {
        return String(v.getHours()).padStart(2,'0') + ':' + String(v.getMinutes()).padStart(2,'0');
      }
      if (v) return String(v).trim();
      return '';
    };

    // 翌日早朝（06:00 まで）の「退」を前日として扱う閾値
    const NEXT_DAY_RETIRE_THRESHOLD_HOUR = 3;
    // 翌日の日付文字列
    let nextDateStr = '';
    if (targetDate) {
      const d = new Date(targetDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      nextDateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }

    // 1) 該当日・該当店舗の打刻を全て収集（順序保持）+ 翌日の早朝「退」も取り込む
    const byPerson = {}; // key = name → punch[]
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rawDate = row[TC_COL_DATE];
      let rowDateStr = '';
      if (rawDate instanceof Date) {
        rowDateStr = rawDate.getFullYear() + '-' + String(rawDate.getMonth()+1).padStart(2,'0') + '-' + String(rawDate.getDate()).padStart(2,'0');
      } else if (rawDate) {
        rowDateStr = String(rawDate).trim();
      }
      const isToday = targetDate && rowDateStr === targetDate;
      const isTomorrow = targetDate && rowDateStr === nextDateStr;
      if (targetDate && !isToday && !isTomorrow) continue;

      const rawStore = (row[TC_COL_STORE] || '').toString().trim();
      if (rawStore && rawStore.indexOf(storeKey) < 0) continue;

      const name = (row[TC_COL_NAME] || '').toString().trim();
      if (!name) continue;

      const punchType = (row[TC_COL_TYPE] || '').toString().trim();
      const timeStr = formatTime(row[TC_COL_TIME]);
      if (!timeStr) continue;

      const type = punchType.indexOf('出') >= 0 ? '出'
                 : punchType.indexOf('退') >= 0 ? '退'
                 : '?';

      // 翌日の早朝「退」のみを前日扱いで取り込む（その他の翌日打刻は無視）
      if (isTomorrow) {
        if (type !== '退') continue;
        const hour = parseInt(timeStr.split(':')[0]);
        if (isNaN(hour) || hour >= NEXT_DAY_RETIRE_THRESHOLD_HOUR) continue;
        // 24時間加算で前日と同列にソート可能にする
        const m = parseInt(timeStr.split(':')[1]);
        const overTime = String(hour + 24).padStart(2,'0') + ':' + String(m).padStart(2,'0');
        if (!byPerson[name]) byPerson[name] = { date: targetDate, store: rawStore, punches: [] };
        byPerson[name].punches.push({ type: '退', time: overTime, overnight: true, displayTime: timeStr });
        continue;
      }

      if (!byPerson[name]) byPerson[name] = { date: rowDateStr, store: rawStore, punches: [] };
      byPerson[name].punches.push({ type: type, time: timeStr });
    }

    // 2) 人ごとに時系列ソートして、出勤→退勤 でセグメント化
    const items = [];
    Object.keys(byPerson).forEach(function(name) {
      const rec = byPerson[name];
      rec.punches.sort(function(a, b) { return a.time.localeCompare(b.time); });
      const segments = [];
      let openStart = null;
      rec.punches.forEach(function(p) {
        if (p.type === '出') {
          if (openStart) {
            segments.push({ start: openStart, end: '' });
          }
          openStart = p.time;
        } else if (p.type === '退') {
          // 翌日退勤の場合は表示時刻を「翌HH:MM」形式に変換
          const displayEnd = p.overnight && p.displayTime ? ('翌' + p.displayTime) : p.time;
          if (openStart) {
            segments.push({ start: openStart, end: displayEnd });
            openStart = null;
          } else {
            segments.push({ start: '', end: displayEnd });
          }
        }
      });
      // 最後に出勤しっぱなし（勤務中）
      if (openStart) {
        segments.push({ start: openStart, end: '' });
      }

      // 表示用：最初の start を sortKey に
      const firstStart = segments[0] && segments[0].start ? segments[0].start : (segments[0] && segments[0].end ? segments[0].end : '');
      items.push({
        date: rec.date,
        name: name,
        store: rec.store,
        segments: segments,
        // 互換性のため最早startと最遅endも残す
        startTime: firstStart,
        endTime: (segments[segments.length - 1] && segments[segments.length - 1].end) || ''
      });
    });

    items.sort(function(a, b) { return (a.startTime || '').localeCompare(b.startTime || ''); });
    return jsonResp({ ok: true, items: items, store: store, sheet: sheet.getName(), date: targetDate });
  } catch (e) {
    return jsonResp({ ok: false, error: 'spreadsheet error: ' + e.message });
  }
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResp({ ok: false, error: 'invalid JSON' });
  }

  if (!authenticate(data)) return jsonResp({ ok: false, error: 'unauthorized' });

  const action = data.action;
  if (action === 'create')           return createReservation(data);
  if (action === 'update')           return updateReservation(data);
  if (action === 'cancel')           return cancelReservation(data);
  if (action === 'restore')          return restoreReservation(data);
  if (action === 'updateSeat')       return updateSeat(data);
  if (action === 'createTakeout')    return createTakeout(data);
  if (action === 'createStaffShift') return createStaffShift(data);
  if (action === 'updateStaffShift') return updateStaffShift(data);
  if (action === 'deleteStaffShift') return deleteStaffShift(data);
  if (action === 'logAction')        return logActivity(data);
  // ★ Claude (2026-07-08): Discord通知テスト送信（管理者用）
  if (action === 'discordTest')      return discordTest_(data);
  // ★ Claude (2026-07-08): 給料明細を給料明細履歴シートに追記
  if (action === 'submitPaySlip')    return submitPaySlip(data);
  return jsonResp({ ok: false, error: 'unknown action' });
}

function authenticate(obj) {
  const expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!expected) return false;
  return obj && obj.secret === expected;
}

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 認証：メールアドレスで従業員マスタを照合
// ============================================================
function authorizeUser(p) {
  const email = (p.email || '').toString().toLowerCase().trim();
  const pin   = (p.pin   || '').toString().trim();
  if (!email) return jsonResp({ ok: false, error: 'email required' });
  if (!pin)   return jsonResp({ ok: false, error: 'pin required' });

  let sh = null;
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    for (const name of STAFF_MASTER_SHEET_CANDIDATES) {
      const s = ss.getSheetByName(name);
      if (s) { sh = s; break; }
    }
  } catch (e) {
    return jsonResp({ ok: false, error: 'sheet open failed: ' + e.message });
  }
  if (!sh) return jsonResp({ ok: false, error: 'master sheet not found' });

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return jsonResp({ ok: false, error: 'empty master' });

  // ヘッダー行をスキップして1行目から検索
  const range = sh.getRange(2, 1, lastRow - 1, Math.max(STAFF_COL_PWA_PIN + 1, sh.getLastColumn()));
  const data = range.getValues();

  let emailMatched = false;
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowEmail = (row[STAFF_COL_EMAIL] || '').toString().toLowerCase().trim();
    if (!rowEmail || rowEmail !== email) continue;
    emailMatched = true;

    const enabledVal = row[STAFF_COL_PWA_ENABLED];
    const isEnabled = isTruthyCell_(enabledVal);
    if (!isEnabled) return jsonResp({ ok: false, error: 'disabled' });

    // PIN照合（数字化して比較）
    const rawPin = row[STAFF_COL_PWA_PIN];
    const rowPin = (typeof rawPin === 'number' ? String(rawPin) : String(rawPin || '')).replace(/[^0-9]/g, '');
    const inputPin = pin.replace(/[^0-9]/g, '');
    if (!rowPin) return jsonResp({ ok: false, error: 'pin not set' });
    if (rowPin !== inputPin) return jsonResp({ ok: false, error: 'wrong pin' });

    const name  = (row[STAFF_COL_NAME]  || '').toString().trim();
    const group = (row[STAFF_COL_STORE] || '').toString().trim();
    const isAdmin = isTruthyCell_(row[STAFF_COL_ADMIN]);
    return jsonResp({
      ok: true,
      name: name,
      group: group,
      isAdmin: isAdmin,
      email: email,
      defaultStore: isAdmin ? 'torihashi'
                  : (group === 'リボルバード' ? 'revolverd' : 'torihashi')
    });
  }
  return jsonResp({ ok: false, error: emailMatched ? 'wrong pin' : 'notfound' });
}

// ============================================================
// 月間スタッフカレンダー：日付ごとに出勤/不可スタッフを集約
// ============================================================
function listStaffMonth(p) {
  const store = p.store || 'torihashi';
  const year = parseInt(p.year, 10);
  const month = parseInt(p.month, 10); // 1〜12
  if (!year || !month) return jsonResp({ ok: false, error: 'year and month required' });

  const cal = getStaffCalendarForStore(store);
  if (!cal) return jsonResp({ ok: false, error: 'staff calendar not found for store=' + store });

  const monthStart = new Date(year, month - 1, 1, 0, 0, 0);
  const monthEnd   = new Date(year, month, 1, 0, 0, 0);
  const events = cal.getEvents(monthStart, monthEnd);

  // byDate: { 'YYYY-MM-DD': [{name, type: 'work'|'unav', reason}, ...] }
  const byDate = {};
  events.forEach(function(ev) {
    const title = (ev.getTitle() || '').trim();
    if (!title) return;
    const start = ev.getStartTime();
    const dateStr = start.getFullYear() + '-'
                 + String(start.getMonth() + 1).padStart(2,'0') + '-'
                 + String(start.getDate()).padStart(2,'0');

    let type = 'work';
    let name = title;
    let reason = '';

    if (title.indexOf('❌') === 0) {
      type = 'unav';
      const rest = title.substring(1).trim();
      const m = rest.match(/^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/);
      if (m) {
        name = m[1].trim();
        reason = m[2].trim();
      } else {
        name = rest;
      }
    } else if (title.indexOf('🏖') === 0) {
      type = 'kou';
      // 🏖はサロゲートペア(2コードユニット)なので substring(2) で除去
      const rest = title.replace(/^🏖\s*/, '').trim();
      const m = rest.match(/^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/);
      if (m) {
        name = m[1].trim();
      } else {
        name = rest;
      }
    }
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push({
      id: ev.getId(),
      name: name,
      type: type,
      reason: reason,
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString()
    });
  });

  return jsonResp({ ok: true, byDate: byDate, year: year, month: month, store: store });
}

// ============================================================
// スタッフPIN照合（氏名+PIN → 個別シフト詳細表示用ゲート）
// ============================================================
function verifyStaffPin(p) {
  const name = (p.name || '').toString().trim();
  const pin = (p.pin || '').toString().trim().replace(/[^0-9]/g, '');
  if (!name) return jsonResp({ ok: false, error: 'name required' });
  if (!pin)  return jsonResp({ ok: false, error: 'pin required' });

  let sh = null;
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    for (const sname of STAFF_MASTER_SHEET_CANDIDATES) {
      const s = ss.getSheetByName(sname);
      if (s) { sh = s; break; }
    }
  } catch (e) {
    return jsonResp({ ok: false, error: 'sheet open failed: ' + e.message });
  }
  if (!sh) return jsonResp({ ok: false, error: 'master sheet not found' });

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return jsonResp({ ok: false, error: 'empty master' });
  const range = sh.getRange(2, 1, lastRow - 1, Math.max(STAFF_COL_PWA_PIN + 1, sh.getLastColumn()));
  const data = range.getValues();

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowName = (row[STAFF_COL_NAME] || '').toString().trim();
    if (!rowName) continue;
    // 完全一致 or 空白除去後一致
    if (rowName === name || rowName.replace(/\s+/g, '') === name.replace(/\s+/g, '')) {
      const rawPin = row[STAFF_COL_PWA_PIN];
      const rowPin = (typeof rawPin === 'number' ? String(rawPin) : String(rawPin || '')).replace(/[^0-9]/g, '');
      if (!rowPin) return jsonResp({ ok: false, error: 'pin not set' });
      if (rowPin !== pin) return jsonResp({ ok: false, error: 'wrong pin' });
      return jsonResp({ ok: true, name: rowName });
    }
  }
  return jsonResp({ ok: false, error: 'notfound' });
}

// ============================================================
// アクティビティログ
// ============================================================
const LOG_SHEET_NAME = 'アクティビティログ';
const LOG_HEADERS = ['タイムスタンプ', '操作者', '店舗', 'アクション', '対象', '詳細'];

function getOrCreateLogSheet() {
  const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
  let sh = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET_NAME);
    sh.appendRow(LOG_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold').setBackground('#fff8e1');
    sh.setColumnWidth(1, 160);
    sh.setColumnWidth(2, 100);
    sh.setColumnWidth(3, 90);
    sh.setColumnWidth(4, 120);
    sh.setColumnWidth(5, 200);
    sh.setColumnWidth(6, 300);
  }
  return sh;
}

function logActivity(d) {
  try {
    const sh = getOrCreateLogSheet();
    // PWA側からは actionName で送る（action はGASディスパッチ用のため）
    const actName = d.actionName || d.act || d.action || '';
    sh.appendRow([
      new Date(),
      (d.user || 'unknown').toString().substring(0, 40),
      (d.store || '').toString().substring(0, 30),
      actName.toString().substring(0, 60),
      (d.target || '').toString().substring(0, 200),
      (d.detail || '').toString().substring(0, 500)
    ]);
    return jsonResp({ ok: true });
  } catch (e) {
    return jsonResp({ ok: false, error: e.message });
  }
}

function listActivityLogs(p) {
  const days = Math.max(1, Math.min(30, parseInt(p.days || '4')));
  try {
    const sh = getOrCreateLogSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return jsonResp({ ok: true, items: [] });
    // 末尾から最大2000行をスキャン（4日分なら通常十分）
    const scanRows = Math.min(2000, lastRow - 1);
    const startRow = lastRow - scanRows + 1;
    const data = sh.getRange(startRow, 1, scanRows, 6).getValues();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const items = [];
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      const ts = row[0];
      if (!(ts instanceof Date)) continue;
      if (ts < cutoff) break;
      items.push({
        timestamp: ts.toISOString(),
        user: row[1],
        store: row[2],
        action: row[3],
        target: row[4],
        detail: row[5]
      });
      if (items.length >= 500) break;
    }
    return jsonResp({ ok: true, items: items, days: days });
  } catch (e) {
    return jsonResp({ ok: false, error: e.message });
  }
}

// ============================================================
// 一覧取得（PWA起動時のデータ同期）
// ============================================================

function listReservations(p) {
  const store = p.store || 'torihashi';
  const cal = getCalendarForStore(store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + store });

  const start = p.start ? new Date(p.start) : new Date();
  const end   = p.end   ? new Date(p.end)   : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  const events = cal.getEvents(start, end);
  const items = events.map(function(ev) {
    return {
      id: ev.getId(),
      title: ev.getTitle(),
      description: ev.getDescription() || '',
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      store: store
    };
  });
  return jsonResp({ ok: true, items: items, store: store });
}

// ============================================================
// 通常予約 作成
// ============================================================

function createReservation(d) {
  const cal = getCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + d.store });

  const start = new Date(d.start);
  const end   = new Date(d.end);
  const opts = { description: d.description || '' };
  const event = cal.createEvent(d.title, start, end, opts);
  if (d.colorId) event.setColor(d.colorId);
  // ★ Claude (2026-07-08): Discord通知（予約作成）
  try {
    notifyDiscord_(d.store || 'torihashi', 'reservation', {
      title: '🎉 新規予約',
      color: 0x2E7D32,
      eventTitle: d.title,
      description: d.description,
      start: start
    });
  } catch (e) { /* 通知失敗はメイン処理に影響させない */ }
  return jsonResp({ ok: true, eventId: event.getId(), store: d.store || 'torihashi' });
}

// ============================================================
// お土産予約 作成
// ============================================================

function createTakeout(d) {
  const cal = getCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + d.store });

  const start = new Date(d.start);
  const end   = new Date(d.end);
  const event = cal.createEvent(d.title, start, end, {
    description: d.description || ''
  });
  // お土産はオレンジ系（colorId=6 タンジェリン）
  event.setColor(d.colorId || '6');
  // ★ Claude (2026-07-08): Discord通知（お土産予約）
  try {
    notifyDiscord_(d.store || 'torihashi', 'reservation', {
      title: '🥡 お土産予約',
      color: 0xEF6C00,
      eventTitle: d.title,
      description: d.description,
      start: start
    });
  } catch (e) {}
  return jsonResp({ ok: true, eventId: event.getId(), store: d.store || 'torihashi' });
}

// ============================================================
// 予約更新（タイトル・説明・時刻）
// ============================================================

function updateReservation(d) {
  const cal = getCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + d.store });
  const event = cal.getEventById(d.eventId);
  if (!event) return jsonResp({ ok: false, error: 'event not found' });

  if (d.title) event.setTitle(d.title);
  if (d.description) event.setDescription(d.description);
  if (d.start && d.end) event.setTime(new Date(d.start), new Date(d.end));
  // ★ Claude (2026-07-08): Discord通知（予約変更）
  try {
    notifyDiscord_(d.store || 'torihashi', 'reservation', {
      title: '✏️ 予約変更',
      color: 0x1976D2,
      eventTitle: d.title || event.getTitle(),
      description: d.description || event.getDescription(),
      start: d.start ? new Date(d.start) : event.getStartTime()
    });
  } catch (e) {}
  return jsonResp({ ok: true });
}

// ============================================================
// 席変更（タイトル末尾の席を差し替え）
// ============================================================

function updateSeat(d) {
  const cal = getCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + d.store });
  const event = cal.getEventById(d.eventId);
  if (!event) return jsonResp({ ok: false, error: 'event not found' });

  const oldTitle = event.getTitle();
  // タイトル末尾「、…」を新席に差し替え
  const newTitle = oldTitle.replace(/、[^、]*$/, '') + '、' + d.newSeat;
  event.setTitle(newTitle);

  // 説明欄の「席:」行も更新
  let desc = event.getDescription() || '';
  if (/席[:：]/.test(desc)) {
    desc = desc.replace(/席[：:]\s*[^\n\r]+/, '席: ' + d.newSeat);
    event.setDescription(desc);
  }
  return jsonResp({ ok: true, title: newTitle });
}

// ============================================================
// キャンセル（タイトルにキャンセルマーク追加）
// ============================================================

function cancelReservation(d) {
  const cal = getCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + d.store });
  const event = cal.getEventById(d.eventId);
  if (!event) return jsonResp({ ok: false, error: 'event not found' });

  const oldTitle = event.getTitle();
  if (oldTitle.indexOf('[キャンセル]') < 0) {
    event.setTitle('[キャンセル] ' + oldTitle);
    event.setColor('8'); // グラファイト（灰）
    // ★ Claude (2026-07-08): Discord通知（予約キャンセル）
    try {
      notifyDiscord_(d.store || 'torihashi', 'reservation', {
        title: '❌ 予約キャンセル',
        color: 0xC62828,
        eventTitle: oldTitle,
        description: event.getDescription(),
        start: event.getStartTime()
      });
    } catch (e) {}
  }
  return jsonResp({ ok: true });
}

// ============================================================
// 復元（[キャンセル]マークを外して元に戻す）
// ============================================================

function restoreReservation(d) {
  const cal = getCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'calendar not found for store=' + d.store });
  const event = cal.getEventById(d.eventId);
  if (!event) return jsonResp({ ok: false, error: 'event not found' });

  const oldTitle = event.getTitle();
  const newTitle = oldTitle.replace(/^\[キャンセル\]\s*/, '');
  event.setTitle(newTitle);

  // 色を元に戻す（お土産=オレンジ系、それ以外=デフォルト）
  // 🥡 で始まればお土産（colorId=6 タンジェリン）、それ以外はデフォルト色に
  if (newTitle.indexOf('🥡') === 0) {
    event.setColor('6');
  } else {
    event.setColor(CalendarApp.EventColor.DEFAULT);
  }
  return jsonResp({ ok: true, title: newTitle });
}

// ============================================================
// スタッフシフト登録（バイトカレンダーへ書込）
// ============================================================
function createStaffShift(d) {
  const cal = getStaffCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'staff calendar not found for store=' + d.store });

  if (!d.name) return jsonResp({ ok: false, error: 'name required' });
  if (!d.start || !d.end) return jsonResp({ ok: false, error: 'start and end required' });

  const start = new Date(d.start);
  const end = new Date(d.end);
  const event = cal.createEvent(d.name, start, end, {
    description: d.description || ('PWAから追加：' + d.name)
  });
  // ★ Claude (2026-07-08): Discord通知（シフト追加）
  try {
    notifyDiscord_(d.store || 'torihashi', 'shift', {
      title: '📅 シフト追加',
      color: 0x2E7D32,
      staffName: d.name,
      start: start,
      end: end
    });
  } catch (e) {}
  return jsonResp({ ok: true, eventId: event.getId(), store: d.store || 'torihashi' });
}

// ============================================================
// スタッフシフト更新（イベントIDで日付・時刻・種別を変更）
// ============================================================
function updateStaffShift(d) {
  const cal = getStaffCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'staff calendar not found for store=' + d.store });
  if (!isAdminEmail_(d.userEmail)) return jsonResp({ ok: false, error: 'admin required' });
  if (!d.eventId) return jsonResp({ ok: false, error: 'eventId required' });
  if (!d.name) return jsonResp({ ok: false, error: 'name required' });
  if (!d.start || !d.end) return jsonResp({ ok: false, error: 'start and end required' });

  try {
    const event = cal.getEventById(d.eventId);
    if (!event) return jsonResp({ ok: false, error: 'event not found' });
    event.setTitle(d.name);
    event.setTime(new Date(d.start), new Date(d.end));
    if (d.description !== undefined) {
      event.setDescription(d.description || ('PWAから更新：' + d.name));
    }
    // ★ Claude (2026-07-08): Discord通知（シフト変更）
    try {
      notifyDiscord_(d.store || 'torihashi', 'shift', {
        title: '✏️ シフト変更',
        color: 0x1976D2,
        staffName: d.name,
        start: new Date(d.start),
        end: new Date(d.end)
      });
    } catch (e) {}
    return jsonResp({ ok: true, eventId: event.getId(), store: d.store || 'torihashi' });
  } catch (e) {
    return jsonResp({ ok: false, error: e.message });
  }
}

// ============================================================
// シフト削除（イベントIDで指定）
// ============================================================
function deleteStaffShift(d) {
  const cal = getStaffCalendarForStore(d.store);
  if (!cal) return jsonResp({ ok: false, error: 'staff calendar not found for store=' + d.store });
  if (!isAdminEmail_(d.userEmail)) return jsonResp({ ok: false, error: 'admin required' });
  if (!d.eventId) return jsonResp({ ok: false, error: 'eventId required' });
  try {
    const event = cal.getEventById(d.eventId);
    if (!event) return jsonResp({ ok: false, error: 'event not found' });
    // ★ Claude (2026-07-08): 削除前に情報を保存してDiscord通知
    const staffName = event.getTitle();
    const startTime = event.getStartTime();
    const endTime = event.getEndTime();
    event.deleteEvent();
    try {
      notifyDiscord_(d.store || 'torihashi', 'shift', {
        title: '🗑 シフト削除',
        color: 0xC62828,
        staffName: staffName,
        start: startTime,
        end: endTime
      });
    } catch (e) {}
    return jsonResp({ ok: true });
  } catch (e) {
    return jsonResp({ ok: false, error: e.message });
  }
}

// ============================================================
// 従業員マスタ移行：P列に「管理者」チェック欄を追加
//   GASエディタから一度だけ手動実行してください。
//   既にP列が「管理者」なら何もしません。
// ============================================================
function setupStaffMasterAdminColumn() {
  const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
  let sh = null;
  for (let i = 0; i < STAFF_MASTER_SHEET_CANDIDATES.length; i++) {
    sh = ss.getSheetByName(STAFF_MASTER_SHEET_CANDIDATES[i]);
    if (sh) break;
  }
  if (!sh) throw new Error('staff master sheet not found');

  const pCol = STAFF_COL_ADMIN + 1; // 1-based P列
  const currentHeader = (sh.getRange(1, pCol).getValue() || '').toString().trim();
  if (currentHeader === '管理者' || currentHeader.indexOf('管理者') >= 0) {
    Logger.log('P列は既に管理者チェック欄です。処理なし。');
    return;
  }

  sh.insertColumnBefore(pCol);
  sh.getRange(1, pCol).setValue('管理者');
  sh.getRange(1, pCol).setFontWeight('bold').setBackground('#fff8e1');
  const lastRow = Math.max(2, sh.getLastRow());
  sh.getRange(2, pCol, lastRow - 1, 1).insertCheckboxes();
  sh.setColumnWidth(pCol, 80);
  Logger.log('P列に管理者チェック欄を追加しました。旧P列以降はQ列以降へ移動済みです。');
}

// ============================================================
// テスト・デバッグ用
// ============================================================

// 従業員マスタ取得テスト
function testListEmployees_tori() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'listEmployees', secret: secret, store: 'torihashi' } });
  const data = JSON.parse(res.getContent());
  Logger.log('鳥はし従業員: ' + (data.items ? data.items.length : 0) + ' 名');
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) data.items.forEach(function(s) { Logger.log('  - ' + s.name + ' (店舗:' + s.store + ')'); });
}
function testListEmployees_revo() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'listEmployees', secret: secret, store: 'revolverd' } });
  const data = JSON.parse(res.getContent());
  Logger.log('リボ従業員: ' + (data.items ? data.items.length : 0) + ' 名');
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) data.items.forEach(function(s) { Logger.log('  - ' + s.name + ' (店舗:' + s.store + ')'); });
}

// 月間労働集計テスト
function testListMonthlyLabor_tori() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const today = new Date();
  const res = doGet({ parameter: {
    action: 'listMonthlyLabor', secret: secret,
    store: 'torihashi', year: today.getFullYear(), month: today.getMonth() + 1
  }});
  const data = JSON.parse(res.getContent());
  Logger.log('鳥はし ' + data.year + '/' + data.month + ' 集計：');
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) data.items.forEach(function(it) {
    const h = Math.floor(it.totalMinutes / 60);
    const m = it.totalMinutes % 60;
    Logger.log('  ' + it.name + '：' + it.workDays + '日 / ' + h + '時間' + m + '分');
  });
}

// 休業日取得テスト
function testListHolidays_tori() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'listHolidays', secret: secret, store: 'torihashi' } });
  const data = JSON.parse(res.getContent());
  Logger.log('鳥はし休業日 件数: ' + (data.items ? data.items.length : 0));
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) data.items.slice(0, 10).forEach(function(h) {
    Logger.log('  ' + h.date + ' [' + h.kind + '] ' + h.reason);
  });
}
function testListHolidays_revo() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'listHolidays', secret: secret, store: 'revolverd' } });
  const data = JSON.parse(res.getContent());
  Logger.log('リボ休業日 件数: ' + (data.items ? data.items.length : 0));
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) data.items.slice(0, 10).forEach(function(h) {
    Logger.log('  ' + h.date + ' [' + h.kind + '] ' + h.reason);
  });
}

// タイムカード取得テスト（今日分）
function testListTimecard_tori() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  const res = doGet({ parameter: { action: 'listTimecard', secret: secret, store: 'torihashi', date: dateStr } });
  const data = JSON.parse(res.getContent());
  Logger.log('タイムカード ' + dateStr + ' 件数: ' + (data.items ? data.items.length : 0));
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) data.items.forEach(function(t) {
    Logger.log('  ' + t.name + ' ' + t.startTime + '〜' + t.endTime + ' (' + t.store + ')');
  });
}

// 従業員マスタ・タイムカードのヘッダと先頭3行をダンプ（列構造確認用）
function debugDumpSheetStructure() {
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    ['従業員マスタ', 'タイムカード'].forEach(function(name) {
      const sh = ss.getSheetByName(name);
      if (!sh) { Logger.log('シート「' + name + '」が見つかりません'); return; }
      Logger.log('=== ' + name + ' (' + sh.getLastRow() + '行 × ' + sh.getLastColumn() + '列) ===');
      const data = sh.getRange(1, 1, Math.min(5, sh.getLastRow()), sh.getLastColumn()).getValues();
      data.forEach(function(row, idx) {
        const label = idx === 0 ? '[ヘッダ]' : '[行' + (idx + 1) + ']';
        const cells = row.map(function(v, ci) {
          const col = String.fromCharCode(65 + ci);
          return col + ':「' + v + '」';
        }).join(' / ');
        Logger.log(label + ' ' + cells);
      });
      Logger.log('');
    });
  } catch (e) {
    Logger.log('エラー: ' + e.message);
  }
}

// スプレッドシートのシート名一覧（デバッグ用）
function debugListSheets() {
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    Logger.log('スプレッドシート名: ' + ss.getName());
    const sheets = ss.getSheets();
    Logger.log('シート数: ' + sheets.length);
    sheets.forEach(function(s) { Logger.log('  - ' + s.getName() + ' (' + s.getLastRow() + '行)'); });
  } catch (e) {
    Logger.log('エラー: ' + e.message);
  }
}

function testCalendarAccess() {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (cal) {
    Logger.log('✓ Calendar OK: ' + cal.getName());
  } else {
    Logger.log('❌ Calendar not found');
  }
}

function testSecret() {
  const s = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  Logger.log(s ? '✓ WEBHOOK_SECRET configured (length=' + s.length + ')' : '❌ WEBHOOK_SECRET not set');
}

// ============================================================
// GASエディタから手動でテストするためのラッパー
//   ※ doGet / doPost は直接 [▶ 実行] してはいけません（e が undefined になります）
//   ※ 代わりにこの関数を選んで実行してください
// ============================================================

function testDoGet_ping() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'ping', secret: secret } });
  Logger.log(res.getContent());
}

function testDoGet_list() {
  // 鳥はしのカレンダーから直近90日の予約を取得
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'list', secret: secret, store: 'torihashi' } });
  const data = JSON.parse(res.getContent());
  Logger.log('鳥はし取得件数: ' + (data.items ? data.items.length : 0));
  if (data.items && data.items.length > 0) {
    Logger.log('最初の3件:');
    data.items.slice(0, 3).forEach(function(it) {
      Logger.log('  - ' + it.title + ' (' + it.start + ')');
    });
  }
}

function testDoGet_listRevo() {
  // リボルバードのカレンダーから直近90日の予約を取得
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const res = doGet({ parameter: { action: 'list', secret: secret, store: 'revolverd' } });
  const data = JSON.parse(res.getContent());
  Logger.log('リボ取得件数: ' + (data.items ? data.items.length : 0) + ' / store=' + data.store);
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items && data.items.length > 0) {
    Logger.log('最初の3件:');
    data.items.slice(0, 3).forEach(function(it) {
      Logger.log('  - ' + it.title + ' (' + it.start + ')');
    });
  }
}

// バイトカレンダーアクセス確認
function testStaffCalendarAccess() {
  const cal1 = CalendarApp.getCalendarById(CALENDAR_ID_STAFF_TORIHASHI);
  Logger.log(cal1 ? '✓ 鳥はしバイト OK: ' + cal1.getName() : '❌ 鳥はしバイト not found');
  const cal2 = CalendarApp.getCalendarById(CALENDAR_ID_STAFF_REVOLVERD);
  Logger.log(cal2 ? '✓ リボ・バイト OK: ' + cal2.getName() : '❌ リボ・バイト not found');
}

// バイトシフト一覧取得テスト（今日）
function testDoGet_listStaffToday_tori() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  const res = doGet({ parameter: { action: 'listStaff', secret: secret, store: 'torihashi', date: dateStr } });
  const data = JSON.parse(res.getContent());
  Logger.log('鳥はしバイト ' + dateStr + ' 件数: ' + (data.items ? data.items.length : 0));
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) {
    data.items.forEach(function(s) {
      Logger.log('  ' + s.start + ' ' + s.name);
    });
  }
}

function testDoGet_listStaffToday_revo() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  const res = doGet({ parameter: { action: 'listStaff', secret: secret, store: 'revolverd', date: dateStr } });
  const data = JSON.parse(res.getContent());
  Logger.log('リボバイト ' + dateStr + ' 件数: ' + (data.items ? data.items.length : 0));
  if (data.error) Logger.log('エラー: ' + data.error);
  if (data.items) {
    data.items.forEach(function(s) {
      Logger.log('  ' + s.start + ' ' + s.name);
    });
  }
}

function testRevoCalendarAccess() {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID_REVOLVERD);
  if (cal) {
    Logger.log('✓ Revo Calendar OK: ' + cal.getName());
  } else {
    Logger.log('❌ Revo Calendar not found（カレンダーIDか権限が違うかも）');
  }
}

// GAS実行アカウントで見えている全カレンダーを一覧表示（デバッグ用）
function debugListAllCalendars() {
  const cals = CalendarApp.getAllCalendars();
  Logger.log('実行アカウント: ' + Session.getEffectiveUser().getEmail());
  Logger.log('アクセス可能なカレンダー総数: ' + cals.length);
  Logger.log('--- 一覧 ---');
  cals.forEach(function(c) {
    Logger.log('・[' + c.getName() + ']  id=' + c.getId());
  });
}

// リボのカレンダーへテスト予約を入れる（疎通＋ルーティング確認）
function testDoPost_createRevo() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const body = {
    secret: secret,
    action: 'create',
    store: 'revolverd',  // ← ここがリボ
    title: '⚪ テスト・リボ予約、2名、テストリボ様、R1+R2',
    description: 'GASエディタからのリボテスト',
    start: new Date().toISOString(),
    end:   new Date(Date.now() + 2 * 3600 * 1000).toISOString()
  };
  const fakeEvent = { postData: { contents: JSON.stringify(body), type: 'application/json' } };
  const res = doPost(fakeEvent);
  Logger.log('レスポンス: ' + res.getContent());
  Logger.log('→ 「リボ・予約」カレンダーを開いて確認してください');
}

function testDoPost_create() {
  // ダミーの予約作成リクエストを送る
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const body = {
    secret: secret,
    action: 'create',
    title: '⚪ テスト予約、2名、テスト様、当日決定',
    description: 'GASエディタからのテスト',
    start: new Date().toISOString(),
    end:   new Date(Date.now() + 2 * 3600 * 1000).toISOString()
  };
  const fakeEvent = {
    postData: { contents: JSON.stringify(body), type: 'application/json' }
  };
  const res = doPost(fakeEvent);
  Logger.log(res.getContent());
}

// ============================================================
// ★ Claude (2026-06-22): 商品マスタ取得 API
// ----------------------------------------------------------------
// タイムカードv4 スプレッドシートの「商品マスタ」シートを読み取り、
// JSON で返す。予約管理PWA、ホームページ、お客様注文サイトなど
// 全てがこのAPIから商品データを取得することで「単一の真実」を実現。
//
// 使い方:
//   GET ?action=getProducts&secret=XXX
//   GET ?action=getProducts&secret=XXX&store=torihashi  ← 店舗絞り込み
//   GET ?action=getProducts&secret=XXX&includeInactive=1 ← 非アクティブも含む
//
// シート構造（1行目=英語キー、2行目=日本語説明、3行目以降=データ）:
//   id, store, category, name, price, options, sortOrder, active,
//   customPrice, customMemo, note
//
// キャッシュ: CacheService で 1時間保持。価格変更時は最大1時間反映遅延。
// 即時反映したい時は clearProductsCache() を実行。
// ============================================================
const PRODUCT_SHEET_NAME = '商品マスタ';
const PRODUCT_CACHE_KEY_PREFIX = 'products_v1_';
const PRODUCT_CACHE_TTL_SEC = 3600; // 1時間

function getProducts(p) {
  try {
    const store = (p && p.store) ? String(p.store) : '';
    const includeInactive = !!(p && (p.includeInactive === '1' || p.includeInactive === 'true'));
    const cacheKey = PRODUCT_CACHE_KEY_PREFIX + (store || 'all') + (includeInactive ? '_all' : '');

    // キャッシュ確認
    const cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    if (cached) {
      try {
        return jsonResp({ ok: true, products: JSON.parse(cached), cached: true });
      } catch (e) { /* fallthrough to fresh fetch */ }
    }

    // タイムカードv4 を開いて 商品マスタ シートを取得
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(PRODUCT_SHEET_NAME);
    if (!sheet) {
      return jsonResp({ ok: false, error: 'sheet not found: ' + PRODUCT_SHEET_NAME });
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length < 3) {
      // ヘッダー2行 + データ0行 のケース
      return jsonResp({ ok: true, products: [] });
    }

    // 1行目: 英語キー（id, store, category, ...）
    const headers = values[0].map(function(h) { return String(h || '').trim(); });
    // 2行目: 日本語説明（スキップ）
    // 3行目以降: データ
    const products = [];
    for (let r = 2; r < values.length; r++) {
      const row = values[r];
      // 全列空のスキップ
      const allEmpty = row.every(function(v) { return v === '' || v == null; });
      if (allEmpty) continue;

      const obj = {};
      headers.forEach(function(key, idx) {
        if (!key) return;
        obj[key] = row[idx];
      });

      // 必須フィールドのバリデーション
      if (!obj.id || !obj.name) continue;

      // 型整形
      obj.id        = String(obj.id).trim();
      obj.store     = String(obj.store || '').trim();
      obj.category  = String(obj.category || '').trim();
      obj.name      = String(obj.name).trim();
      obj.price     = parseInt(obj.price, 10) || 0;
      // options: "塩,タレ" → ["塩","タレ"] / 空欄 → []
      const optRaw = String(obj.options || '').trim();
      obj.options   = optRaw ? optRaw.split(/[,、]/).map(function(s) { return s.trim(); }).filter(Boolean) : [];
      obj.sortOrder = parseInt(obj.sortOrder, 10) || 99;
      obj.active      = _parseBool(obj.active);
      obj.customPrice = _parseBool(obj.customPrice);
      obj.customMemo  = _parseBool(obj.customMemo);
      obj.note      = String(obj.note || '').trim();

      // フィルタ: 非アクティブを除外（includeInactive=1 のとき以外）
      if (!includeInactive && obj.active === false) continue;
      // フィルタ: 店舗指定があれば一致のみ
      if (store && obj.store !== store) continue;

      products.push(obj);
    }

    // sortOrder で昇順、同値は id で安定化
    products.sort(function(a, b) {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return String(a.id).localeCompare(String(b.id));
    });

    // キャッシュ保存（JSON 文字列の容量制限 100KB 以下なら）
    try {
      const payload = JSON.stringify(products);
      if (payload.length < 100 * 1024) {
        cache.put(cacheKey, payload, PRODUCT_CACHE_TTL_SEC);
      }
    } catch (e) { /* キャッシュ失敗は無視 */ }

    return jsonResp({ ok: true, products: products, cached: false });
  } catch (err) {
    return jsonResp({ ok: false, error: 'getProducts failed: ' + (err && err.message ? err.message : String(err)) });
  }
}

// TRUE/FALSE / true/false / 1/0 / Boolean → 真偽値
function _parseBool(v) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (s === 'TRUE' || s === '1' || s === 'YES') return true;
  if (s === 'FALSE' || s === '0' || s === 'NO' || s === '') return false;
  return false;
}

// 商品マスタのキャッシュを強制クリア（スプレッドシート編集後すぐ反映させたい時に実行）
function clearProductsCache() {
  const cache = CacheService.getScriptCache();
  // 想定される全キーを掃除
  const keys = [
    PRODUCT_CACHE_KEY_PREFIX + 'all',
    PRODUCT_CACHE_KEY_PREFIX + 'all_all',
    PRODUCT_CACHE_KEY_PREFIX + 'torihashi',
    PRODUCT_CACHE_KEY_PREFIX + 'torihashi_all',
    PRODUCT_CACHE_KEY_PREFIX + 'revolverd',
    PRODUCT_CACHE_KEY_PREFIX + 'revolverd_all'
  ];
  cache.removeAll(keys);
  Logger.log('Products cache cleared: ' + keys.join(', '));
}

// GAS エディタでテスト用：商品マスタを取得して内容を確認
function testGetProducts() {
  const res = getProducts({ store: 'torihashi' });
  Logger.log(res.getContent());
}

// ============================================================
// ★ Claude (2026-07-08): Discord 通知機能
// ----------------------------------------------------------------
// 予約作成/変更/キャンセル・シフト追加/変更/削除時に、
// Discord チャンネルへ Webhook 経由で自動通知を送信する。
//
// 設定方法（Discord サーバー構築後）:
//   Apps Script エディタ → プロジェクトの設定 → スクリプトプロパティ
//   以下の 4 つのプロパティを追加:
//     DISCORD_WEBHOOK_TORI_RES    ← 鳥はし・予約通知チャンネルのWebhook URL
//     DISCORD_WEBHOOK_TORI_SHIFT  ← 鳥はし・シフト通知チャンネル
//     DISCORD_WEBHOOK_REVO_RES    ← リボルバード・予約通知チャンネル
//     DISCORD_WEBHOOK_REVO_SHIFT  ← リボルバード・シフト通知チャンネル
//
// 通知の停止:
//   スクリプトプロパティのURL値を空にすれば該当チャンネルの通知は停止。
// ============================================================

// ★ Claude (2026-07-08): Discord メンション用ユーザーID を取得する
//   スクリプトプロパティ DISCORD_STAFF_MENTIONS に JSON で保存されている:
//     { "山田太郎": "123456789012345678", "田中花子": "987654321098765432" }
//   マッチロジック:
//     1. 完全一致（"山田太郎"）
//     2. 空白を除去して完全一致（"山田 太郎" → "山田太郎"）
//     3. 姓のみで先頭一致（"山田" で始まる名前があるか）
//   見つからなければ空文字（メンションなし）
function getDiscordUserIdForStaff_(staffName) {
  if (!staffName) return '';
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('DISCORD_STAFF_MENTIONS');
    if (!raw) return '';
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object') return '';
    // ノーマライズヘルパー
    const norm = function(s) { return String(s || '').replace(/\s+/g, '').trim(); };
    const target = norm(staffName);
    // 1. 完全一致
    if (map[staffName]) return String(map[staffName]);
    // 2. 空白除去一致
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
      if (norm(keys[i]) === target) return String(map[keys[i]]);
    }
    // 3. 姓の先頭一致（"山田" が "山田太郎" にマッチ）
    for (let i = 0; i < keys.length; i++) {
      const kn = norm(keys[i]);
      if (kn.indexOf(target) === 0 || target.indexOf(kn) === 0) {
        return String(map[keys[i]]);
      }
    }
    return '';
  } catch (e) {
    Logger.log('getDiscordUserIdForStaff_ error: ' + e.message);
    return '';
  }
}

// Discord Webhook URL 取得（store: 'torihashi' or 'revolverd'、kind: 'reservation' or 'shift'）
// ★ Claude (2026-07-08): 「Discord URLの体裁」でないものは無効扱い。
//   GASのScriptPropertiesは空値保存不可のため、通知を無効化したい場合は
//   値に「1」「OFF」「DISABLED」等の任意文字列を入れておけばOK（通知をスキップする）。
function getDiscordWebhookUrl_(store, kind) {
  const props = PropertiesService.getScriptProperties();
  let key;
  if (store === 'revolverd') {
    key = (kind === 'shift') ? 'DISCORD_WEBHOOK_REVO_SHIFT' : 'DISCORD_WEBHOOK_REVO_RES';
  } else {
    key = (kind === 'shift') ? 'DISCORD_WEBHOOK_TORI_SHIFT' : 'DISCORD_WEBHOOK_TORI_RES';
  }
  const raw = props.getProperty(key) || '';
  // Discord Webhook URLの形式（https://discord.com/api/webhooks/... または https://discordapp.com/api/webhooks/...）でなければ無効扱い
  const trimmed = String(raw).trim();
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//i.test(trimmed)) {
    return ''; // 無効なURL/プレースホルダは通知スキップ
  }
  return trimmed;
}

// Discord Webhook にメッセージを送信（embed形式）
// embed: { title, color, description, fields[], footer, timestamp }
// content: 本文テキスト（<@ユーザーID> でメンション可能）
// ★ Claude (2026-07-08): content 引数追加。allowed_mentions で users のみ許可し @everyone 誤爆を防ぐ。
function sendDiscordEmbed_(webhookUrl, embed, content) {
  if (!webhookUrl) return { ok: false, error: 'webhook url not set' };
  try {
    const payload = {
      embeds: [embed],
      // メンション制御: 明示的にユーザーメンションだけ許可（@everyone/@here を誤送信で発火させない）
      allowed_mentions: { parse: ['users'] }
    };
    if (content) payload.content = String(content);
    const resp = UrlFetchApp.fetch(webhookUrl, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    return { ok: code >= 200 && code < 300, code: code, body: resp.getContentText() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 予約・シフト等の内容から Discord Embed を組み立てて送信
// kind: 'reservation' | 'shift'
// data: { title, color, eventTitle, description, start, end, staffName }
function notifyDiscord_(store, kind, data) {
  const url = getDiscordWebhookUrl_(store, kind);
  if (!url) return; // URL未設定なら無効化
  const storeLabel = (store === 'revolverd') ? '🥃 リボルバード' : '🐔 鳥はし';
  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  let dateStr = '';
  if (data.start instanceof Date && !isNaN(data.start.getTime())) {
    dateStr = Utilities.formatDate(data.start, tz, 'yyyy年M月d日(E) HH:mm');
  }

  const fields = [];
  if (kind === 'shift') {
    // シフト系: 従業員名 + 時刻
    if (data.staffName) fields.push({ name: '👤 従業員', value: String(data.staffName), inline: true });
    if (dateStr) {
      let timeRange = dateStr;
      if (data.end instanceof Date && !isNaN(data.end.getTime())) {
        const endStr = Utilities.formatDate(data.end, tz, 'HH:mm');
        timeRange += '〜' + endStr;
      }
      fields.push({ name: '🕐 時刻', value: timeRange, inline: false });
    }
  } else {
    // 予約系: タイトルと description の主要行を Embed のフィールドに整形
    if (dateStr) fields.push({ name: '📅 日時', value: dateStr, inline: false });
    if (data.eventTitle) fields.push({ name: '📋 タイトル', value: String(data.eventTitle), inline: false });
    // description から主要情報を抜き出して表示（人数・席・電話・特記）
    if (data.description) {
      const lines = String(data.description).split('\n');
      const keep = [];
      const wantedKeys = ['人数', '席', '電話', 'コース', '特記', '要望', 'お名前', '合計', '点数'];
      lines.forEach(function(line) {
        for (let i = 0; i < wantedKeys.length; i++) {
          if (line.indexOf(wantedKeys[i]) === 0 || line.indexOf(wantedKeys[i] + ':') === 0 || line.indexOf(wantedKeys[i] + ':') === 0) {
            keep.push(line.trim());
            break;
          }
        }
      });
      if (keep.length > 0) {
        // Discord embed の 1フィールド上限 1024文字を考慮して切り詰め
        const desc = keep.join('\n');
        fields.push({ name: '📝 内容', value: desc.length > 1000 ? desc.substring(0, 1000) + '...' : desc, inline: false });
      }
    }
  }

  const embed = {
    title: data.title || '通知',
    color: data.color || 0x808080,
    fields: fields,
    footer: { text: storeLabel },
    timestamp: new Date().toISOString()
  };
  // ★ Claude (2026-07-08): シフト通知の場合は対象スタッフの Discord ユーザーIDでメンション
  //   Discord は content フィールドに `<@ID>` を含めるとメンション扱い（通知が強調される）
  //   embed 内の文字は装飾されず、content の @メンションだけが通知される仕様。
  let content = '';
  if (kind === 'shift' && data.staffName) {
    const uid = getDiscordUserIdForStaff_(data.staffName);
    if (uid) {
      content = '<@' + uid + '>';
    }
  }
  sendDiscordEmbed_(url, embed, content);
}

// 管理者用テスト送信（PWA から呼ばれる）
// d: { store, kind }
function discordTest_(d) {
  const store = (d && d.store === 'revolverd') ? 'revolverd' : 'torihashi';
  const kind = (d && d.kind === 'shift') ? 'shift' : 'reservation';
  const url = getDiscordWebhookUrl_(store, kind);
  if (!url) {
    return jsonResp({ ok: false, error: 'Webhook URL 未設定: ' + store + '/' + kind });
  }
  const res = sendDiscordEmbed_(url, {
    title: '✅ 接続テスト',
    color: 0x66BB6A,
    description: 'Discord Webhook 接続確認\n店舗: ' + (store === 'revolverd' ? '🥃 リボルバード' : '🐔 鳥はし')
                 + '\nチャンネル: ' + (kind === 'shift' ? 'シフト通知' : '予約通知'),
    footer: { text: 'テスト送信 by PWA' },
    timestamp: new Date().toISOString()
  });
  return jsonResp({ ok: !!res.ok, code: res.code, error: res.error });
}

// GAS エディタから直接テスト実行用
function testDiscordNotifyReservation() {
  notifyDiscord_('torihashi', 'reservation', {
    title: '🎉 新規予約 (テスト)',
    color: 0x2E7D32,
    eventTitle: '5500円飲み放題、4名、テスト様、1+2',
    description: '予約ID: TEST-001\n人数: 4名（中学生以上 4 / 小学生 0 / 幼児 0）\n席: 1+2\n電話: 090-1234-5678\n特記: テスト送信',
    start: new Date()
  });
  Logger.log('Discord notification sent (or webhook not set).');
}
function testDiscordNotifyShift() {
  const start = new Date();
  const end = new Date(start.getTime() + 4 * 3600 * 1000);
  notifyDiscord_('revolverd', 'shift', {
    title: '📅 シフト追加 (テスト)',
    color: 0x2E7D32,
    staffName: 'テスト太郎',
    start: start,
    end: end
  });
  Logger.log('Discord shift notification sent (or webhook not set).');
}

// ★ Claude (2026-07-08): 労働時間集計の詳細診断（タイムカードv4との突合用）
//   使い方: GAS エディタで store, year, month, targetName を書き換えて実行。
//   実行ログに、対象スタッフの日別打刻・計算結果・全月合計・深夜時間の内訳が出力される。
//   これをタイムカードv4 の同スタッフの月別集計と突き合わせるとズレの原因が特定できる。
function debugLaborForStaff() {
  // ↓↓↓ ここを書き換えてから実行 ↓↓↓
  const store = 'revolverd';   // 'torihashi' or 'revolverd'
  const year = 2026;           // 対象年
  const month = 6;             // 対象月（1〜12）
  const targetName = '山田太郎'; // 対象スタッフ名（部分一致OK）
  // ↑↑↑ ここを書き換えてから実行 ↑↑↑

  const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
  let sheet = null;
  for (let i = 0; i < TIMECARD_SHEET_CANDIDATES.length; i++) {
    sheet = ss.getSheetByName(TIMECARD_SHEET_CANDIDATES[i]);
    if (sheet) break;
  }
  if (!sheet) { Logger.log('❌ タイムカードシートが見つかりません'); return; }

  const data = sheet.getDataRange().getValues();
  const storeKey = store === 'revolverd' ? 'リボ' : '鳥はし';
  const NEXT_DAY_RETIRE_THRESHOLD_HOUR = 3;

  Logger.log('===== 労働時間診断: ' + targetName + ' / ' + year + '年' + month + '月 / ' + store + ' =====');
  Logger.log('シート: ' + sheet.getName() + ' / 総行数: ' + data.length);
  Logger.log('列マッピング: 日付=' + TC_COL_DATE + ' 名前=' + TC_COL_NAME + ' 時刻=' + TC_COL_TIME + ' 種別=' + TC_COL_TYPE + ' 店舗=' + TC_COL_STORE);
  Logger.log('日跨ぎ判定閾値: 翌日 <' + NEXT_DAY_RETIRE_THRESHOLD_HOUR + ':00 の「退」を前日扱い');
  Logger.log('深夜時間帯: ' + Math.floor(NIGHT_START_MIN/60) + ':' + String(NIGHT_START_MIN%60).padStart(2,'0') + '〜翌' + Math.floor((NIGHT_END_MIN-24*60)/60) + ':' + String((NIGHT_END_MIN-24*60)%60).padStart(2,'0'));
  Logger.log('休憩控除: 打刻された休憩のみ差し引く（自動控除なし）');
  Logger.log('');

  // 対象月・対象スタッフ・対象店舗の全打刻を抽出
  const rawPunches = [];
  let skipCount = 0;
  const skipReasons = { date: 0, month: 0, store: 0, name: 0, other: 0 };
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rawDate = row[TC_COL_DATE];
    if (!(rawDate instanceof Date)) { skipReasons.date++; continue; }
    if (rawDate.getFullYear() !== year || rawDate.getMonth() + 1 !== month) { skipReasons.month++; continue; }
    const rawStore = (row[TC_COL_STORE] || '').toString().trim();
    if (rawStore && rawStore.indexOf(storeKey) < 0) { skipReasons.store++; continue; }
    const name = (row[TC_COL_NAME] || '').toString().trim();
    if (!name) { skipReasons.name++; continue; }
    if (name.indexOf(targetName) < 0 && targetName.indexOf(name) < 0) { continue; }

    const rawTime = row[TC_COL_TIME];
    let timeStr = '';
    if (rawTime instanceof Date) {
      timeStr = String(rawTime.getHours()).padStart(2,'0') + ':' + String(rawTime.getMinutes()).padStart(2,'0');
    } else if (rawTime) {
      timeStr = String(rawTime).trim();
    }
    if (!timeStr) { skipReasons.other++; continue; }

    const punchType = (row[TC_COL_TYPE] || '').toString().trim();
    // ★ Claude (2026-07-08): 休憩打刻も認識（休入=休憩開始、休戻=休憩終了）
    const type = punchType.indexOf('出') >= 0 ? '出'
               : punchType.indexOf('退') >= 0 ? '退'
               : (punchType.indexOf('休') >= 0 && (punchType.indexOf('入') >= 0 || punchType.indexOf('開') >= 0)) ? '休入'
               : (punchType.indexOf('休') >= 0 && (punchType.indexOf('戻') >= 0 || punchType.indexOf('終') >= 0 || punchType.indexOf('明け') >= 0)) ? '休戻'
               : '?(' + punchType + ')';
    const dateStr = rawDate.getFullYear() + '-' + String(rawDate.getMonth()+1).padStart(2,'0') + '-' + String(rawDate.getDate()).padStart(2,'0');
    rawPunches.push({ row: i + 1, dateStr: dateStr, name: name, store: rawStore, type: type, time: timeStr, punchTypeRaw: punchType });
  }

  Logger.log('▼ 打刻データ（全' + rawPunches.length + '件） 対象月の生データ:');
  rawPunches.forEach(function(p) {
    Logger.log('  行' + p.row + ' | ' + p.dateStr + ' ' + p.time + ' | ' + p.type + ' (元:「' + p.punchTypeRaw + '」) | 名前:' + p.name + ' | 店舗:「' + p.store + '」');
  });
  Logger.log('');

  // 日別にグルーピング
  const byDate = {};
  rawPunches.forEach(function(p) {
    (byDate[p.dateStr] = byDate[p.dateStr] || []).push({ type: p.type, time: p.time, row: p.row });
  });
  const sortedDates = Object.keys(byDate).sort();

  // 日跨ぎ処理（本体 listMonthlyLabor と同じロジック）
  Logger.log('▼ 日跨ぎ退勤の判定と再配置:');
  for (let i = 0; i < sortedDates.length; i++) {
    const cur = sortedDates[i];
    const punches = byDate[cur];
    if (!punches || punches.length === 0) continue;
    const sorted = punches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
    const firstP = sorted[0];
    if (firstP.type === '退' && parseInt(firstP.time.split(':')[0]) < NEXT_DAY_RETIRE_THRESHOLD_HOUR) {
      const curDate = new Date(cur + 'T00:00:00');
      const prevDate = new Date(curDate.getTime() - 24 * 60 * 60 * 1000);
      const prevStr = prevDate.getFullYear() + '-' + String(prevDate.getMonth()+1).padStart(2,'0') + '-' + String(prevDate.getDate()).padStart(2,'0');
      const prevPunches = byDate[prevStr];
      if (prevPunches && prevPunches.length > 0) {
        const prevSorted = prevPunches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
        const lastPrev = prevSorted[prevSorted.length - 1];
        if (lastPrev.type === '出') {
          const h = parseInt(firstP.time.split(':')[0]);
          const m = parseInt(firstP.time.split(':')[1]);
          const overTime = String(h + 24).padStart(2,'0') + ':' + String(m).padStart(2,'0');
          Logger.log('  ' + cur + ' の 退' + firstP.time + ' → ' + prevStr + ' の 退' + overTime + ' に移動');
          byDate[prevStr].push({ type: '退', time: overTime, row: firstP.row + '(移動)' });
          byDate[cur] = sorted.slice(1);
        }
      }
    }
  }
  Logger.log('');

  // 日別に集計
  const toMin = function(t) { const m = t.split(':'); return parseInt(m[0]) * 60 + parseInt(m[1]); };
  const fmtH = function(min) { const h = Math.floor(min / 60); const m = min % 60; return h + 'h' + String(m).padStart(2,'0'); };
  let totalMinutes = 0;
  let nightMinutes = 0;
  let workDays = 0;
  Logger.log('▼ 日別集計:');
  sortedDates.forEach(function(dateStr) {
    const punches = byDate[dateStr];
    if (!punches || punches.length === 0) return;
    const sorted = punches.slice().sort(function(a, b) { return a.time.localeCompare(b.time); });
    let openStart = null;
    let breakStart = null;
    let dayMinutes = 0;
    let dayNightMinutes = 0;
    const pairs = [];
    const breaks = [];
    sorted.forEach(function(p) {
      if (p.type === '出') {
        openStart = p.time;
      } else if (p.type === '退') {
        if (openStart) {
          const diff = toMin(p.time) - toMin(openStart);
          if (diff > 0) dayMinutes += diff;
          const night = calcNightMinutesBetween_(openStart, p.time);
          dayNightMinutes += night;
          pairs.push({ start: openStart, end: p.time, min: diff, night: night });
          openStart = null;
        } else {
          pairs.push({ start: '(なし)', end: p.time, min: 0, night: 0, note: '出勤なしの退勤' });
        }
      } else if (p.type === '休入') {
        breakStart = p.time;
      } else if (p.type === '休戻') {
        if (breakStart) {
          const breakMin = toMin(p.time) - toMin(breakStart);
          const breakNight = calcNightMinutesBetween_(breakStart, p.time);
          if (breakMin > 0) {
            dayMinutes -= breakMin;
            dayNightMinutes -= breakNight;
          }
          breaks.push({ start: breakStart, end: p.time, min: breakMin, night: breakNight });
          breakStart = null;
        }
      }
    });
    if (openStart) pairs.push({ start: openStart, end: '(なし)', min: 0, night: 0, note: '退勤なしの出勤' });
    if (breakStart) breaks.push({ start: breakStart, end: '(なし)', min: 0, night: 0, note: '休戻なしの休入' });
    if (pairs.length > 0 || breaks.length > 0) {
      Logger.log('  ' + dateStr + ':');
      pairs.forEach(function(pair) {
        Logger.log('    出退: ' + pair.start + '→' + pair.end + ' = ' + fmtH(pair.min) + ' (深夜 ' + fmtH(pair.night) + ')' + (pair.note ? ' ⚠' + pair.note : ''));
      });
      breaks.forEach(function(br) {
        Logger.log('    休憩: ' + br.start + '→' + br.end + ' = -' + fmtH(br.min) + ' (深夜 -' + fmtH(br.night) + ')' + (br.note ? ' ⚠' + br.note : ''));
      });
      Logger.log('    日合計: ' + fmtH(dayMinutes) + ' / 深夜 ' + fmtH(dayNightMinutes));
    }
    if (dayMinutes > 0) workDays++;
    totalMinutes += dayMinutes;
    nightMinutes += dayNightMinutes;
  });

  Logger.log('');
  Logger.log('===== 総合結果 =====');
  Logger.log('  出勤日数: ' + workDays + '日');
  Logger.log('  合計労働時間: ' + fmtH(totalMinutes) + ' (' + totalMinutes + '分)');
  Logger.log('  内 深夜時間: ' + fmtH(nightMinutes) + ' (' + nightMinutes + '分)');
  Logger.log('');
  Logger.log('▼ スキップした行数（対象外・除外理由別）:');
  Logger.log('  日付形式NG: ' + skipReasons.date);
  Logger.log('  対象月以外: ' + skipReasons.month);
  Logger.log('  対象店舗以外: ' + skipReasons.store);
  Logger.log('  名前空欄: ' + skipReasons.name);
  Logger.log('  時刻形式NG: ' + skipReasons.other);
}
function showDiscordMentionsMap() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('DISCORD_STAFF_MENTIONS');
  if (!raw) {
    Logger.log('❌ DISCORD_STAFF_MENTIONS プロパティ未設定');
    Logger.log('スクリプトプロパティに以下の形式で登録してください:');
    Logger.log('  { "山田太郎": "123456789012345678", "田中花子": "..." }');
    return;
  }
  try {
    const map = JSON.parse(raw);
    Logger.log('===== 現在のスタッフメンションマッピング =====');
    Object.keys(map).forEach(function(name) {
      Logger.log('  ' + name + ' → <@' + map[name] + '>');
    });
    Logger.log('合計 ' + Object.keys(map).length + ' 件');
  } catch (e) {
    Logger.log('⚠ JSONパースエラー: ' + e.message);
    Logger.log('生の値: ' + raw);
  }
}

// ★ Claude (2026-07-08): スタッフメンションを1件追加/更新するヘルパー
// 使い方: staffName と userId を書き換えて実行
function addDiscordMention() {
  const staffName = '山田太郎';  // ← ここを実際の名前に書き換え
  const userId = '123456789012345678';  // ← ここを実際の Discord ユーザーID に書き換え

  const props = PropertiesService.getScriptProperties();
  let map = {};
  const raw = props.getProperty('DISCORD_STAFF_MENTIONS');
  if (raw) {
    try { map = JSON.parse(raw) || {}; } catch (e) { map = {}; }
  }
  map[staffName] = String(userId).trim();
  props.setProperty('DISCORD_STAFF_MENTIONS', JSON.stringify(map));
  Logger.log('✓ 追加/更新完了: ' + staffName + ' → ' + userId);
  showDiscordMentionsMap();
}

// ★ Claude (2026-07-08): 詳細診断関数（GASエディタから実行）
//   4つの Webhook URL の状態を全部チェック＋実際に送信テストして結果をログに出す。
//   これで「URL未設定 / 形式NG / Discord側の拒否」等が判別できる。
function diagnoseDiscordAll() {
  const props = PropertiesService.getScriptProperties();
  const keys = [
    'DISCORD_WEBHOOK_TORI_RES',
    'DISCORD_WEBHOOK_TORI_SHIFT',
    'DISCORD_WEBHOOK_REVO_RES',
    'DISCORD_WEBHOOK_REVO_SHIFT'
  ];
  const validPattern = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//i;

  Logger.log('===== Discord Webhook 診断開始 =====');
  keys.forEach(function(key) {
    const raw = props.getProperty(key);
    Logger.log('--- ' + key + ' ---');
    if (!raw) {
      Logger.log('  ❌ プロパティ未設定（またはnull）');
      return;
    }
    const preview = (raw.length > 60) ? raw.substring(0, 40) + '...(全' + raw.length + '文字)' : raw;
    Logger.log('  値: ' + preview);
    if (!validPattern.test(String(raw).trim())) {
      Logger.log('  ⚪ Discord URL形式ではない → 通知スキップされる');
      return;
    }
    // 実際に送信テスト
    Logger.log('  ✓ URL形式OK → テスト送信します...');
    try {
      const resp = UrlFetchApp.fetch(String(raw).trim(), {
        method: 'POST',
        contentType: 'application/json',
        payload: JSON.stringify({
          embeds: [{
            title: '🔍 診断テスト送信',
            description: 'プロパティ名: ' + key + '\n送信元: diagnoseDiscordAll',
            color: 0x9E9E9E,
            timestamp: new Date().toISOString()
          }]
        }),
        muteHttpExceptions: true
      });
      const code = resp.getResponseCode();
      const body = resp.getContentText();
      if (code >= 200 && code < 300) {
        Logger.log('  🎉 送信成功 (HTTP ' + code + ')');
      } else {
        Logger.log('  ⚠ Discord側で拒否 (HTTP ' + code + ')');
        Logger.log('  レスポンス: ' + (body.length > 200 ? body.substring(0, 200) + '...' : body));
      }
    } catch (e) {
      Logger.log('  ❌ 送信例外: ' + e.message);
    }
  });
  Logger.log('===== 診断終了 =====');
}

// ============================================================
// ★ Claude (2026-07-08): 従業員マスタ取得 API
// ----------------------------------------------------------------
// タイムカードv4 の「従業員マスタ」シートから、給料計算に必要な項目を取得。
// アルバイト・特殊アルバイトの判定と、時給・深夜時給を含む。
//
// 使い方:
//   GET ?action=getEmployeeMaster&secret=XXX
//
// レスポンス:
//   { ok: true, items: [{name, section, group, salaryType, hourlyRate, nightHourlyRate}] }
// ============================================================
function getEmployeeMaster(p) {
  try {
    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    const sheet = ss.getSheetByName('従業員マスタ');
    if (!sheet) return jsonResp({ ok: false, error: '「従業員マスタ」シートが見つかりません' });
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonResp({ ok: true, items: [] });
    const items = [];
    for (let i = 1; i < data.length; i++) {
      const name = data[i][0];
      if (!name) continue;
      items.push({
        name: String(name).trim(),
        section: String(data[i][1] || '').trim(),        // B: 部署
        group: String(data[i][2] || '').trim(),           // C: グループ
        salaryType: String(data[i][3] || '').trim(),      // D: 給与形式
        hourlyRate: parseInt(data[i][4], 10) || 0,        // E: 金額（時給）
        nightHourlyRate: parseInt(data[i][7], 10) || 0,   // H: 深夜時給
      });
    }
    return jsonResp({ ok: true, items: items });
  } catch (e) {
    return jsonResp({ ok: false, error: 'getEmployeeMaster error: ' + e.message });
  }
}

// ============================================================
// ★ Claude (2026-07-08): 給料明細 追記 API（管理者専用）
// ----------------------------------------------------------------
// タイムカードv4 の「給料明細履歴」シートに、確定済み給料明細を追記。
// - シートが無ければ自動作成（ヘッダー行付き）
// - 新しい月のデータは 2 行目に挿入（既存データは 1 行下にシフト）
// - すでに同じ年月+従業員名の行がある場合は上書き
//
// 使い方（POST）:
//   { action: 'submitPaySlip', userEmail, yearMonth, employeeName, salaryType,
//     workDays, totalWorkTime, totalHours, nightHours,
//     hourlyRate, nightHourlyRate, basicPay, nightPay, totalGross,
//     incomeTax, residentialTax, employmentInsurance, totalDeduction, netPay, confirmedBy }
// ============================================================
const PAY_SLIP_SHEET_NAME = '給料明細履歴';
const PAY_SLIP_HEADERS = [
  '年月', '従業員名', '給与形式', '出勤日数', '総勤務時間',
  '総時間（小数）', '深夜時間', '時給', '深夜時給',
  '基本給', '深夜手当', '支給合計',
  '所得税', '住民税', '雇用保険', '控除合計', '手取り',
  '確定日時', '確定者'
];

function submitPaySlip(d) {
  try {
    if (!isAdminEmail_(d.userEmail)) {
      return jsonResp({ ok: false, error: '給料確定は管理者のみ実行可能' });
    }
    if (!d.yearMonth || !d.employeeName) {
      return jsonResp({ ok: false, error: 'yearMonth と employeeName は必須' });
    }

    const ss = SpreadsheetApp.openById(TIMECARD_SPREADSHEET_ID);
    let sheet = ss.getSheetByName(PAY_SLIP_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(PAY_SLIP_SHEET_NAME);
      sheet.appendRow(PAY_SLIP_HEADERS);
      // ヘッダー行を強調
      const headerRange = sheet.getRange(1, 1, 1, PAY_SLIP_HEADERS.length);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#e8f5e9');
      sheet.setFrozenRows(1);
    }

    const now = new Date();
    const timestamp = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    const rowData = [
      String(d.yearMonth),
      String(d.employeeName),
      String(d.salaryType || ''),
      parseInt(d.workDays, 10) || 0,
      String(d.totalWorkTime || ''),
      parseFloat(d.totalHours) || 0,
      parseFloat(d.nightHours) || 0,
      parseInt(d.hourlyRate, 10) || 0,
      parseInt(d.nightHourlyRate, 10) || 0,
      Math.round(parseFloat(d.basicPay) || 0),
      Math.round(parseFloat(d.nightPay) || 0),
      Math.round(parseFloat(d.totalGross) || 0),
      Math.round(parseFloat(d.incomeTax) || 0),
      Math.round(parseFloat(d.residentialTax) || 0),
      Math.round(parseFloat(d.employmentInsurance) || 0),
      Math.round(parseFloat(d.totalDeduction) || 0),
      Math.round(parseFloat(d.netPay) || 0),
      timestamp,
      String(d.confirmedBy || '')
    ];

    // 既存の同じ年月+従業員名の行があれば削除（上書き扱い）
    const existing = sheet.getDataRange().getValues();
    for (let i = existing.length - 1; i >= 1; i--) {
      if (String(existing[i][0]) === String(d.yearMonth)
       && String(existing[i][1]) === String(d.employeeName)) {
        sheet.deleteRow(i + 1);
      }
    }

    // 2行目に挿入して新しい月を最上部に
    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, rowData.length).setValues([rowData]);

    return jsonResp({ ok: true, sheetName: PAY_SLIP_SHEET_NAME, message: '給料明細を追記しました' });
  } catch (e) {
    return jsonResp({ ok: false, error: 'submitPaySlip error: ' + e.message });
  }
}

// GAS エディタから直接テスト実行用
function testSubmitPaySlip() {
  const res = submitPaySlip({
    userEmail: Session.getActiveUser().getEmail(),
    yearMonth: '2026年06月',
    employeeName: 'テスト太郎',
    salaryType: 'アルバイト',
    workDays: 10,
    totalWorkTime: '42:39:00',
    totalHours: 42.65,
    nightHours: 3.88,
    hourlyRate: 1200,
    nightHourlyRate: 300,
    basicPay: 51180,
    nightPay: 1164,
    totalGross: 52344,
    incomeTax: 0,
    residentialTax: 0,
    employmentInsurance: 0,
    totalDeduction: 0,
    netPay: 52344,
    confirmedBy: 'テスト管理者'
  });
  Logger.log(res.getContent());
}
