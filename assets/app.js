/**
 * 销售业绩记录工具 - 手机版应用逻辑 v5
 * 新增：子分类独立计算方式、业绩归属人、文本导出、自定义弹窗
 */
var App = (function () {
  'use strict';

  /* ===== Storage Keys ===== */
  var SK_RECORDS = 'sales_records_v5';
  var SK_TYPES = 'sales_types_v5';
  var SK_STAFF = 'sales_staff_v5';

  var COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1'];
  var selectedColor = COLORS[0];

  /* ===== State ===== */
  var calYear, calMonth;
  var selectedDate = null;
  var editingTypeId = null;
  var tempSubtypes = [];        // array of {name, calcMode, rate, fixed}
  var recordImages = [];
  var selectedSubtype = null;

  // Dialog state
  var dialogCallback = null;
  var confirmCallback = null;

  /* ===== Subtype Helpers ===== */
  function normalizeSubtype(st) {
    if (typeof st === 'string') return { name: st, calcMode: 'rate', rate: 0, fixed: 0 };
    return {
      name: st.name || '',
      calcMode: st.calcMode || 'rate',
      rate: st.rate || 0,
      fixed: st.fixed || 0
    };
  }

  function normalizeSubtypes(arr) {
    if (!arr) return [];
    return arr.map(normalizeSubtype);
  }

  function getSubtypeByName(type, name) {
    if (!type || !type.subtypes || !name) return null;
    for (var i = 0; i < type.subtypes.length; i++) {
      var st = normalizeSubtype(type.subtypes[i]);
      if (st.name === name) return st;
    }
    return null;
  }

  function getSubtypeDisplay(st) {
    if (!st) return '';
    if (st.calcMode === 'fixed') return '定额 ¥' + st.fixed;
    return '比例 ' + st.rate + '%';
  }

  /* ===== Data Layer (delegates to DataLayer module) ===== */
  function loadRecords() { return DataLayer.loadRecords(); }
  function loadStaff() { return DataLayer.loadStaff(); }
  function loadTypes() { return DataLayer.loadTypes(); }

  /* ===== v5.4-fix P0-4/P0-5: 过渡记录统一视角 helper ===== */
  // 业绩归属人：pending 状态下算给发起人（钱还没同意给对方），其他状态算给 staff（最终归属人）
  function getRecordEffectiveOwner(r) {
    if (!r) return '';
    var status = r.transferStatus || 'approved';
    var from = r.transferFrom || '';
    if (status === 'pending' && from && from !== r.staff) {
      return from;
    }
    return r.staff || '';
  }
  // 当前查看视角人：店长查看全店时返回 ''（表示不过滤人），店员视角返回本人名
  function getCurrentViewOwner() {
    if (DataLayer.isManager() || !DataLayer.isSupaMode()) return '';
    return DataLayer.getMyStaffName() || '';
  }

  /* ===== 权限过滤：普通员工可见记录 =====
   * v5.4 之前：仅看得到「staff=我 且 非 pending」→ 我发起的过渡在日历/月汇总里凭空消失 (P0-4)
   * v5.4 之后：可见 = staff=我（含待我审批的）OR transferFrom=我（我发起的任何状态，含 pending）——可见性与业绩归属解耦
   */
  function getVisibleRecords() {
    var all = loadRecords();
    if (DataLayer.isManager() || !DataLayer.isSupaMode()) return all;
    var myName = DataLayer.getMyStaffName();
    return all.filter(function (r) {
      return (r.staff === myName) || (r.transferFrom === myName);
    });
  }

  /* ===== 获取我过渡给他人的记录（用于日详情显示和删除） ===== */
  function getMyOutgoingTransfers() {
    var all = loadRecords();
    if (!DataLayer.isSupaMode()) return [];
    var myName = DataLayer.getMyStaffName();
    return all.filter(function (r) {
      return r.transferFrom === myName && r.staff !== myName;
    });
  }
  // saveRecords/saveStaff/saveTypes retained as no-ops for backward compat
  // (DataLayer manages cache internally; writes go through async methods)
  function saveRecords(arr) {}
  function saveStaff(arr) {}
  function saveTypes(arr) {}

  function getTypeById(id) {
    var types = loadTypes();
    for (var i = 0; i < types.length; i++) { if (types[i].id === id) return types[i]; }
    return null;
  }

  function genId() { return 'r' + Date.now() + Math.floor(Math.random() * 1000); }

  function calcCommission(typeId, amount, subtypeName) {
    var t = getTypeById(typeId);
    if (!t) return 0;
    var st = getSubtypeByName(t, subtypeName);
    if (!st) return 0;
    if (st.calcMode === 'fixed') return st.fixed || 0;
    return (amount || 0) * (st.rate || 0) / 100;
  }

  /* ===== Image Compression ===== */
  function compressImage(file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        var maxW = 800, maxH = 800;
        var w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.65);
        callback(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /* ===== Helpers ===== */
  function fmt(n) {
    if (n == null || isNaN(n)) return '0.00';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtShort(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return fmt(n);
  }
  function fmtShortCal(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return Math.round(n).toString();
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  function monthStr() {
    var d = new Date();
    return d.getFullYear() + '-' + p2(d.getMonth() + 1);
  }
  function p2(n) { return String(n).padStart(2, '0'); }

  function toast(msg, type) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ===== v5.4-fix P0-3: records 表 schema 列缺失强提示 banner ===== */
  var __schemaBannerShown = false;
  function showSchemaWarningBanner(columns) {
    if (!columns || columns.length === 0) return;
    var colStr = columns.join('、');
    // 1. 立即 toast 提示（保证用户能看到）
    toast('数据库缺少列[' + colStr + ']：过渡功能将异常，请通知店长运行升级脚本', 'error', 10000);
    // 2. 顶部常驻 banner（页面顶部插入红色警示）
    if (__schemaBannerShown) return;
    __schemaBannerShown = true;
    try {
      var banner = document.createElement('div');
      banner.id = 'schema-warn-banner';
      banner.style.cssText = [
        'position:fixed;top:0;left:0;right:0;z-index:99999;',
        'background:#dc2626;color:#fff;padding:10px 14px;font-size:13px;line-height:1.5;',
        'box-shadow:0 2px 8px rgba(220,38,38,0.4);'
      ].join('');
      banner.innerHTML = '<strong>⚠️ 数据库需要升级</strong>：缺少列 <code style="background:rgba(255,255,255,0.2);padding:1px 5px;border-radius:3px;">' +
        colStr +
        '</code><br>' +
        '过渡业绩审批将无法正常保存。请店长在 Supabase SQL Editor 中运行修复脚本 <strong>update-v5.4-transfer-fix.sql</strong>。' +
        '<button onclick="document.getElementById(\'schema-warn-banner\').style.display=\'none\'" style="float:right;margin-left:8px;background:rgba(255,255,255,0.2);border:none;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;cursor:pointer;">×</button>';
      // 兼容老浏览器：body 可能还没 ready
      var mount = function () {
        if (document.body) {
          document.body.appendChild(banner);
          // 如果页面有 topbar，给 body 加 padding-top 防止遮挡
          document.body.style.paddingTop = '52px';
        } else {
          setTimeout(mount, 100);
        }
      };
      mount();
    } catch (e) {
      console.warn('[showSchemaWarningBanner] banner 渲染失败:', e);
    }
  }

  /* ===== Custom Dialog (replace prompt/confirm) ===== */
  function showInputDialog(title, defaultValue, placeholder, callback) {
    document.getElementById('dialog-title').textContent = title;
    var input = document.getElementById('dialog-input');
    input.value = defaultValue || '';
    input.placeholder = placeholder || '';
    dialogCallback = callback;
    showSheet('dialog-overlay', 'dialog-sheet');
    setTimeout(function () { input.focus(); }, 300);
  }

  function confirmDialog() {
    var val = document.getElementById('dialog-input').value;
    hideSheet('dialog-overlay', 'dialog-sheet');
    if (dialogCallback) {
      var cb = dialogCallback;
      dialogCallback = null;
      cb(val);
    }
  }

  function cancelDialog() {
    hideSheet('dialog-overlay', 'dialog-sheet');
    if (dialogCallback) {
      var cb = dialogCallback;
      dialogCallback = null;
      cb(null);
    }
  }

  /* ===== Custom Confirm Dialog (replace confirm) ===== */
  function showConfirmDialog(title, message, callback) {
    document.getElementById('confirm-title').textContent = title || '确认';
    document.getElementById('confirm-message').textContent = message || '';
    confirmCallback = callback;
    showSheet('confirm-overlay', 'confirm-sheet');
  }

  function doConfirm() {
    hideSheet('confirm-overlay', 'confirm-sheet');
    if (confirmCallback) {
      var cb = confirmCallback;
      confirmCallback = null;
      cb(true);
    }
  }

  function cancelConfirm() {
    hideSheet('confirm-overlay', 'confirm-sheet');
    if (confirmCallback) {
      var cb = confirmCallback;
      confirmCallback = null;
      cb(false);
    }
  }

  /* ===== Page Navigation ===== */
  function goPage(page) {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = document.getElementById('page-' + page);
    if (el) el.classList.add('active');
    window.scrollTo(0, 0);

    // FAB only shows on calendar (home) page
    var fab = document.querySelector('.fab');
    if (fab) fab.style.display = (page === 'calendar') ? '' : 'none';

    // 切换页面时自动刷新数据（从 Supabase 重新加载）
    if (DataLayer.isSupaMode()) {
      DataLayer.refresh().then(function () {
        if (page === 'calendar') { updateTopbarUser(); renderCalendar(); renderMonthSummary(); renderDayDetail(); renderPendingTransfers(); }
        if (page === 'types') renderTypesPage();
        if (page === 'monthly') renderMonthly();
      }).catch(function () {});
    } else {
      if (page === 'calendar') { updateTopbarUser(); renderCalendar(); renderMonthSummary(); renderDayDetail(); renderPendingTransfers(); }
      if (page === 'types') renderTypesPage();
      if (page === 'monthly') renderMonthly();
    }
  }

  /* ===== 手动刷新数据 ===== */
  async function refreshData() {
    toast('正在刷新...', 'success');
    try {
      await DataLayer.refresh();
      renderCalendar();
      renderMonthSummary();
      renderDayDetail();
      renderPendingTransfers();
      toast('数据已更新', 'success');
    } catch (e) {
      toast('刷新失败，请重试', 'error');
    }
  }

  /* ===== Calendar Rendering ===== */
  function renderCalendar() {
    var label = document.getElementById('cal-month-label');
    label.textContent = calYear + '年' + (calMonth + 1) + '月';

    var records = getVisibleRecords();
    // ===== v5.4-fix P0-4: 店员视角按 effectiveOwner 再过滤，pending 过渡不悬空 =====
    var viewOwner = getCurrentViewOwner();
    if (viewOwner) {
      records = records.filter(function (r) { return getRecordEffectiveOwner(r) === viewOwner; });
    }
    var earnMap = {};
    records.forEach(function (r) {
      if (!earnMap[r.date]) earnMap[r.date] = 0;
      earnMap[r.date] += (r.amount || 0);
    });

    var firstDay = new Date(calYear, calMonth, 1);
    var startWeekday = firstDay.getDay();
    var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    var prevMonthDays = new Date(calYear, calMonth, 0).getDate();

    var cells = [];
    for (var i = startWeekday - 1; i >= 0; i--) {
      cells.push({ day: prevMonthDays - i, otherMonth: true });
    }
    var today = todayStr();
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = calYear + '-' + p2(calMonth + 1) + '-' + p2(d);
      var weekday = new Date(calYear, calMonth, d).getDay();
      cells.push({
        day: d, date: ds, otherMonth: false,
        isToday: ds === today, isWeekend: weekday === 0 || weekday === 6,
        earning: earnMap[ds] || 0
      });
    }
    var remaining = 42 - cells.length;
    for (var j = 1; j <= remaining; j++) { cells.push({ day: j, otherMonth: true }); }

    var html = '<div class="cal-weekdays">' +
      ['日', '一', '二', '三', '四', '五', '六'].map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>';

    html += '<div class="cal-grid">';
    cells.forEach(function (c) {
      var classes = ['cal-cell'];
      if (c.otherMonth) classes.push('other-month');
      if (c.isToday) classes.push('today');
      if (c.isWeekend) classes.push('weekend');
      if (c.earning > 0) classes.push('has-earning');
      if (c.date === selectedDate) classes.push('selected');

      var earningHtml = c.earning > 0 ? '<div class="cal-earning">¥' + fmtShortCal(c.earning) + '</div>' : '';

      html += '<div class="' + classes.join(' ') + '"' +
        (c.date ? ' onclick="App.selectDay(\'' + c.date + '\')"' : '') + '>' +
        '<div class="cal-day-num">' + c.day + '</div>' + earningHtml + '</div>';
    });
    html += '</div>';
    document.getElementById('calendar').innerHTML = html;
  }

  function selectDay(date) {
    selectedDate = date;
    renderCalendar();
    renderDayDetail();
    setTimeout(function () {
      var el = document.getElementById('day-detail');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }

  function renderMonthSummary() {
    var ym = calYear + '-' + p2(calMonth + 1);
    var records = getVisibleRecords().filter(function (r) { return r.date.startsWith(ym); });
    // ===== v5.4-fix P0-4: 店员视角按 effectiveOwner 过滤，pending 过渡正确归属发起人 =====
    var viewOwner = getCurrentViewOwner();
    if (viewOwner) {
      records = records.filter(function (r) { return getRecordEffectiveOwner(r) === viewOwner; });
    }
    var totalAmount = records.reduce(function (s, r) { return s + (r.amount || 0); }, 0);
    var totalComm = records.reduce(function (s, r) { return s + (r.commission || 0); }, 0);

    document.getElementById('month-summary').innerHTML =
      '<div class="month-stat"><div class="label">销售总额</div><div class="value">¥' + fmtShort(totalAmount) + '</div></div>' +
      '<div class="month-stat"><div class="label">提成总额</div><div class="value accent">¥' + fmtShort(totalComm) + '</div></div>' +
      '<div class="month-stat"><div class="label">记录笔数</div><div class="value">' + records.length + '</div></div>';
  }

  function renderDayDetail() {
    var el = document.getElementById('day-detail');
    if (!selectedDate) selectedDate = todayStr();

    // ===== v5.3.2-fix: 修复过渡业绩重复 =====
    // 1) 店长模式：getVisibleRecords() 已返回整店全部 records，
    //    不需要再 append outgoingTransfers（否则同一条会显示两次）
    // 2) 非店长模式：才需要把「我过渡给别人的、不在我可见列表里的 pending 记录」拼上
    // 3) 最终都按 record.id 再做一次严格去重，双重保险
    var ownRecords = getVisibleRecords().filter(function (r) { return r.date === selectedDate; });
    var outgoingTransfers = [];
    if (!DataLayer.isManager()) {
      outgoingTransfers = getMyOutgoingTransfers()
        .filter(function (r) { return r.date === selectedDate; });
    }
    var _seenIds = Object.create(null);
    var records = ownRecords.concat(outgoingTransfers).filter(function (r) {
      if (!r || !r.id) return false;
      if (_seenIds[r.id]) return false;
      _seenIds[r.id] = true;
      return true;
    });

    var types = loadTypes();
    var typeMap = {};
    types.forEach(function (t) { typeMap[t.id] = t; });

    // ===== v5.4-fix P0-4: 日总额按 effectiveOwner 归属 =====
    // 店长视角：ownRecords 已是全店 → 直接合计整店当天
    // 店员视角：pending 过渡（接收人=我）不算我业绩；我发起的 pending 算我业绩
    var totalRecords = ownRecords;
    var viewOwner = getCurrentViewOwner();
    if (viewOwner) {
      totalRecords = totalRecords.filter(function (r) { return getRecordEffectiveOwner(r) === viewOwner; });
    }
    var totalAmount = totalRecords.reduce(function (s, r) { return s + (r.amount || 0); }, 0);

    var dParts = selectedDate.split('-');
    var displayDate = parseInt(dParts[1]) + '月' + parseInt(dParts[2]) + '日';
    var weekday = new Date(selectedDate).getDay();
    var weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    var html = '<div class="day-detail-header">' +
      '<div><div class="day-detail-title">' + displayDate + ' ' + weekdayNames[weekday] + '</div>' +
      '<div class="day-detail-sub">' + records.length + '笔记录</div></div>' +
      '<div class="day-detail-amount">¥' + fmtShort(totalAmount) + '</div></div>';

    if (records.length === 0) {
      html += '<div class="empty-day">' +
        '<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75V18a2.25 2.25 0 01.75-1.656V6.75A2.25 2.25 0 0015 4.5h-3.75a.75.75 0 00-.75.75v9c0 .414.336.75.75.75z"/></svg>' +
        '<p>当日暂无业绩记录</p><p style="font-size:0.78rem;margin-top:0.25rem;">点击下方 + 添加</p></div>';
    } else {
      html += '<div class="day-detail-list">';
      records.forEach(function (r) {
        var t = typeMap[r.typeId] || { name: '未知', color: '#999' };
        var typeLabel = t.name + (r.subtype ? ' / ' + r.subtype : '');
        var staffHtml = r.staff ? '<div class="ddi-staff">' + r.staff + '</div>' : '';
        var transferHtml = '';
        if (r.transferFrom && r.transferFrom !== r.staff) {
          var statusLabel = r.transferStatus === 'pending' ? '待审批' : '已通过';
          var statusClass = r.transferStatus === 'pending' ? 'ddi-transfer-pending' : 'ddi-transfer';
          transferHtml = '<div class="' + statusClass + '">' + r.transferFrom + ' → ' + r.staff + ' · ' + statusLabel + '</div>';
        }

        var imgHtml = '';
        if (r.images && r.images.length > 0) {
          imgHtml = '<div class="ddi-images">';
          r.images.forEach(function (img, idx) {
            imgHtml += '<div class="ddi-img-thumb" onclick="event.stopPropagation();App.viewImage(\'' + r.id + '\',' + idx + ')"><img src="' + img + '"></div>';
          });
          imgHtml += '</div>';
        }

        // 删除按钮：根据权限决定是否显示
        var canDelete = DataLayer.canDeleteRecord(r);
        var deleteBtnHtml = canDelete ?
          '<button class="ddi-delete" onclick="App.deleteRecord(\'' + r.id + '\')">' +
          '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916"/></svg>' +
          '</button>' : '<div style="width:36px;flex-shrink:0;"></div>';

        html += '<div class="day-detail-item' + (r.transferFrom === DataLayer.getMyStaffName() && r.staff !== DataLayer.getMyStaffName() ? ' ddi-outgoing' : '') + '">' +
          '<div class="ddi-color" style="background:' + t.color + '"></div>' +
          '<div class="ddi-info">' +
          '<div class="ddi-type">' + typeLabel + staffHtml + transferHtml + '</div>' +
          '<div class="ddi-note">' + (r.note || '无备注') + '</div>' +
          imgHtml +
          '</div>' +
          '<div class="ddi-amount">' +
          '<div class="amt">¥' + fmt(r.amount) + '</div>' +
          '<div class="comm">提成 ¥' + fmt(r.commission) + '</div></div>' +
          deleteBtnHtml + '</div>';
      });
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function prevMonth() {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar(); renderMonthSummary();
  }
  function nextMonth() {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar(); renderMonthSummary();
  }

  /* ===== Image Viewer ===== */
  function viewImage(recordId, idx) {
    var records = loadRecords();
    var r = records.find(function (rec) { return rec.id === recordId; });
    if (r && r.images && r.images[idx]) {
      document.getElementById('img-viewer-img').src = r.images[idx];
      document.getElementById('img-viewer').classList.add('show');
    }
  }
  function closeImageViewer() {
    document.getElementById('img-viewer').classList.remove('show');
  }

  /* ===== Quick Add (kept for backward compatibility) ===== */
  function openQuickAdd() { openRecordSheet(); }
  function closeQuickAdd() {}
  function quickSelectType(typeId, subtype) { openRecordSheet(typeId, subtype || null); }

  /* ===== Image Upload Handling ===== */
  function handleImageUpload(input) {
    var files = input.files;
    if (!files || files.length === 0) return;
    var remaining = 3 - recordImages.length;
    if (remaining <= 0) { toast('最多上传3张图片', 'error'); input.value = ''; return; }
    var toProcess = Array.from(files).slice(0, remaining);
    var processed = 0;

    toProcess.forEach(function (file) {
      compressImage(file, function (dataUrl) {
        recordImages.push(dataUrl);
        processed++;
        if (processed === toProcess.length) {
          renderImageThumbs();
          input.value = '';
        }
      });
    });

    if (files.length > remaining) {
      toast('最多上传3张图片，已添加前' + remaining + '张', 'error');
    }
  }

  function renderImageThumbs() {
    var area = document.getElementById('img-upload-area');
    var html = '';
    recordImages.forEach(function (img, idx) {
      html += '<div class="img-thumb">' +
        '<img src="' + img + '">' +
        '<button class="img-remove" onclick="App.removeImage(' + idx + ')">' +
        '<svg fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>' +
        '</button></div>';
    });
    if (recordImages.length < 3) {
      html += '<div class="img-add-btn" onclick="document.getElementById(\'img-input\').click()">' +
        '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>' +
        '添加图片</div>';
    }
    area.innerHTML = html;
  }

  function removeImage(idx) {
    recordImages.splice(idx, 1);
    renderImageThumbs();
  }

  /* ===== Record Sheet ===== */
  function openRecordSheet(presetTypeId, presetSubtype) {
    var types = loadTypes();
    var staff = loadStaff();

    var catInput = document.getElementById('record-category');
    catInput.value = '';
    if (presetTypeId) {
      var pt = getTypeById(presetTypeId);
      if (pt) catInput.value = pt.name;
    }

    var subInput = document.getElementById('record-subtype');
    subInput.value = '';
    if (presetSubtype) subInput.value = presetSubtype;

    // Hide autocomplete dropdowns
    hideAutocomplete('autocomplete-category');
    hideAutocomplete('autocomplete-subtype');

    var dateInput = document.getElementById('record-date');
    dateInput.value = selectedDate || todayStr();

    document.getElementById('record-amount').value = '';
    document.getElementById('record-commission').value = '';
    document.getElementById('record-note').value = '';
    document.getElementById('amount-display').style.display = 'none';

    var staffSelect = document.getElementById('record-staff');
    var isMgr = DataLayer.isManager();
    var myName = DataLayer.getMyStaffName();

    // 管理员和员工都可以选择任意已注册员工
    staffSelect.innerHTML = staff.map(function (s) {
      return '<option value="' + s + '"' + (s === myName ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    staffSelect.disabled = false;

    recordImages = [];
    renderImageThumbs();

    selectedSubtype = subInput.value.trim() || null;
    updateCommPreview();

    showSheet('record-overlay', 'record-sheet');
  }

  /* ===== Autocomplete dropdown logic ===== */
  function getCategoryNames() {
    return loadTypes().map(function (t) { return t.name; });
  }

  function getSubtypeNames(catName) {
    if (!catName) return [];
    var types = loadTypes();
    var t = types.find(function (ty) { return ty.name === catName; });
    return normalizeSubtypes(t ? t.subtypes : []).map(function (st) { return st.name; });
  }

  function showAutocomplete(listId, items, inputValue, onSelectFnName) {
    var list = document.getElementById(listId);
    if (!list) return;

    var filtered = items.filter(function (name) {
      return name.toLowerCase().indexOf(inputValue.toLowerCase()) >= 0;
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="autocomplete-empty">无匹配项，可直接输入</div>';
      list.classList.add('show');
      return;
    }

    list.innerHTML = filtered.map(function (name) {
      return '<div class="autocomplete-item" onmousedown="event.preventDefault();App.' + onSelectFnName + '(\'' + name.replace(/'/g, "\\'") + '\')">' + name + '</div>';
    }).join('');
    list.classList.add('show');
  }

  function hideAutocomplete(listId) {
    var list = document.getElementById(listId);
    if (list) list.classList.remove('show');
  }

  function selectCategory(name) {
    document.getElementById('record-category').value = name;
    hideAutocomplete('autocomplete-category');
    document.getElementById('record-subtype').value = '';
    selectedSubtype = null;
    updateCommPreview();
  }

  function selectSubtype(name) {
    document.getElementById('record-subtype').value = name;
    selectedSubtype = name;
    hideAutocomplete('autocomplete-subtype');
    updateCommPreview();
  }

  function onCategoryInput() {
    var val = document.getElementById('record-category').value.trim();
    showAutocomplete('autocomplete-category', getCategoryNames(), val, 'selectCategory');
    // Update subtype list when category changes
    document.getElementById('record-subtype').value = '';
    selectedSubtype = null;
    updateCommPreview();
  }

  function onSubtypeInput() {
    var catName = document.getElementById('record-category').value.trim();
    var val = document.getElementById('record-subtype').value.trim();
    showAutocomplete('autocomplete-subtype', getSubtypeNames(catName), val, 'selectSubtype');
    selectedSubtype = val || null;
    updateCommPreview();
  }

  function getSelectedTypeIdFromSelect() {
    var catName = document.getElementById('record-category').value.trim();
    if (!catName) return null;
    var types = loadTypes();
    var t = types.find(function (ty) { return ty.name === catName; });
    return t ? t.id : null;
  }

  function onStaffChange() {
    // 归属人只能从已注册员工中选择，不再支持添加新人员
  }

  function closeRecordSheet() { hideSheet('record-overlay', 'record-sheet'); }

  function updateCommPreview() {
    var typeId = getSelectedTypeIdFromSelect();
    var subtype = selectedSubtype;
    var amount = parseFloat(document.getElementById('record-amount').value) || 0;
    var commInput = document.getElementById('record-commission');
    var display = document.getElementById('amount-display');

    if (typeId && subtype) {
      var calc = calcCommission(typeId, amount, subtype);
      if (amount > 0) {
        commInput.value = calc.toFixed(2);
        display.style.display = 'flex';
        document.getElementById('comm-preview').textContent = '¥' + fmt(calc);
      } else {
        commInput.value = '';
        display.style.display = 'none';
      }
    } else {
      display.style.display = 'none';
    }
  }

  async function saveRecord() {
    var date = document.getElementById('record-date').value;
    var catName = document.getElementById('record-category').value.trim();
    var subName = document.getElementById('record-subtype').value.trim();
    var amount = parseFloat(document.getElementById('record-amount').value);
    var commission = parseFloat(document.getElementById('record-commission').value);
    var note = document.getElementById('record-note').value.trim();
    var staff = document.getElementById('record-staff').value;

    if (!date) { toast('请选择日期', 'error'); return; }
    if (!catName) { toast('请输入或选择大类', 'error'); return; }
    if (!subName) { toast('请输入或选择小类', 'error'); return; }
    if (!amount || amount <= 0) { toast('请输入销售金额', 'error'); return; }

    // Auto-create category if it doesn't exist
    var types = loadTypes();
    var t = types.find(function (ty) { return ty.name === catName; });
    if (!t) {
      t = { id: 't' + Date.now(), name: catName, color: COLORS[types.length % COLORS.length], subtypes: [] };
      await DataLayer.saveType(t);
      types = loadTypes();
      t = types.find(function (ty) { return ty.name === catName; }) || t;
    }

    // Auto-create subtype if it doesn't exist
    var subtypesArr = normalizeSubtypes(t.subtypes);
    var st = subtypesArr.find(function (s) { return s.name === subName; });
    if (!st) {
      st = { name: subName, calcMode: 'rate', rate: 0, fixed: 0 };
      t.subtypes.push(st);
      await DataLayer.saveType(t);
    }

    var typeId = t.id;
    var subtype = subName;
    if (isNaN(commission)) commission = calcCommission(typeId, amount, subtype);
    if (staff === '__add__') staff = DataLayer.getMyStaffName() || '我';

    // 记录过渡人（当前操作人），仅当归属人不是自己时才有意义
    var transferFrom = DataLayer.isSupaMode() ? (DataLayer.getMyStaffName() || '') : '';
    // 如果归属人就是自己，不需要过渡记录
    if (staff === transferFrom) transferFrom = '';

    var addRes = await DataLayer.addRecord({
      date: date,
      typeId: typeId,
      subtype: subtype || '',
      amount: amount,
      commission: commission,
      note: note,
      staff: staff,
      transferFrom: transferFrom,
      images: recordImages.slice()
    });

    // ===== v5.4-fix P0-3: schema 列缺失时显示强提示 =====
    if (addRes && addRes.schemaMissing && addRes.schemaMissing.length > 0) {
      showSchemaWarningBanner(addRes.schemaMissing);
    }
    if (addRes && addRes.error) {
      toast(addRes.error.message || '保存失败，请重试', 'error');
      return;
    }

    closeRecordSheet();
    
    // 根据是否有过渡显示不同提示
    if (transferFrom && transferFrom !== staff) {
      toast('已添加过渡业绩，等待' + staff + '审批', 'success');
    } else {
      toast('保存成功！', 'success');
    }

    selectedDate = date;
    var parts = date.split('-');
    calYear = parseInt(parts[0]);
    calMonth = parseInt(parts[1]) - 1;
    renderCalendar();
    renderMonthSummary();
    renderDayDetail();
  }

  function deleteRecord(id) {
    // 查找记录并检查删除权限
    var record = loadRecords().find(function (r) { return r.id === id; });
    if (!record) { toast('记录不存在', 'error'); return; }
    if (!DataLayer.canDeleteRecord(record)) {
      toast('您没有权限删除此记录（过渡记录仅过渡者可删除）', 'error');
      return;
    }
    showConfirmDialog('删除记录', '确定删除这条记录吗？', function (ok) {
      if (!ok) return;
      DataLayer.removeRecord(id).then(function () {
        toast('已删除', 'success');
        renderCalendar();
        renderMonthSummary();
        renderDayDetail();
        renderPendingTransfers();
      });
    });
  }

  /* ===== 过渡审批通知 ===== */
  function renderPendingTransfers() {
    var el = document.getElementById('pending-transfers');
    if (!el) return;

    if (!DataLayer.isSupaMode()) { el.style.display = 'none'; return; }

    var pending = DataLayer.getPendingTransfers();
    if (pending.length === 0) {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    var types = loadTypes();
    var typeMap = {};
    types.forEach(function (t) { typeMap[t.id] = t; });

    // ===== v5.4-fix P1: 店长模式标题区分 =====
    var isMgr = DataLayer.isManager();
    var titleText = isMgr
      ? (pending.length + ' 条全店待审批过渡业绩（店长可强制处理）')
      : (pending.length + ' 条待审批过渡业绩');

    var html = '<div class="pending-header">' +
      '<div class="pending-icon">' +
      '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.852 16.522l4.073-4.073a2.25 2.25 0 00-3.182-3.182l-4.073 4.073m-1.5-1.5l-4.073 4.073a2.25 2.25 0 003.182 3.182l4.073-4.073m-4.073 4.073L6 18m12-3l3 3M15 3l3 3"/></svg>' +
      '</div>' +
      '<div class="pending-title">' + titleText + '</div></div>';

    html += '<div class="pending-list">';
    pending.forEach(function (r) {
      var t = typeMap[r.typeId] || { name: '未知' };
      var typeLabel = t.name + (r.subtype ? ' / ' + r.subtype : '');
      // v5.4 P1: 店长模式下按钮加「强制」标识
      var approveLabel = isMgr ? '强制同意' : '同意';
      var rejectLabel = isMgr ? '强制拒绝' : '拒绝';
      html += '<div class="pending-item">' +
        '<div class="pending-item-info">' +
        '<div class="pending-item-from">' + r.transferFrom + ' → <strong>' + r.staff + '</strong></div>' +
        '<div class="pending-item-type">' + typeLabel + ' · ' + r.date + '</div>' +
        '<div class="pending-item-amount">¥' + fmt(r.amount) + ' · 提成 ¥' + fmt(r.commission) + '</div>' +
        (r.note ? '<div class="pending-item-note">' + r.note + '</div>' : '') +
        '</div>' +
        '<div class="pending-item-actions">' +
        '<button class="pending-btn approve" onclick="App.approveTransfer(\'' + r.id + '\')">' + approveLabel + '</button>' +
        '<button class="pending-btn reject" onclick="App.rejectTransfer(\'' + r.id + '\')">' + rejectLabel + '</button>' +
        '</div></div>';
    });
    html += '</div>';

    el.innerHTML = html;
  }

  async function approveTransfer(recordId) {
    try {
      var res = await DataLayer.approveTransfer(recordId);
      if (res && res.error) {
        toast(res.error.message || '操作失败，请重试', 'error');
        return;
      }
      toast('已同意过渡', 'success');
      renderPendingTransfers();
      renderCalendar();
      renderMonthSummary();
      renderDayDetail();
    } catch (e) {
      toast('操作失败，请重试', 'error');
    }
  }

  async function rejectTransfer(recordId) {
    // ===== v5.4-fix P0-2: 提示语更新——不再删除，而是退回业绩 =====
    showConfirmDialog('拒绝过渡', '确定拒绝这条过渡记录吗？拒绝后业绩将退回给过渡发起人。', async function (ok) {
      if (!ok) return;
      try {
        var res = await DataLayer.rejectTransfer(recordId);
        if (res && res.error) {
          toast(res.error.message || '操作失败，请重试', 'error');
          return;
        }
        toast('已拒绝过渡，业绩已退回发起人', 'success');
        renderPendingTransfers();
        renderCalendar();
        renderMonthSummary();
        renderDayDetail();
      } catch (e) {
        toast('操作失败，请重试', 'error');
      }
    });
  }

  /* ===== Types Management ===== */
  function renderTypesPage() {
    // 显示店铺邀请码（仅 Supabase 模式）
    var shopBanner = document.getElementById('shop-info-banner');
    if (shopBanner) {
      var shop = DataLayer.getShop();
      if (DataLayer.isSupaMode() && shop && shop.join_code) {
        shopBanner.style.display = '';
        document.getElementById('types-shop-code').textContent = shop.join_code;
      } else {
        shopBanner.style.display = 'none';
      }
    }

    var types = loadTypes();
    var container = document.getElementById('types-list');

    if (types.length === 0) {
      container.innerHTML = '<div class="empty-state">' +
        '<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z"/></svg>' +
        '<p>暂无提成类型</p></div>';
      return;
    }

    container.innerHTML = types.map(function (t) {
      var subtypesArr = normalizeSubtypes(t.subtypes);
      var subtypesHtml = '';
      if (subtypesArr.length > 0) {
        subtypesHtml = '<div class="tc-subtypes">' +
          subtypesArr.map(function (st) {
            return '<span>' + st.name + ' · ' + getSubtypeDisplay(st) + '</span>';
          }).join('') + '</div>';
      }
      return '<div class="type-card">' +
        '<div class="tc-color" style="background:' + t.color + '"></div>' +
        '<div class="tc-info"><div class="tc-name">' + t.name + '</div>' +
        '<div class="tc-rate">' + subtypesArr.length + '个子分类</div>' + subtypesHtml + '</div>' +
        '<div class="tc-actions">' +
        '<button onclick="App.openTypeSheet(\'' + t.id + '\')"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/></svg></button>' +
        '<button class="delete" onclick="App.deleteType(\'' + t.id + '\')"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916"/></svg></button>' +
        '</div></div>';
    }).join('');
  }

  function openTypeSheet(id) {
    editingTypeId = id || null;
    var title = document.getElementById('type-sheet-title');
    document.getElementById('type-id').value = id || '';

    selectedColor = COLORS[0];
    renderColorPicker(COLORS[0]);

    if (id) {
      var t = getTypeById(id);
      if (t) {
        title.textContent = '编辑提成类型';
        document.getElementById('type-name').value = t.name;
        selectedColor = t.color;
        renderColorPicker(t.color);
        tempSubtypes = normalizeSubtypes(t.subtypes || []);
      }
    } else {
      title.textContent = '添加提成类型';
      document.getElementById('type-name').value = '';
      tempSubtypes = [];
    }
    document.getElementById('subtype-input').value = '';
    document.getElementById('subtype-rate-input').value = '';
    document.getElementById('subtype-fixed-input').value = '';
    document.getElementById('subtype-calc-mode').value = 'rate';
    toggleSubtypeCalcMode();
    renderSubtypeList();
    showSheet('type-overlay', 'type-sheet');
  }

  function renderSubtypeList() {
    var el = document.getElementById('subtype-list');
    el.innerHTML = tempSubtypes.map(function (st, idx) {
      var modeLabel = st.calcMode === 'fixed' ? '定额 ¥' + st.fixed : '比例 ' + st.rate + '%';
      var rateActive = st.calcMode === 'rate' ? ' mode-active' : '';
      var fixedActive = st.calcMode === 'fixed' ? ' mode-active' : '';
      return '<div class="subtype-item">' +
        '<div class="subtype-item-info">' +
        '<div class="subtype-item-name">' + st.name + '</div>' +
        '<div class="subtype-item-fixed">' + modeLabel + '</div>' +
        '</div>' +
        '<div class="subtype-item-actions">' +
        '<button class="subtype-edit-btn" onclick="App.editSubtype(' + idx + ')">改名</button>' +
        '<button class="subtype-edit-btn' + rateActive + '" onclick="App.editSubtypeRate(' + idx + ')">比例</button>' +
        '<button class="subtype-edit-btn' + fixedActive + '" onclick="App.editSubtypeFixed(' + idx + ')">定额</button>' +
        '<span class="remove" onclick="App.removeSubtype(' + idx + ')">✕</span>' +
        '</div></div>';
    }).join('');
  }

  function toggleSubtypeCalcMode() {
    var mode = document.getElementById('subtype-calc-mode').value;
    document.getElementById('subtype-rate-group').style.display = mode === 'rate' ? '' : 'none';
    document.getElementById('subtype-fixed-group').style.display = mode === 'fixed' ? '' : 'none';
  }

  function addSubtype() {
    var nameInput = document.getElementById('subtype-input');
    var mode = document.getElementById('subtype-calc-mode').value;
    var rateInput = document.getElementById('subtype-rate-input');
    var fixedInput = document.getElementById('subtype-fixed-input');

    var name = nameInput.value.trim();
    if (!name) { toast('请输入子分类名称', 'error'); return; }
    if (tempSubtypes.some(function (s) { return s.name === name; })) {
      toast('该子分类已存在', 'error'); return;
    }

    var rate = parseFloat(rateInput.value) || 0;
    var fixed = parseFloat(fixedInput.value) || 0;
    if (mode === 'rate' && rate <= 0) { toast('请输入有效的提成比例', 'error'); return; }
    if (mode === 'fixed' && fixed <= 0) { toast('请输入有效的固定金额', 'error'); return; }

    tempSubtypes.push({ name: name, calcMode: mode, rate: rate, fixed: fixed });
    nameInput.value = '';
    rateInput.value = '';
    fixedInput.value = '';
    renderSubtypeList();
  }

  function editSubtype(idx) {
    var st = tempSubtypes[idx];
    if (!st) return;
    showInputDialog('修改子分类名称', st.name, '输入新的名称', function (val) {
      if (val === null) return;
      var newName = val.trim();
      if (!newName) { toast('名称不能为空', 'error'); return; }
      if (tempSubtypes.some(function (s, i) { return i !== idx && s.name === newName; })) {
        toast('该名称已存在', 'error'); return;
      }
      tempSubtypes[idx].name = newName;
      renderSubtypeList();
    });
  }

  function editSubtypeRate(idx) {
    var st = tempSubtypes[idx];
    if (!st) return;
    showInputDialog(
      '设置"' + st.name + '"的提成比例',
      String(st.rate || ''),
      '输入比例，如 5 表示 5%',
      function (val) {
        if (val === null) return;
        var num = parseFloat(val);
        if (isNaN(num) || num <= 0) { toast('请输入有效的比例', 'error'); return; }
        tempSubtypes[idx].calcMode = 'rate';
        tempSubtypes[idx].rate = num;
        tempSubtypes[idx].fixed = 0;
        renderSubtypeList();
      }
    );
  }

  function editSubtypeFixed(idx) {
    var st = tempSubtypes[idx];
    if (!st) return;
    showInputDialog(
      '设置"' + st.name + '"的固定提成',
      String(st.fixed || ''),
      '输入固定金额（元）',
      function (val) {
        if (val === null) return;
        var num = parseFloat(val);
        if (isNaN(num) || num <= 0) { toast('请输入有效的金额', 'error'); return; }
        tempSubtypes[idx].calcMode = 'fixed';
        tempSubtypes[idx].fixed = num;
        tempSubtypes[idx].rate = 0;
        renderSubtypeList();
      }
    );
  }

  function removeSubtype(idx) {
    tempSubtypes.splice(idx, 1);
    renderSubtypeList();
  }

  function renderColorPicker(activeColor) {
    var picker = document.getElementById('color-picker');
    picker.innerHTML = COLORS.map(function (c) {
      return '<div class="color-dot' + (c === activeColor ? ' selected' : '') + '" style="background:' + c + ';color:' + c + ';" onclick="App.selectColor(\'' + c + '\')"></div>';
    }).join('');
  }

  function selectColor(c) { selectedColor = c; renderColorPicker(c); }

  function closeTypeSheet() { hideSheet('type-overlay', 'type-sheet'); }

  async function saveType() {
    var id = document.getElementById('type-id').value;
    var name = document.getElementById('type-name').value.trim();

    if (!name) { toast('请输入类型名称', 'error'); return; }
    if (tempSubtypes.length === 0) { toast('请至少添加一个子分类', 'error'); return; }

    var typeData = { id: id || ('t' + Date.now()), name: name, color: selectedColor, subtypes: tempSubtypes.slice() };
    await DataLayer.saveType(typeData);

    closeTypeSheet();
    toast('保存成功！', 'success');
    renderTypesPage();
  }

  function deleteType(id) {
    var records = loadRecords();
    var count = records.filter(function (r) { return r.typeId === id; }).length;
    var msg = '确定删除这个类型吗？';
    if (count > 0) msg = '有 ' + count + ' 条记录使用了此类型，删除后记录类型将显示为"未知"。确定删除吗？';
    showConfirmDialog('删除类型', msg, function (ok) {
      if (!ok) return;
      DataLayer.removeType(id).then(function () {
        toast('已删除', 'success');
        renderTypesPage();
      });
    });
  }

  /* ===== Export Functions ===== */
  function exportCSV() {
    var records = getVisibleRecords();
    var types = loadTypes();
    var typeMap = {};
    types.forEach(function (t) { typeMap[t.id] = t; });

    if (records.length === 0) {
      toast('暂无记录可导出', 'error');
      return;
    }

    var headers = ['日期', '类型', '子分类', '销售金额', '提成金额', '业绩归属', '过渡人', '备注'];
    var rows = records.map(function (r) {
      var t = typeMap[r.typeId] || { name: '未知' };
      return [
        r.date,
        t.name,
        r.subtype || '',
        r.amount,
        r.commission,
        r.staff || '',
        r.transferFrom || '',
        (r.note || '').replace(/"/g, '""')
      ];
    });

    var csvContent = '\uFEFF' + headers.join(',') + '\n' +
      rows.map(function (row) {
        return row.map(function (cell) {
          var s = String(cell);
          if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) {
            return '"' + s + '"';
          }
          return s;
        }).join(',');
      }).join('\n');

    downloadFile(csvContent, '销售业绩_' + todayStr() + '.csv', 'text/csv;charset=utf-8;');
    toast('导出成功！', 'success');
  }

  function exportJSON() {
    var records = loadRecords();
    var types = loadTypes();

    if (records.length === 0 && types.length === 0) {
      toast('暂无数据可导出', 'error');
      return;
    }

    var data = {
      exportDate: new Date().toISOString(),
      version: 'v5',
      types: types,
      records: records
    };

    downloadFile(JSON.stringify(data, null, 2), '销售业绩备份_' + todayStr() + '.json', 'application/json');
    toast('导出成功！', 'success');
  }

  function exportText() {
    var records = getVisibleRecords();
    var types = loadTypes();
    var typeMap = {};
    types.forEach(function (t) { typeMap[t.id] = t; });

    if (records.length === 0) {
      toast('暂无记录可导出', 'error');
      return;
    }

    // Group by date
    var dateGroups = {};
    records.forEach(function (r) {
      if (!dateGroups[r.date]) dateGroups[r.date] = [];
      dateGroups[r.date].push(r);
    });

    var dates = Object.keys(dateGroups).sort();
    var text = '销售业绩汇总\n';
    text += '导出时间：' + new Date().toLocaleString('zh-CN') + '\n';
    text += '记录总数：' + records.length + ' 笔\n';

    var grandTotal = 0, grandComm = 0;
    records.forEach(function (r) { grandTotal += r.amount || 0; grandComm += r.commission || 0; });
    text += '销售总额：¥' + fmt(grandTotal) + '\n';
    text += '提成总额：¥' + fmt(grandComm) + '\n';
    text += '='.repeat(40) + '\n\n';

    dates.forEach(function (date) {
      var dayRecords = dateGroups[date];
      var dayTotal = dayRecords.reduce(function (s, r) { return s + (r.amount || 0); }, 0);
      var dayComm = dayRecords.reduce(function (s, r) { return s + (r.commission || 0); }, 0);

      text += '【' + date + '】 共' + dayRecords.length + '笔  销售¥' + fmt(dayTotal) + '  提成¥' + fmt(dayComm) + '\n';
      text += '-'.repeat(40) + '\n';

      dayRecords.forEach(function (r, i) {
        var t = typeMap[r.typeId] || { name: '未知' };
        var typeLabel = t.name + (r.subtype ? '/' + r.subtype : '');
        text += (i + 1) + '. ' + typeLabel + '  ¥' + fmt(r.amount) + '  提成¥' + fmt(r.commission);
        if (r.staff) text += '  归属：' + r.staff;
        if (r.transferFrom && r.transferFrom !== r.staff) text += '  过渡：' + r.transferFrom + '→' + r.staff;
        if (r.note) text += '\n   备注：' + r.note;
        text += '\n';
      });
      text += '\n';
    });

    downloadFile(text, '销售业绩_' + todayStr() + '.txt', 'text/plain;charset=utf-8;');
    toast('导出成功！', 'success');
  }

  function downloadFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ===== Monthly Summary ===== */
  function populateFilterOptions() {
    var types = loadTypes();
    var staff = loadStaff();

    // Staff filter - 根据权限控制
    var staffSel = document.getElementById('filter-staff');
    var curStaff = staffSel.value;
    if (DataLayer.isManager() || !DataLayer.isSupaMode()) {
      // 管理员或单机模式：显示全部员工
      staffSel.innerHTML = '<option value="">全部归属</option>' +
        staff.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('');
      staffSel.disabled = false;
    } else {
      // 普通员工：只能看自己
      var myName = DataLayer.getMyStaffName();
      staffSel.innerHTML = '<option value="' + myName + '">' + myName + '</option>';
      staffSel.value = myName;
      staffSel.disabled = true;
    }
    if (curStaff && staff.indexOf(curStaff) >= 0) staffSel.value = curStaff;

    // Category filter
    var catSel = document.getElementById('filter-category');
    var curCat = catSel.value;
    catSel.innerHTML = '<option value="">全部大类</option>' +
      types.map(function (t) { return '<option value="' + t.id + '">' + t.name + '</option>'; }).join('');
    catSel.value = curCat;

    // Subcategory filter (based on selected category)
    var subSel = document.getElementById('filter-subcategory');
    var curSub = subSel.value;
    var subOptions = '<option value="">全部小类</option>';
    if (curCat) {
      var t = getTypeById(curCat);
      if (t) {
        var subs = normalizeSubtypes(t.subtypes);
        subOptions += subs.map(function (st) { return '<option value="' + st.name + '">' + st.name + '</option>'; }).join('');
      }
    }
    subSel.innerHTML = subOptions;
    subSel.value = curSub;
  }

  function onFilterCategoryChange() {
    var catSel = document.getElementById('filter-category');
    var subSel = document.getElementById('filter-subcategory');
    var subOptions = '<option value="">全部小类</option>';
    if (catSel.value) {
      var t = getTypeById(catSel.value);
      if (t) {
        var subs = normalizeSubtypes(t.subtypes);
        subOptions += subs.map(function (st) { return '<option value="' + st.name + '">' + st.name + '</option>'; }).join('');
      }
    }
    subSel.innerHTML = subOptions;
    renderMonthly();
  }

  function filterMonthly() {
    renderMonthly();
  }

  function getFilteredRecords(ym) {
    var records = getVisibleRecords().filter(function (r) { return r.date.startsWith(ym); });

    var staffFilter = document.getElementById('filter-staff');
    var catFilter = document.getElementById('filter-category');
    var subFilter = document.getElementById('filter-subcategory');

    var sVal = staffFilter ? staffFilter.value : '';
    var cVal = catFilter ? catFilter.value : '';
    var subVal = subFilter ? subFilter.value : '';

    if (sVal) {
      // ===== v5.4-fix P0-5: 人员筛选按 effectiveOwner 匹配 =====
      // 选 A 则包含：A 发起的 pending（归属 A） + 归属 A 本身已审批/拒绝的所有记录
      records = records.filter(function (r) { return getRecordEffectiveOwner(r) === sVal; });
    }
    if (cVal) {
      records = records.filter(function (r) { return r.typeId === cVal; });
    }
    if (subVal) {
      records = records.filter(function (r) { return r.subtype === subVal; });
    }
    return records;
  }

  function renderMonthly() {
    var monthInput = document.getElementById('monthly-select');
    if (!monthInput.value) monthInput.value = monthStr();
    var ym = monthInput.value;

    populateFilterOptions();

    var records = getFilteredRecords(ym);
    var types = loadTypes();
    var typeMap = {};
    types.forEach(function (t) { typeMap[t.id] = t; });

    var totalAmount = records.reduce(function (s, r) { return s + (r.amount || 0); }, 0);
    var totalComm = records.reduce(function (s, r) { return s + (r.commission || 0); }, 0);
    var daysInMonth = new Date(parseInt(ym.split('-')[0]), parseInt(ym.split('-')[1]), 0).getDate();
    var avgPerDay = totalAmount / daysInMonth;

    document.getElementById('monthly-stats').innerHTML =
      '<div class="summary-stat"><div class="label">销售总额</div><div class="value">¥' + fmtShort(totalAmount) + '</div></div>' +
      '<div class="summary-stat"><div class="label">提成总额</div><div class="value accent">¥' + fmtShort(totalComm) + '</div></div>' +
      '<div class="summary-stat"><div class="label">记录笔数</div><div class="value">' + records.length + '</div></div>' +
      '<div class="summary-stat"><div class="label">日均销售</div><div class="value success">¥' + fmtShort(avgPerDay) + '</div></div>';

    renderMonthlyDaily(records, ym);
    renderMonthlyType(records, types);
    renderMonthlyTable(records, typeMap, totalAmount, totalComm);
    renderTransferStats(ym);
  }

  /* ===== 过渡业绩统计 ===== */
  function renderTransferStats(ym) {
    var card = document.getElementById('transfer-stats-card');
    var el = document.getElementById('transfer-stats');
    if (!card || !el) return;

    if (!DataLayer.isSupaMode()) { card.style.display = 'none'; return; }

    var myName = DataLayer.getMyStaffName();
    // 从全部记录中查找我过渡给别人的记录（不受可见性过滤限制）
    var allRecords = loadRecords().filter(function (r) { return r.date.startsWith(ym); });
    var myTransfers = allRecords.filter(function (r) {
      return r.transferFrom === myName && r.staff !== myName;
    });

    if (myTransfers.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = '';
    // 按归属人分组统计
    var stats = {};
    myTransfers.forEach(function (r) {
      if (!stats[r.staff]) stats[r.staff] = { count: 0, amount: 0, comm: 0 };
      stats[r.staff].count++;
      stats[r.staff].amount += r.amount || 0;
      stats[r.staff].comm += r.commission || 0;
    });

    var totalAmount = myTransfers.reduce(function (s, r) { return s + (r.amount || 0); }, 0);
    var html = '<div style="margin-bottom:0.5rem;font-size:0.8rem;color:var(--muted);">我过渡给他人 ¥' + fmt(totalAmount) + '（共' + myTransfers.length + '笔）</div>';
    html += '<div style="overflow-x:auto;"><table class="summary-table"><thead><tr><th>过渡给</th><th style="text-align:center;">笔数</th><th style="text-align:right;">销售额</th><th style="text-align:right;">提成</th></tr></thead><tbody>';
    Object.keys(stats).forEach(function (name) {
      var s = stats[name];
      html += '<tr><td>' + name + '</td><td style="text-align:center;">' + s.count + '</td>' +
        '<td class="num">¥' + fmt(s.amount) + '</td>' +
        '<td class="num" style="color:var(--accent)">¥' + fmt(s.comm) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  }

  function renderMonthlyDaily(records, ym) {
    var el = document.getElementById('chart-monthly-daily');
    if (!el) return;
    var chart = echarts.init(el, null, { renderer: 'svg' });
    var style = getComputedStyle(document.documentElement);
    var muted = style.getPropertyValue('--muted').trim();
    var rule = style.getPropertyValue('--rule').trim();
    var accent = style.getPropertyValue('--accent').trim();
    var accent2 = style.getPropertyValue('--accent2').trim();

    var year = parseInt(ym.split('-')[0]);
    var month = parseInt(ym.split('-')[1]);
    var daysInMonth = new Date(year, month, 0).getDate();
    var days = [], amountData = [], commData = [];

    for (var d = 1; d <= daysInMonth; d++) {
      var ds = ym + '-' + p2(d);
      days.push(d);
      var dr = records.filter(function (r) { return r.date === ds; });
      amountData.push(dr.reduce(function (s, r) { return s + (r.amount || 0); }, 0));
      commData.push(dr.reduce(function (s, r) { return s + (r.commission || 0); }, 0));
    }

    chart.setOption({
      tooltip: { trigger: 'axis', appendToBody: true },
      legend: { data: ['销售额', '提成'], top: 0, textStyle: { color: muted } },
      grid: { left: '3%', right: '5%', bottom: '3%', top: 35, containLabel: true },
      xAxis: { type: 'category', data: days, axisLabel: { color: muted, fontSize: 10 }, axisLine: { lineStyle: { color: rule } } },
      yAxis: { type: 'value', axisLabel: { color: muted, fontSize: 10, formatter: function (v) { return fmtShort(v); } }, splitLine: { lineStyle: { color: rule } } },
      series: [
        { name: '销售额', type: 'bar', data: amountData, itemStyle: { color: accent }, barWidth: '50%' },
        { name: '提成', type: 'line', data: commData, smooth: true, itemStyle: { color: accent2 }, lineStyle: { width: 2 } }
      ]
    });
    window.addEventListener('resize', function () { chart.resize(); });
  }

  function renderMonthlyType(records, types) {
    var el = document.getElementById('chart-monthly-type');
    if (!el) return;
    var chart = echarts.init(el, null, { renderer: 'svg' });
    var style = getComputedStyle(document.documentElement);
    var muted = style.getPropertyValue('--muted').trim();
    var ink = style.getPropertyValue('--ink').trim();

    var typeMap = {};
    types.forEach(function (t) { typeMap[t.id] = { name: t.name, value: 0, color: t.color }; });
    records.forEach(function (r) { if (typeMap[r.typeId]) typeMap[r.typeId].value += (r.amount || 0); });
    var data = Object.values(typeMap).filter(function (d) { return d.value > 0; });

    if (data.length === 0) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:' + muted + ';font-size:0.85rem;">暂无数据</div>';
      return;
    }

    chart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)', appendToBody: true },
      series: [{
        type: 'pie', radius: '65%',
        data: data.map(function (d) { return { name: d.name, value: d.value, itemStyle: { color: d.color } }; }),
        label: { color: ink, fontSize: 11 }
      }]
    });
    window.addEventListener('resize', function () { chart.resize(); });
  }

  function renderMonthlyTable(records, typeMap, totalAmount, totalComm) {
    var el = document.getElementById('monthly-table');
    if (records.length === 0) {
      el.innerHTML = '<tbody><tr><td style="text-align:center;color:var(--muted);padding:2rem;">暂无记录</td></tr></tbody>';
      return;
    }

    var typeStats = {};
    records.forEach(function (r) {
      if (!typeStats[r.typeId]) typeStats[r.typeId] = { count: 0, amount: 0, commission: 0 };
      typeStats[r.typeId].count++;
      typeStats[r.typeId].amount += r.amount || 0;
      typeStats[r.typeId].commission += r.commission || 0;
    });

    var html = '<thead><tr><th>类型</th><th style="text-align:center;">笔数</th><th style="text-align:right;">销售额</th><th style="text-align:right;">提成</th><th style="text-align:right;">占比</th></tr></thead><tbody>';
    Object.keys(typeStats).forEach(function (tid) {
      var t = typeMap[tid] || { name: '未知', color: '#999' };
      var s = typeStats[tid];
      var pct = totalAmount > 0 ? (s.amount / totalAmount * 100).toFixed(1) : '0.0';
      html += '<tr><td><span class="badge" style="background:' + t.color + '20;color:' + t.color + '"><span class="badge-dot" style="background:' + t.color + '"></span>' + t.name + '</span></td>' +
        '<td style="text-align:center;">' + s.count + '</td>' +
        '<td class="num">¥' + fmt(s.amount) + '</td>' +
        '<td class="num" style="color:var(--accent)">¥' + fmt(s.commission) + '</td>' +
        '<td class="num">' + pct + '%</td></tr>';
    });
    html += '</tbody><tfoot><tr><td>合计</td><td style="text-align:center;">' + records.length + '</td>' +
      '<td class="num">¥' + fmt(totalAmount) + '</td>' +
      '<td class="num" style="color:var(--accent)">¥' + fmt(totalComm) + '</td>' +
      '<td class="num">100%</td></tr></tfoot>';
    el.innerHTML = html;
  }

  /* ===== Sheet Helpers ===== */
  function showSheet(overlayId, sheetId) {
    document.getElementById(overlayId).classList.add('show');
    document.getElementById(sheetId).classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function hideSheet(overlayId, sheetId) {
    document.getElementById(overlayId).classList.remove('show');
    document.getElementById(sheetId).classList.remove('show');
    document.body.style.overflow = '';
  }

  /* ===== Auth & Account ===== */
  var authMode = 'login'; // 'login' or 'register'
  var setupMode = 'create'; // 'create' or 'join'

  function switchAuthTab(mode) {
    authMode = mode;
    document.querySelectorAll('.auth-tab').forEach(function (t) { t.classList.remove('active'); });
    var btn = document.querySelector('.auth-tab[data-mode="' + mode + '"]');
    if (btn) btn.classList.add('active');
    var submitText = document.getElementById('auth-submit-text');
    if (submitText) submitText.textContent = mode === 'login' ? '登录' : '注册';
    var nameField = document.getElementById('auth-name-field');
    if (nameField) nameField.style.display = mode === 'register' ? '' : 'none';
  }

  function switchSetupTab(mode) {
    setupMode = mode;
    document.querySelectorAll('.setup-tab').forEach(function (t) { t.classList.remove('active'); });
    var btn = document.querySelector('.setup-tab[data-mode="' + mode + '"]');
    if (btn) btn.classList.add('active');
    var createField = document.getElementById('setup-create-field');
    if (createField) createField.style.display = mode === 'create' ? '' : 'none';
    var joinField = document.getElementById('setup-join-field');
    if (joinField) joinField.style.display = mode === 'join' ? '' : 'none';
    var submitText = document.getElementById('setup-submit-text');
    if (submitText) submitText.textContent = mode === 'create' ? '创建店铺' : '加入店铺';
  }

  // v5-fix: doAuth 改 finally 兜底，所有 return/throw 都会重置按钮
  async function doAuth() {
    var email = document.getElementById('auth-email').value.trim();
    var password = document.getElementById('auth-password').value;
    var displayName = document.getElementById('auth-name') ? document.getElementById('auth-name').value.trim() : '';

    if (!email) { toast('请输入邮箱', 'error'); return; }
    if (!password || password.length < 6) { toast('密码至少6位', 'error'); return; }

    var btn = document.getElementById('auth-submit');
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '处理中...';

    try {
      if (authMode === 'register') {
        if (!displayName) { toast('请输入昵称', 'error'); return; }
        var regResult = await SupaAuth.signUp(email, password, displayName);
        // ===== v5.4-fix: signUp 报「已注册」→ 自动 fallback 登录（账号在 auth.users 里，只是 profiles 被后台删了）=====
        if (regResult.error) {
          var errMsg = String(regResult.error.message || '');
          var isAlreadyRegistered = /already\s+registered|已注册|already\s+a\s+user|user\s+already\s+exists|email\s+already/i.test(errMsg);
          if (isAlreadyRegistered) {
            console.info('[doAuth] signUp reported already registered → fallback signIn');
            var fbLogin = await SupaAuth.signIn(email, password);
            if (!fbLogin.error) {
              toast('该账号已存在，已为您自动登录。若尚未加入店铺，请选择加入店铺或创建店铺。', 'success', 10000);
              await initAfterAuth();
              return;
            }
            // fallback 登录失败（比如密码不对）：提示密码错并切到登录 tab
            var fbMsg = String(fbLogin.error && fbLogin.error.message || '');
            if (/invalid.*password|password.*invalid|invalid\s+credentials|账号或密码|密码错误/i.test(fbMsg)) {
              toast('该邮箱已注册但密码错误，请切换到「登录」并使用正确密码登录（或找回密码）', 'error', 10000);
            } else {
              toast('该邮箱已注册：' + fbMsg, 'error');
            }
            switchAuthTab('login');
            document.getElementById('auth-email').value = email;
            return;
          }
          // 其他 signUp 错误（非已注册）
          console.error('[doAuth] signUp error:', regResult.error);
          toast(errMsg || '注册失败', 'error');
          return;
        }
        if (!regResult.data.session) {
          toast('注册成功！请检查邮箱完成验证后再登录', 'success');
          switchAuthTab('login');
          document.getElementById('auth-email').value = email;
          return;
        }
        toast('注册成功！', 'success');
        await initAfterAuth();
      } else {
        var loginResult = await SupaAuth.signIn(email, password);
        if (loginResult.error) {
          console.error('[doAuth] signIn error:', loginResult.error);
          toast(loginResult.error.message || '登录失败', 'error');
          return;
        }
        toast('登录成功！', 'success');
        await initAfterAuth();
      }
    } catch (e) {
      console.error('[doAuth] THREW:', e && e.message, e && e.stack);
      toast('错误：' + (e.message || '网络错误，请重试'), 'error');
    } finally {
      // v5-fix: 无论成功/失败/异常，都一定重置按钮
      btn.disabled = false;
      btn.textContent = originalText && originalText !== '处理中...' ? originalText : (authMode === 'login' ? '登录' : '注册');
      // 全局兜底（猴子补丁里的函数，存在即调用）
      if (typeof window.resetLoading === 'function') window.resetLoading();
    }
  }

  // v5-fix: doSetup 改 finally 兜底，修复「加入成功后一直处理中」的问题
  async function doSetup() {
    var displayName = document.getElementById('setup-display-name').value.trim();
    if (!displayName) { toast('请输入你的昵称', 'error'); return; }

    var btn = document.getElementById('setup-submit');
    var originalText = setupMode === 'create' ? '创建店铺' : '加入店铺';
    btn.disabled = true;
    btn.textContent = '处理中...';

    try {
      if (setupMode === 'create') {
        var shopName = document.getElementById('setup-shop-name').value.trim();
        if (!shopName) { toast('请输入店铺名称', 'error'); return; }
        var result = await SupaAuth.createShop(shopName, displayName);
        if (result.error) {
          console.error('[doSetup] createShop error:', result.error);
          toast(result.error.message || '创建失败', 'error');
          return;
        }
        toast('店铺创建成功！正在加载...', 'success');
        await initAfterAuth();
      } else {
        var joinCode = document.getElementById('setup-join-code').value.trim();
        if (!joinCode) { toast('请输入邀请码', 'error'); return; }
        var joinResult = await SupaAuth.joinShop(joinCode, displayName);
        if (joinResult.error) {
          console.error('[doSetup] joinShop error:', joinResult.error);
          toast(joinResult.error.message || '加入失败，请检查邀请码', 'error');
          return;
        }
        toast('加入成功！正在加载店铺数据...', 'success');
        await initAfterAuth();
      }
    } catch (e) {
      console.error('[doSetup] THREW (this is why spinner stuck before):', e && e.message, e && e.stack);
      toast('处理失败：' + (e.message || '请刷新后重试'), 'error');
    } finally {
      // v5-fix: ★ 无论成功/失败/异常/return，都一定重置按钮 ★ —— 这就是修复卡 loading 的关键
      btn.disabled = false;
      btn.textContent = originalText;
      if (typeof window.resetLoading === 'function') window.resetLoading();
    }
  }

  // v5.1-fix: initAfterAuth 加强 mode=auth 提示 —— 用户点了登录走这里
  async function initAfterAuth() {
    var sessBefore = null;
    try { sessBefore = SupaAuth.getSession ? (await SupaAuth.getSession()) : null; } catch (_) {}
    try {
      var result = await DataLayer.init();
      console.log('[initAfterAuth] DataLayer.init() returned:', result);
      if (result.degraded) {
        console.warn('[initAfterAuth] running in degraded mode, cache may be empty. Recommend user to refresh once. initError:', result.initError);
      }
      if (result.mode === 'setup') {
        showSetupPage();
      } else if (result.mode === 'ready') {
        showMainApp();
        // ===== v5.4-fix P0-3: 注册 schema 缺失事件监听 =====
        try {
          window.addEventListener('records-schema-missing', function (evt) {
            var cols = (evt && evt.detail && evt.detail.columns) || window.__recordsSchemaMissing;
            if (cols && cols.length > 0) showSchemaWarningBanner(cols);
          });
          // 如果之前已经有记录到的列缺失，立即显示
          if (window.__recordsSchemaMissing && window.__recordsSchemaMissing.length > 0) {
            showSchemaWarningBanner(window.__recordsSchemaMissing);
          }
        } catch (_) {}
        try { checkAndPromptMigration(); } catch (e) { console.error('[initAfterAuth] migration prompt error:', e); }
      } else if (result.mode === 'auth') {
        // ★ v5.4 修复：区分两种 auth 情况
        //   1) profile_rebuild_failed：profiles 被后台删除后，兜底重建也失败（通常缺 INSERT RLS policy）→ 带 SQL 提示
        //   2) 其他：profiles RLS 死循环 或 记录未生成 → 提示修复 RLS
        console.warn('[initAfterAuth] mode=auth after login → subcode=' + result.authSubcode);
        if (sessBefore && sessBefore.user) {
          if (result.authSubcode === 'profile_rebuild_failed') {
            var rebuildMsg = (result.authMsg || 'profiles 记录缺失且自动重建失败') +
              '（如刚在后台删除过员工/资料，属正常）请通知管理员在 Supabase 执行 update-v5.4.3-profile-fix.sql，执行后刷新即可自动加入店铺或创建店铺。';
            toast(rebuildMsg, 'error', 15000);
          } else {
            toast('登录成功但无法读取您的账号资料：请通知管理员在 Supabase 控制台执行数据库修复脚本 update-v5.sql（重点检查 profiles RLS 策略是否含嵌套子查询）', 'error', 12000);
          }
        } else {
          showAuthPage();
        }
      } else if (result.mode === 'local') {
        console.warn('[initAfterAuth] got mode=local, showing main app with local data');
        showMainApp();
      }
    } catch (e) {
      console.error('[initAfterAuth] FATAL THREW (showing main page best-effort):', e && e.message);
      try { showMainApp(); } catch (_) {}
      toast('数据加载异常，请刷新页面。若反复出现请联系管理员更新数据库。', 'error');
    }
  }

  function showAuthPage() {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = document.getElementById('page-auth');
    if (el) el.classList.add('active');
    var fab = document.querySelector('.fab');
    if (fab) fab.style.display = 'none';
  }

  function showSetupPage() {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = document.getElementById('page-setup');
    if (el) el.classList.add('active');
    var fab = document.querySelector('.fab');
    if (fab) fab.style.display = 'none';
    // 显示邀请码（如果有店铺）
    var shop = DataLayer.getShop();
    if (shop && shop.join_code) {
      var codeEl = document.getElementById('setup-shop-code');
      if (codeEl) {
        codeEl.style.display = '';
        document.getElementById('setup-code-value').textContent = shop.join_code;
      }
    }
  }

  function showMainApp() {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = document.getElementById('page-calendar');
    if (el) el.classList.add('active');
    var fab = document.querySelector('.fab');
    if (fab) fab.style.display = '';

    var now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    selectedDate = todayStr();

    updateTopbarUser();
    renderCalendar();
    renderMonthSummary();
    renderDayDetail();
    renderPendingTransfers();
  }

  function updateTopbarUser() {
    var profile = DataLayer.getProfile();
    var shop = DataLayer.getShop();
    if (!profile) return;

    var titleEl = document.querySelector('.topbar-title');
    if (titleEl) {
      titleEl.textContent = shop ? shop.name : '销售业绩';
    }

    var userEl = document.getElementById('topbar-user');
    if (userEl) {
      var roleBadge = profile.role === 'manager' ? '管理员' : '员工';
      userEl.innerHTML = '<span class="user-name">' + profile.display_name + '</span>' +
        '<span class="user-role role-' + profile.role + '">' + roleBadge + '</span>';
      userEl.style.display = '';
    }

    var logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.style.display = DataLayer.isSupaMode() ? '' : 'none';
    }
  }

  function checkAndPromptMigration() {
    if (!DataLayer.isSupaMode()) return;
    if (!DataLayer.hasLocalData()) return;
    showConfirmDialog('数据迁移', '检测到本地有历史数据，是否迁移到云端？迁移后其他成员也能看到这些数据。', function (ok) {
      if (!ok) return;
      toast('正在迁移...', 'success');
      DataLayer.migrateFromLocalStorage().then(function (result) {
        toast('迁移完成！共迁移 ' + result.migrated + ' 条记录', 'success');
        renderCalendar();
        renderMonthSummary();
        renderDayDetail();
      }).catch(function () {
        toast('迁移失败，请重试', 'error');
      });
    });
  }

  async function doLogout() {
    showConfirmDialog('退出登录', '确定要退出登录吗？', async function (ok) {
      if (!ok) return;
      await SupaAuth.signOut();
      showAuthPage();
      toast('已退出登录', 'success');
    });
  }

  /* ===== Init ===== */
  async function init() {
    // 如果 Supabase 未配置，降级到 localStorage 单用户模式
    if (!isSupabaseConfigured()) {
      await DataLayer.init();
      var now = new Date();
      calYear = now.getFullYear();
      calMonth = now.getMonth();
      selectedDate = todayStr();

      renderCalendar();
      renderMonthSummary();
      renderDayDetail();
      return;
    }

    // Supabase 模式：检查登录状态
    var result = await DataLayer.init();
    if (result.mode === 'auth') {
      // v5.1-fix: 先判断是否实际上已登录（但读不到 profile → 几乎肯定是 profiles RLS 死循环）
      var _sess = null;
      try { _sess = SupaAuth.getSession ? (await SupaAuth.getSession()) : null; } catch (_) {}
      if (_sess && _sess.user) {
        console.warn('[App.init] 有 session 但 mode=auth，几乎 100% 是 profiles RLS 死循环');
        toast('登录状态异常：数据库策略未更新，请联系管理员在 Supabase 控制台运行 update-v5.sql', 'error', 10000);
      }
      showAuthPage();
    } else if (result.mode === 'setup') {
      showSetupPage();
    } else if (result.mode === 'ready') {
      showMainApp();
      try { checkAndPromptMigration(); } catch (e) { console.error('[init] migration error:', e); }
    } else {
      // local mode (Supabase init failed)
      var now2 = new Date();
      calYear = now2.getFullYear();
      calMonth = now2.getMonth();
      selectedDate = todayStr();
      try {
        renderCalendar();
        renderMonthSummary();
        renderDayDetail();
      } catch (e) {
        console.error('[init] local mode render error:', e);
      }
    }
  }

  /* ===== Public API ===== */
  return {
    init: init,
    goPage: goPage,
    refreshData: refreshData,
    prevMonth: prevMonth,
    nextMonth: nextMonth,
    selectDay: selectDay,
    openQuickAdd: openQuickAdd,
    closeQuickAdd: closeQuickAdd,
    quickSelectType: quickSelectType,
    openRecordSheet: openRecordSheet,
    closeRecordSheet: closeRecordSheet,
    onCategoryInput: onCategoryInput,
    onSubtypeInput: onSubtypeInput,
    selectCategory: selectCategory,
    selectSubtype: selectSubtype,
    hideAutocomplete: hideAutocomplete,
    onStaffChange: onStaffChange,
    updateCommPreview: updateCommPreview,
    handleImageUpload: handleImageUpload,
    removeImage: removeImage,
    viewImage: viewImage,
    closeImageViewer: closeImageViewer,
    saveRecord: saveRecord,
    deleteRecord: deleteRecord,
    approveTransfer: approveTransfer,
    rejectTransfer: rejectTransfer,
    renderTypesPage: renderTypesPage,
    openTypeSheet: openTypeSheet,
    closeTypeSheet: closeTypeSheet,
    addSubtype: addSubtype,
    editSubtype: editSubtype,
    editSubtypeRate: editSubtypeRate,
    editSubtypeFixed: editSubtypeFixed,
    removeSubtype: removeSubtype,
    selectColor: selectColor,
    toggleSubtypeCalcMode: toggleSubtypeCalcMode,
    saveType: saveType,
    deleteType: deleteType,
    renderMonthly: renderMonthly,
    filterMonthly: filterMonthly,
    onFilterCategoryChange: onFilterCategoryChange,
    exportCSV: exportCSV,
    exportText: exportText,
    confirmDialog: confirmDialog,
    cancelDialog: cancelDialog,
    doConfirm: doConfirm,
    cancelConfirm: cancelConfirm,
    // Auth & account
    switchAuthTab: switchAuthTab,
    switchSetupTab: switchSetupTab,
    doAuth: doAuth,
    doSetup: doSetup,
    doLogout: doLogout
  };
})();

document.addEventListener('DOMContentLoaded', function () { App.init(); });
