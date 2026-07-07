/* ============================================================
   TeamPro 治理層前端 API（缺漏中心 / 佐證庫 / 評鑑完成率）
   - 有設定 Edge Function 網址且非 demo → 走 Supabase Edge Function
   - 否則（demo / 未接後端）→ 走內建「示範資料」本機 store
   契約與 supabase/functions/teampro-api/governance-actions.ts 一致。
   依賴 api.js（window.TP）。
   ============================================================ */
(function (global) {
  var TP = global.TP || {};
  var LS_EDGE = 'teampro_edge_url';
  var LS_DEMO = 'teampro_gov_demo_v1';

  /* ---- 狀態字典（全站一致色系）---- */
  var TASK_STATES = {
    not_started:   { label: '未開始',   cls: 'status-todo' },
    in_progress:   { label: '處理中',   cls: 'status-pending' },
    pending_review:{ label: '待審核',   cls: 'status-pending' },
    returned:      { label: '退回補件', cls: 'status-overdue' },
    completed:     { label: '已完成',   cls: 'status-done' },
    overdue:       { label: '已逾期',   cls: 'status-overdue' }
  };
  var TASK_STATE_ORDER = ['overdue', 'returned', 'not_started', 'in_progress', 'pending_review', 'completed'];
  var PRIORITY = {
    urgent: { label: '緊急', cls: 'status-overdue', rank: 0 },
    high:   { label: '高',   cls: 'status-due',     rank: 1 },
    normal: { label: '一般', cls: 'status-todo',    rank: 2 },
    low:    { label: '低',   cls: 'status-todo',    rank: 3 }
  };
  var REVIEW_STATES = {
    not_checked:     { label: '尚未檢查',   cls: 'status-todo' },
    insufficient:    { label: '資料不足',   cls: 'status-overdue' },
    need_more:       { label: '待補件',     cls: 'status-due' },
    acceptable:      { label: '可採計',     cls: 'status-pending' },
    not_recommended: { label: '不建議採計', cls: 'status-overdue' },
    confirmed:       { label: '已確認完成', cls: 'status-done' }
  };
  // 完成率權重係數（與 SQL state_completion_factor 一致）
  var STATE_FACTOR = { completed: 1, pending_review: 0.7, returned: 0.5, in_progress: 0.3, overdue: 0, not_started: 0 };

  function taskState(s) { return TASK_STATES[s] || TASK_STATES.not_started; }
  function priority(p) { return PRIORITY[p] || PRIORITY.normal; }
  function reviewState(s) { return REVIEW_STATES[s] || REVIEW_STATES.not_checked; }

  function getEdgeUrl() { try { return (localStorage.getItem(LS_EDGE) || '').trim(); } catch (e) { return ''; } }
  function setEdgeUrl(u) { try { localStorage.setItem(LS_EDGE, (u || '').trim()); } catch (e) {} }
  function useDemo() { return (TP.isDemo && TP.isDemo()) || !getEdgeUrl(); }

  function uid(p) { return p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

  /* ============================================================
     示範資料（?demo 或未接後端時使用）— 全程標示「示範資料」
     ============================================================ */
  function seedDemo() {
    var ay = '114';
    var tasks = [
      mkTask('縣市賽獎狀照片未上傳', '訓練績效 / 競賽成果', '跆拳道隊', '王教練', addDays(-2), 'urgent', 'overdue'),
      mkTask('6 月訓練日誌缺 3 天', '運作情形 / 訓練日誌', '武術隊', '林教練', addDays(3), 'high', 'returned'),
      mkTask('傷病追蹤缺家長通知紀錄', '運作情形 / 學生輔導', '田徑隊', '陳教練', addDays(5), 'high', 'not_started'),
      mkTask('學生基本資料 2 人缺身分證號', '基礎資料 / 學生名冊', '跆拳道隊', '王教練', addDays(7), 'normal', 'in_progress'),
      mkTask('畢業銜續訓練統計待審核', '訓練績效 / 銜續統計', '游泳隊', '李教練', addDays(4), 'normal', 'pending_review'),
      mkTask('場地維護紀錄本學期空白', '運作情形 / 場地設備', '田徑隊', '陳教練', addDays(10), 'low', 'not_started'),
      mkTask('公假出席統計已彙整完成', '基礎資料 / 出席統計', '跆拳道隊', '王教練', addDays(-5), 'normal', 'completed'),
      mkTask('特色加分：社區推廣活動照片', '特色加分 / 推廣', '武術隊', '林教練', addDays(14), 'low', 'in_progress')
    ];
    var evidence = [
      mkEv('114_育林國中_跆拳道隊_陳柏宇_全國中等學校運動會_男子52kg_第1名', '比賽獎狀', '訓練績效 / 競賽成果', '跆拳道隊', '陳柏宇', 'confirmed', 'valid'),
      mkEv('114_育林國中_武術隊_訓練日誌_6月', '訓練日誌', '運作情形 / 訓練日誌', '武術隊', '', 'need_more', 'unknown'),
      mkEv('114_育林國中_跆拳道隊_邀請賽_秩序冊', '秩序冊', '訓練績效 / 競賽成果', '跆拳道隊', '', 'not_recommended', 'invalid'),
      mkEv('114_育林國中_田徑隊_林冠霖_縣運_男子跳遠_第3名', '比賽獎狀', '訓練績效 / 競賽成果', '田徑隊', '林冠霖', 'acceptable', 'valid'),
      mkEv('114_育林國中_游泳隊_訓練照片_期中', '訓練照片', '運作情形 / 訓練照片', '游泳隊', '', 'not_checked', 'unknown')
    ];
    var teams = ['跆拳道隊', '武術隊', '田徑隊', '游泳隊'];
    return { academicYear: ay, schoolName: '育林國中（示範）', teams: teams, tasks: tasks, evidence: evidence, demo: true };

    function mkTask(title, item, team, owner, due, pri, state) {
      return { taskId: uid('task_'), title: title, evaluationItemLabel: item, teamName: team,
        assigneeName: owner, dueDate: due, priority: pri, state: state,
        reminderLog: [], completionNote: state === 'completed' ? '已完成並確認' : '', weight: 1 };
    }
    function mkEv(fname, type, item, team, athlete, review, validity) {
      return { evidenceId: uid('ev_'), generatedFilename: fname, evidenceType: type,
        evaluationItemLabel: item, teamName: team, athleteName: athlete,
        reviewStatus: review, reviewNote: '', validityStatus: validity, uploadedAt: todayStr() };
    }
  }
  function loadDemo() {
    try { var v = JSON.parse(localStorage.getItem(LS_DEMO)); if (v && v.tasks) return v; } catch (e) {}
    var seed = seedDemo(); saveDemo(seed); return seed;
  }
  function saveDemo(d) { try { localStorage.setItem(LS_DEMO, JSON.stringify(d)); } catch (e) {} }
  function resetDemo() { try { localStorage.removeItem(LS_DEMO); } catch (e) {} return loadDemo(); }

  /* 完成率（權重法）：Σ(weight×factor) / Σweight × 100 */
  function computeRate(tasks) {
    var tot = 0, got = 0;
    tasks.forEach(function (t) {
      var w = t.weight || 1;
      tot += w; got += w * (STATE_FACTOR[t.state] != null ? STATE_FACTOR[t.state] : 0);
    });
    return tot ? Math.round(got / tot * 1000) / 10 : 0;
  }
  function teamRates(tasks, teams) {
    return teams.map(function (name) {
      var sub = tasks.filter(function (t) { return t.teamName === name; });
      return { teamName: name, rate: computeRate(sub), total: sub.length,
        done: sub.filter(function (t) { return t.state === 'completed'; }).length };
    });
  }

  /* ---- 呼叫 Edge Function ---- */
  async function edge(action, data) {
    var url = getEdgeUrl();
    var body = Object.assign({ action: action, token: (TP.getToken && TP.getToken()) || '' }, data || {});
    try {
      var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await res.json();
    } catch (e) { return { ok: false, error: '連線失敗：' + e.message }; }
  }

  /* ============================================================
     公開 API — 契約：overview / tasks / evidence
     ============================================================ */
  var gov = {
    TASK_STATES: TASK_STATES, TASK_STATE_ORDER: TASK_STATE_ORDER,
    PRIORITY: PRIORITY, REVIEW_STATES: REVIEW_STATES,
    taskState: taskState, priority: priority, reviewState: reviewState,
    getEdgeUrl: getEdgeUrl, setEdgeUrl: setEdgeUrl, useDemo: useDemo, resetDemo: resetDemo,

    async overview() {
      if (!useDemo()) return edge('govOverview', {});
      var d = loadDemo();
      var rates = teamRates(d.tasks, d.teams);
      var overdue = d.tasks.filter(function (t) { return t.state === 'overdue' || t.state === 'returned'; });
      var dueSoon = d.tasks.filter(function (t) {
        return t.state !== 'completed' && t.dueDate && t.dueDate >= todayStr() && t.dueDate <= addDays(7);
      });
      return {
        ok: true, demo: true, schoolName: d.schoolName, academicYear: d.academicYear,
        completionRate: computeRate(d.tasks),
        teams: rates,
        highRiskGaps: overdue.map(pubTask),
        dueSoon: dueSoon.map(pubTask),
        pendingReview: d.evidence.filter(function (e) { return e.reviewStatus === 'not_checked' || e.reviewStatus === 'need_more'; }),
        recentEvidence: d.evidence.slice(0, 5)
      };
    },

    async listTasks(filter) {
      if (!useDemo()) return edge('govListTasks', { filter: filter || {} });
      var d = loadDemo(); var f = filter || {};
      var list = d.tasks.filter(function (t) {
        if (f.state && t.state !== f.state) return false;
        if (f.priority && t.priority !== f.priority) return false;
        if (f.teamName && t.teamName !== f.teamName) return false;
        return true;
      });
      list.sort(function (a, b) {
        var pa = TASK_STATE_ORDER.indexOf(a.state), pb = TASK_STATE_ORDER.indexOf(b.state);
        if (pa !== pb) return pa - pb;
        return priority(a.priority).rank - priority(b.priority).rank;
      });
      return { ok: true, demo: true, tasks: list.map(pubTask), teams: d.teams };
    },

    async createTask(task) {
      if (!useDemo()) return edge('govCreateTask', { task: task });
      var d = loadDemo();
      var t = {
        taskId: uid('task_'), title: task.title || '未命名缺漏',
        evaluationItemLabel: task.evaluationItemLabel || '', teamName: task.teamName || '',
        assigneeName: task.assigneeName || '', dueDate: task.dueDate || '',
        priority: task.priority || 'normal', state: 'not_started',
        reminderLog: [], completionNote: '', weight: task.weight || 1
      };
      d.tasks.push(t); saveDemo(d);
      return { ok: true, demo: true, task: pubTask(t) };
    },

    async updateTaskState(taskId, state, note) {
      if (!useDemo()) return edge('govUpdateTaskState', { taskId: taskId, state: state, note: note || '' });
      var d = loadDemo(); var t = find(d.tasks, taskId);
      if (!t) return { ok: false, error: '找不到任務' };
      t.state = state;
      if (note != null) t.completionNote = note;
      saveDemo(d);
      return { ok: true, demo: true, task: pubTask(t) };
    },

    async remindTask(taskId, channel) {
      if (!useDemo()) return edge('govRemindTask', { taskId: taskId, channel: channel || 'line' });
      var d = loadDemo(); var t = find(d.tasks, taskId);
      if (!t) return { ok: false, error: '找不到任務' };
      t.reminderLog = t.reminderLog || [];
      t.reminderLog.push({ at: new Date().toISOString(), by: '體育組長', channel: channel || 'line' });
      if (t.state === 'not_started') t.state = 'in_progress';
      saveDemo(d);
      var msg = '提醒「' + t.assigneeName + '」於 ' + (t.dueDate || '近期') + ' 前補齊：' + t.title;
      return { ok: true, demo: true, task: pubTask(t), reminderText: msg };
    },

    async listEvidence(filter) {
      if (!useDemo()) return edge('govListEvidence', { filter: filter || {} });
      var d = loadDemo(); var f = filter || {};
      var list = d.evidence.filter(function (e) {
        if (f.reviewStatus && e.reviewStatus !== f.reviewStatus) return false;
        if (f.teamName && e.teamName !== f.teamName) return false;
        return true;
      });
      return { ok: true, demo: true, evidence: list.slice() };
    },

    async reviewEvidence(evidenceId, reviewStatus, note) {
      if (!useDemo()) return edge('govReviewEvidence', { evidenceId: evidenceId, reviewStatus: reviewStatus, note: note || '' });
      var d = loadDemo(); var e = find(d.evidence, evidenceId, 'evidenceId');
      if (!e) return { ok: false, error: '找不到佐證' };
      e.reviewStatus = reviewStatus;
      if (note != null) e.reviewNote = note;
      if (reviewStatus === 'confirmed' || reviewStatus === 'acceptable') e.validityStatus = 'valid';
      if (reviewStatus === 'not_recommended') e.validityStatus = 'invalid';
      saveDemo(d);
      return { ok: true, demo: true, evidence: e };
    }
  };

  function pubTask(t) {
    return {
      taskId: t.taskId, title: t.title, evaluationItemLabel: t.evaluationItemLabel,
      teamName: t.teamName, assigneeName: t.assigneeName, dueDate: t.dueDate,
      priority: t.priority, state: t.state, completionNote: t.completionNote,
      reminderCount: (t.reminderLog || []).length,
      lastReminderAt: (t.reminderLog || []).length ? t.reminderLog[t.reminderLog.length - 1].at : ''
    };
  }
  function find(arr, id, key) { key = key || 'taskId'; for (var i = 0; i < arr.length; i++) if (arr[i][key] === id) return arr[i]; return null; }

  TP.gov = gov;
  global.TP = TP;
})(window);
