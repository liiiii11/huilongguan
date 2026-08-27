/* ============================================================
 *  frontend-join-fix-patch.js  v5.1-minimal
 *  轻量兜底补丁：防卡 loading + 诊断 RLS 死循环 + mode=auth 兜底提示
 *  在 index.html 中 <script src="assets/frontend-join-fix-patch.js?v=6"></script>
 *  放在 app.js 之后、body 结束之前
 * ============================================================ */
(function () {
  'use strict';

  if (typeof DataLayer === 'undefined' || typeof SupaAuth === 'undefined') {
    console.warn('[fix-patch v5.1] DataLayer/SupaAuth missing; skip');
    return;
  }

  console.info('%c[fix-patch v5.1] Applying minimal fixes...', 'color:green');

  // --- 1) getProfile 详细错误打印 + RLS 死循环识别 ---
  var _origGetProfile = SupaAuth.getProfile;
  SupaAuth.getProfile = async function () {
    try {
      var user = await SupaAuth.getUser();
      if (!user) { console.warn('[fix-patch] getUser() => null'); return null; }
      var r = await SupaAuth.getClient().from('profiles').select('*').eq('user_id', user.id).single();
      if (r && r.error) {
        var code = r.error.code || '';
        var msg  = r.error.message || '';
        console.error('[fix-patch] getProfile REST ERROR code=' + code + ' msg=' + msg +
          (r.error.details ? ' details=' + r.error.details : '') +
          (r.error.hint ? ' hint=' + r.error.hint : ''));
        if (code === '42P17' || msg.indexOf('infinite recursion') !== -1) {
          console.error('%c[fix-patch] ⚠️ profiles RLS 死循环！必须在 Supabase SQL Editor 运行 update-v5.sql',
            'background:#ff0;color:#000;font-weight:bold');
        }
        return null;
      }
      return (r && r.data) || null;
    } catch (e) {
      console.error('[fix-patch] getProfile THREW:', e && e.message ? e.message : e);
      return null;
    }
  };

  // --- 2) SupaAuth 四个方法包 finally：强制重置所有 loading ---
  function _wrapFinally(name, fn) {
    SupaAuth[name] = async function () {
      try { return await fn.apply(this, arguments); }
      finally { if (typeof window.resetLoading === 'function') window.resetLoading(); }
    };
  }
  ['signIn','signUp','joinShop','createShop'].forEach(function (n) {
    if (typeof SupaAuth[n] === 'function') _wrapFinally(n, SupaAuth[n]);
  });
  console.info('[fix-patch v5.1] signIn/signUp/joinShop/createShop wrapped with finally resetLoading');

  // --- 3) 全局兜底 loading 重置（最外层保险）---
  window.resetLoading = function () {
    try {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var txt = btns[i].textContent || '';
        if (txt.indexOf('处理中') !== -1 || txt.indexOf('加载中') !== -1) {
          btns[i].disabled = false;
          btns[i].textContent = txt.replace(/处理中[.。]*|加载中[.。]*/g, '').trim() || btns[i].getAttribute('data-original-text') || '确定';
        }
      }
    } catch (e) { /* noop */ }
    try {
      var spinners = document.querySelectorAll('.loading,.spinner,[class*=loading],[id*=loading]');
      for (var j = 0; j < spinners.length; j++) spinners[j].style.display = 'none';
    } catch (e) { /* noop */ }
  };

  // --- 4) 未捕获异常 / Promise 拒绝 → 强制清 loading ---
  window.addEventListener('error', function (e) {
    console.error('[fix-patch v5.1] window.error:', e && e.message);
    try { window.resetLoading(); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.error('[fix-patch v5.1] unhandledrejection:', e && e.reason && e.reason.message ? e.reason.message : e && e.reason);
    try { window.resetLoading(); } catch (_) {}
  });

  // --- 5) DataLayer.init 再包一层：识别 "已登录但 mode=auth" → 给出明确提示 ---
  var _origInit = DataLayer.init;
  DataLayer.init = async function () {
    var t0 = Date.now();
    var sess = null;
    try { sess = SupaAuth.getSession ? (await SupaAuth.getSession()) : null; } catch (_) {}
    console.info('[fix-patch v5.1] init() START, hasSession=' + !!sess);

    var res;
    try {
      res = await _origInit.apply(DataLayer, arguments);
    } catch (e) {
      console.error('[fix-patch v5.1] DataLayer.init THREW (degraded to local):', e && e.message);
      res = { mode: 'local', degraded: true, initError: e && e.message };
    }
    var ms = Date.now() - t0;
    console.info('[fix-patch v5.1] init() DONE in ' + ms + 'ms, mode=' + res.mode +
      (res.degraded ? ' DEGRADED' : ''));

    // ★ 关键修复：有 session，但 DataLayer.init 返回 mode=auth
    // → 99% 是 profiles RLS 死循环或 profiles 表没创建 handle_new_user 记录
    if (sess && res.mode === 'auth') {
      console.warn('%c[fix-patch v5.1] ⚠️ 登录成功但读不到 profile → 几乎肯定是 profiles RLS 死循环！请在 Supabase SQL Editor 运行 update-v5.sql',
        'background:#ff0;color:#c00;font-weight:bold;font-size:14px');
      if (typeof window.App !== 'undefined' && typeof window.App.toast === 'function') {
        try {
          window.App.toast('登录状态异常：请通知管理员在 Supabase 执行数据库修复脚本（update-v5.sql）', 'error', 8000);
        } catch (_) {}
      } else if (typeof toast === 'function') {
        try { toast('登录状态异常：数据库未更新，请联系管理员', 'error', 8000); } catch (_) {}
      }
    }
    return res;
  };

  console.info('%c[fix-patch v5.1] Applied successfully', 'color:green');
})();
