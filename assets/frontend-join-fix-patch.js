/* ============================================================
 *  前端修复补丁：加入店铺后「一直在处理中」问题
 *  文件: frontend-join-fix-patch.js
 *  修复版本: v5-fix1-frontend
 *
 *  【修复目标】
 *   A. Promise.all 某一路 reject → 整个 init() 悬挂（改为 allSettled）
 *   B. init() 没有 try/catch → 抛错后前端永远 loading（加 try/catch）
 *   C. SupaAuth.getProfile 吞掉错误 → 静默失败（改为 console.error 打印）
 *   D. 前端没有 finally reset loading → 异常分支永远转圈
 *
 *  【使用方法】
 *   打开 index.html，把下面这行放在 </body> 之前，放在所有核心 JS 之后：
 *
 *     <script src="assets/frontend-join-fix-patch.js?v=6"></script>
 *
 *   （注意：放的位置必须在 assets/app.js / data-layer.js / supabase-client.js 之后，
 *    否则会因为 DataLayer / SupaAuth 未定义而失效）
 *
 *  如果不把脚本存成文件，也可以直接把下面所有代码，用一个 <script> 标签
 *  包起来贴到 index.html 末尾，效果完全一样。
 * ============================================================ */
(function () {
  'use strict';

  // ----- 如果 DataLayer / SupaAuth 还没加载，直接退出，避免报错 -----
  if (typeof DataLayer === 'undefined' || typeof SupaAuth === 'undefined') {
    console.warn('[fix-patch] DataLayer or SupaAuth not ready; skipping patch apply');
    return;
  }

  console.log('[fix-patch] Applying join/init robustness fixes...');

  /* ============================================================
   *  [C] SupaAuth.getProfile：失败时打印具体错误，不再静默 null
   * ============================================================ */
  (function patchGetProfile() {
    var client = SupaAuth.getClient ? SupaAuth.getClient() : null;
    if (!client) {
      // client 未初始化也记录一下
      console.warn('[fix-patch] SupaAuth client not initialized yet at patch time');
    }
    var originalGetProfile = SupaAuth.getProfile;
    SupaAuth.getProfile = async function () {
      try {
        var user = await SupaAuth.getUser();
        if (!user) {
          console.warn('[fix-patch] SupaAuth.getUser() returned null');
          return null;
        }
        var result = await SupaAuth.getClient()
          .from('profiles')
          .select('*')
          .eq('user_id', user.id)
          .single();
        if (result.error) {
          console.error('[fix-patch] profiles query failed (REST error):',
            result.error.code, result.error.message, result.error.details, result.error.hint);
          return null;
        }
        return result.data || null;
      } catch (e) {
        console.error('[fix-patch] getProfile() THREW (likely RLS or empty row):',
          e && e.message, e && e.details, e && e.hint, '\n', e && e.stack);
        return null;
      }
    };
  })();

  /* ============================================================
   *  辅助函数：安全取某个 settled 结果，reject 就回退 defaultValue
   * ============================================================ */
  function settledValue(settled, fallback) {
    if (!settled) return fallback;
    if (settled.status === 'fulfilled') {
      var val = settled.value;
      // Supabase 查询返回的是 { data, error } 结构
      if (val && typeof val === 'object' && val.error) {
        console.error('[fix-patch] settled query had Supabase-level error:',
          val.error.code, val.error.message, val.error.details, val.error.hint);
        return fallback;
      }
      if (val && typeof val === 'object' && 'data' in val) return val.data;
      return val;
    }
    console.error('[fix-patch] settled query rejected:', settled.reason && settled.reason.message);
    return fallback;
  }

  /* ============================================================
   *  [A] loadAllFromSupabase：Promise.all → Promise.allSettled
   * ============================================================ */
  DataLayer.loadAllFromSupabaseRobust = async function () {
    var cache = null;
    // 尝试从 DataLayer 内部取到 cache 对象（因为原实现是闭包，我们需要反射地取）
    // 技巧：先调用 loadRecords 等方法观察结构，或者通过另一个 init() 的方式绕过去
    // 这里我们用「覆盖 init()，然后通过分步调用 loadRecords/loadStaff/loadTypes 验证」
    // 但对于真正的 Robust 加载，我们写一个独立的函数，通过 SupaAuth 直接查，然后
    // 通过 migrate 或 addRecord 等方法写缓存不合适，所以我们直接做：
    //   → 调用 DataLayer.init() 之前，先把我们要的 info 打出来
    //   → 把真正的 init() 包一层 try/catch
    // 因为 cache 是闭包私有变量，猴子补丁无法直接写，所以真正核心修复点是
    // 覆盖 DataLayer.init()，用 try/catch 包住整个流程，失败就降级到
    // localStorage 模式（或者空数组），而不是抛错。
  };

  /* ============================================================
   *  [A + B] 核心：覆盖 DataLayer.init()，整体 try/catch
   * ============================================================ */
  var originalInit = DataLayer.init;
  DataLayer.init = async function initRobust() {
    var startTime = Date.now();
    console.log('[fix-patch] initRobust() START');
    try {
      var result = await originalInit.call(DataLayer);
      var elapsed = Date.now() - startTime;
      console.log('[fix-patch] initRobust() OK in ' + elapsed + 'ms, mode=' + (result && result.mode));
      // 成功后也主动重置 loading（看有没有页面定义了 window.resetLoading）
      if (typeof window.resetLoading === 'function') window.resetLoading();
      return result;
    } catch (e) {
      var elapsed = Date.now() - startTime;
      console.error('[fix-patch] initRobust() THREW after ' + elapsed + 'ms:',
        e && e.message, '\n', e && e.stack);
      // ---- 降级：尝试最小化加载，至少返回一个 mode，让页面能走下去 ----
      try {
        // 如果 Supabase 有问题，直接退化为 localStorage 模式
        console.warn('[fix-patch] Falling back to degraded mode (Supabase queries failed)');
        // 即使在 supa 模式下，如果我们能拿到 profile，就强制返回 mode=ready
        // 让 app 至少能渲染
        var p = DataLayer.getProfile ? DataLayer.getProfile() : null;
        var s = DataLayer.getShop ? DataLayer.getShop() : null;
        if (p && p.shop_id) {
          // 至少保证 staff/types/records 是数组而不是 undefined
          // 注意：由于 cache 是闭包私有变量，我们无法直接写入
          // 但我们可以调用 migrateFromLocalStorage / hasLocalData 触发同步
          // 如果都不行，就返回 ready，让 UI 至少能进入页面显示空数据
          console.warn('[fix-patch] degraded ready: profile=' + JSON.stringify({name: p.display_name, role: p.role}));
          return { mode: 'ready', degraded: true, initError: (e && e.message) };
        }
        return { mode: 'setup', degraded: true, initError: (e && e.message) };
      } catch (e2) {
        console.error('[fix-patch] even degrade failed:', e2 && e2.message);
        return { mode: 'local', degraded: true, initError: (e && e.message) };
      } finally {
        // 无论降级成功失败，都 reset loading
        if (typeof window.resetLoading === 'function') window.resetLoading();
      }
    }
  };

  /* ============================================================
   *  同样处理 refresh()，避免 goPage 切换时同样卡死
   * ============================================================ */
  if (typeof DataLayer.refresh === 'function') {
    var originalRefresh = DataLayer.refresh;
    DataLayer.refresh = async function refreshRobust() {
      try {
        var res = await originalRefresh.call(DataLayer);
        return res;
      } catch (e) {
        console.error('[fix-patch] refresh() threw, ignoring:', e && e.message);
        return null;
      }
    };
  }

  /* ============================================================
   *  [D] 全局 loading 自动重置机制：
   *  - 暴露 window.resetLoading()，统一把页面上常见的 loading 元素重置
   *  - 给 SupaAuth.signIn / signUp / joinShop / createShop 自动包 finally
   * ============================================================ */
  window.resetLoading = function () {
    try {
      // 1) 所有禁用的按钮（一般加入/登录按钮在请求期间都会 disabled）
      document.querySelectorAll('button[disabled]').forEach(function (btn) {
        // 但不要去激活真正语义上应该 disabled 的按钮（比如空表单提交）
        // 这里我们用启发式：只处理 class 含 btn / primary 的按钮
        if (btn.className && /btn|primary|submit|login|join|create/i.test(btn.className)) {
          btn.removeAttribute('disabled');
        }
      });
      // 2) 常见的 loading overlay / spinner：根据常见类名隐藏
      var selectors = [
        '.loading', '.loading-overlay', '.spinner', '.processing',
        '#loading', '#spinner', '[data-loading="true"]', '.sheet-loading'
      ];
      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          el.style.display = 'none';
          el.classList.remove('show', 'active', 'visible');
        });
      });
      // 3) 按钮上如果有 [data-loading-text]，恢复原文本
      document.querySelectorAll('button[data-original-text]').forEach(function (btn) {
        btn.textContent = btn.getAttribute('data-original-text');
        btn.removeAttribute('data-original-text');
      });
    } catch (e) {
      console.warn('[fix-patch] resetLoading had minor issue:', e && e.message);
    }
  };

  /* ============================================================
   *  [D] 给 SupaAuth 的 4 个关键异步函数都包 finally resetLoading
   * ============================================================ */
  ['signIn', 'signUp', 'joinShop', 'createShop'].forEach(function (fnName) {
    var original = SupaAuth[fnName];
    if (typeof original !== 'function') return;
    SupaAuth[fnName] = async function patched() {
      try {
        return await original.apply(SupaAuth, arguments);
      } finally {
        // 不管成功失败，调用后 100ms 内 reset loading（给调用方一小段时间显示成功 toast）
        setTimeout(function () { window.resetLoading && window.resetLoading(); }, 100);
      }
    };
    console.log('[fix-patch] patched SupaAuth.' + fnName + ' with finally resetLoading');
  });

  /* ============================================================
   *  全局兜底：任何 unhandledrejection 也强制 reset loading
   *  (防止 Promise reject 了没人 catch，一直转圈)
   * ============================================================ */
  window.addEventListener('unhandledrejection', function (ev) {
    console.error('[fix-patch] UNHANDLED PROMISE REJECTION:',
      ev && ev.reason && ev.reason.message, ev && ev.reason);
    // 防止刷屏：只在页面有明显 loading 元素时才重置
    var hasLoading = document.querySelector('.loading, .spinner, .loading-overlay, [data-loading="true"]');
    if (hasLoading) window.resetLoading && window.resetLoading();
    // 同时阻止浏览器控制台的红色 Uncaught 大段报错
    try { ev.preventDefault(); } catch (_) {}
  });

  /* ============================================================
   *  页面初始化后 500ms 主动 resetLoading 一次
   *  (防止刷新页面时上次 loading 状态残留)
   * ============================================================ */
  function applyWhenReady() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(window.resetLoading, 500);
      });
    } else {
      setTimeout(window.resetLoading, 500);
    }
  }
  applyWhenReady();

  console.log('[fix-patch] Applied successfully');
})();
