/**
 * Supabase 客户端封装
 * 处理认证、店铺创建/加入、会话管理
 */
var SupaAuth = (function () {
  'use strict';

  var client = null;

  // 初始化客户端
  function init() {
    if (!isSupabaseConfigured()) return false;
    if (client) return true;
    try {
      client = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          storageKey: 'sales_tracker_auth'
        }
      });
      return true;
    } catch (e) {
      console.error('Supabase init error:', e);
      return false;
    }
  }

  function getClient() { return client; }

  // 获取当前会话
  async function getSession() {
    if (!client) return null;
    try {
      var result = await client.auth.getSession();
      return result.data.session;
    } catch (e) {
      return null;
    }
  }

  // 获取当前用户
  async function getUser() {
    if (!client) return null;
    try {
      var result = await client.auth.getUser();
      return result.data.user;
    } catch (e) {
      return null;
    }
  }

  // 获取当前用户资料（含 shop_id, role）—— v5-fix：错误不再静默吞掉，打印详细原因
  async function getProfile() {
    if (!client) return null;
    try {
      var user = await getUser();
      if (!user) {
        console.warn('[SupaAuth.getProfile] no user from getUser() → return null');
        return null;
      }
      var result = await client
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .single();
      if (result && result.error) {
        console.error('[SupaAuth.getProfile] SELECT profiles ERROR:',
          'code=' + result.error.code,
          'msg=' + result.error.message,
          'details=' + (result.error.details || ''),
          'hint=' + (result.error.hint || ''));
        return null;
      }
      if (!result || !result.data) {
        console.warn('[SupaAuth.getProfile] no row for user_id=' + user.id +
          ' → profiles 记录未创建？请检查 handle_new_user trigger 或 RLS SELECT 策略');
        return null;
      }
      return result.data;
    } catch (e) {
      // v5-fix：原来是 silent return null，会让"为什么读不到 profile"完全无法排查
      console.error('[SupaAuth.getProfile] THREW (likely RLS or network):',
        e && e.message ? e.message : e,
        e && e.stack ? e.stack : '');
      return null;
    }
  }

  // 注册
  async function signUp(email, password, displayName) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    var result = await client.auth.signUp({
      email: email,
      password: password,
      options: { data: { display_name: displayName } }
    });
    return result;
  }

  // 登录
  async function signIn(email, password) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    var result = await client.auth.signInWithPassword({
      email: email,
      password: password
    });
    return result;
  }

  // 退出登录
  async function signOut() {
    if (!client) return;
    try {
      await client.auth.signOut();
    } catch (e) {
      console.error('Sign out error:', e);
    }
  }

  // ===== v5.4-fix: 兜底重建当前用户 profiles 记录 =====
  // 场景：后台手动删除了 profiles 里该员工，但 auth.users 还存在
  //       → 登录成功但 getProfile 返回 null → mode='auth' → 前端无法正常进入
  // 解决：登录成功后检测到 profiles 不存在，自动 INSERT 一条最小化 profile
  //       (shop_id=NULL, role='staff')，之后 initAfterAuth 会进入 setup 页（加入店铺/创建店铺）
  async function ensureProfileForCurrentUser() {
    if (!client) return { data: null, error: { message: 'Supabase 未初始化' } };
    try {
      var user = await getUser();
      if (!user) return { data: null, error: { message: '当前未登录' } };

      // 1) 先确认真的没有（避免并发调用重复插入）
      var existResult = await client
        .from('profiles')
        .select('*')
        .eq('user_id', user.id);
      if (existResult && !existResult.error && existResult.data && existResult.data.length > 0) {
        return { data: existResult.data[0], existed: true };
      }

      var displayName = '';
      try { displayName = (user.raw_user_meta_data && user.raw_user_meta_data.display_name) || user.email || user.phone || '新用户'; } catch (_) {}
      var userEmail = '';
      try { userEmail = user.email || ''; } catch (_) {}

      // 2) 三次降级 INSERT，兼容不同列版本的 profiles 表
      //    第一级：尝试包含 email 的完整插入
      //    第二级：只包含 schema-fix-patch.sql 里确认存在的 4 列（user_id/display_name/role/shop_id）
      //    第三级：最小化插入（仅 user_id + display_name，和 join_shop/create_shop RPC 写 INSERT 一致，100% 列存在）
      var triedCols = [];
      var insertTries = [
        { cols: ['user_id','display_name','role','shop_id','email'],
          row:  { user_id: user.id, display_name: displayName, role: 'staff', shop_id: null, email: userEmail } },
        { cols: ['user_id','display_name','role','shop_id'],
          row:  { user_id: user.id, display_name: displayName, role: 'staff', shop_id: null } },
        { cols: ['user_id','display_name'],
          row:  { user_id: user.id, display_name: displayName } }
      ];

      var lastErr = null;
      for (var i = 0; i < insertTries.length; i++) {
        var t = insertTries[i];
        triedCols = t.cols;
        try {
          var ins = await client
            .from('profiles')
            .insert(t.row)
            .select('*')
            .single();
          if (ins && !ins.error && ins.data) {
            console.info('[SupaAuth.ensureProfile] 重建 profiles 成功 (tier=' + (i+1) + '/3, cols=' + t.cols.join(','));
            return { data: ins.data, existed: false, tier: i+1, triedCols: t.cols };
          }
          if (ins && ins.error) lastErr = ins.error;
        } catch (eInsert) {
          lastErr = eInsert;
        }
        // 最后一级尝试失败也会退出循环
      }

      // 到这里：三次插入都失败。极大概率是 profiles 表缺少 INSERT RLS policy（用户自己 INSERT 自己的记录被拒绝）
      var msg = 'profiles 记录缺失，自动重建失败';
      if (lastErr && lastErr.message) msg += '：' + lastErr.message;
      if (lastErr && (lastErr.code === '42501' || /policy|denied|permission/i.test(lastErr.message || ''))) {
        msg += '（原因：缺少 profiles INSERT RLS 策略，请在 Supabase 执行 update-v5.4.3 补丁 SQL）';
      }
      console.error('[SupaAuth.ensureProfile] 全部 3 级兜底插入都失败。最后一次 cols=' + triedCols.join(','),
        lastErr && (lastErr.message || lastErr));
      return { data: null, error: { message: msg, cause: lastErr, needsSql: true } };
    } catch (e) {
      var ne = _normError(e);
      console.error('[SupaAuth.ensureProfile] THREW:', ne.message);
      return { data: null, error: ne };
    }
  }

  // ===== v5.4.4-fix: 发送密码重置邮件（忘记密码） =====
  async function resetPassword(email) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    try {
      // redirectTo：重置链接跳回本网站主页，页面加载时检测 recovery token 弹改密框
      var siteUrl = (window && window.location && window.location.origin)
        ? window.location.origin + (window.location.pathname || '/')
        : null;
      var opts = siteUrl ? { redirectTo: siteUrl } : {};
      var result = await client.auth.resetPasswordForEmail(email, opts);
      if (result && result.error) {
        console.error('[SupaAuth.resetPassword] ERROR:', result.error.code, result.error.message);
      }
      return result;
    } catch (e) {
      var ne = _normError(e);
      console.error('[SupaAuth.resetPassword] THREW:', ne.message);
      return { error: ne };
    }
  }

  // ===== v5.4.4-fix: 用户已进入 recovery 状态（URL 含 recovery token 已生效），设置新密码 =====
  async function updateUserPassword(newPassword) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    try {
      var result = await client.auth.updateUser({ password: newPassword });
      if (result && result.error) {
        console.error('[SupaAuth.updateUserPassword] ERROR:', result.error.code, result.error.message);
      }
      return result;
    } catch (e) {
      var ne = _normError(e);
      console.error('[SupaAuth.updateUserPassword] THREW:', ne.message);
      return { error: ne };
    }
  }

  // ===== v5.4.4-fix: 读取当前 URL hash 中的 Supabase Auth event/access_token =====
  //        Supabase 重置链接跳转回网站时会把 access_token+type=recovery 放在 # 后面
  function getRecoveryTokenFromUrl() {
    try {
      if (!window || !window.location || !window.location.hash) return null;
      // hash 形如 #access_token=...&refresh_token=...&expires_in=...&token_type=bearer&type=recovery
      var hash = window.location.hash.replace(/^#/, '');
      if (!hash) return null;
      var params = {};
      hash.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i <= 0) return;
        params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
      });
      if (params.type === 'recovery' && params.access_token) {
        return { accessToken: params.access_token, params: params };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 把 RPC 抛出的各种异常统一规范化为带 message 的 Error，保证前端可以直接 .message 访问
  function _normError(e) {
    if (!e) return { message: '未知错误' };
    if (typeof e === 'string') return { message: e };
    if (e.message) return e; // 本身就是 Error / Supabase PostgrestError
    return { message: JSON.stringify(e) };
  }

  // 创建新店铺（成为管理员）—— v5-fix：catch 时打印错误 + 规范化 error 对象
  async function createShop(shopName, displayName) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    try {
      var result = await client.rpc('create_shop', {
        p_shop_name: shopName,
        p_display_name: displayName
      });
      if (result && result.error)
        console.error('[SupaAuth.createShop] RPC ERROR:', result.error.code, result.error.message, result.error.details);
      return result;
    } catch (e) {
      var ne = _normError(e);
      console.error('[SupaAuth.createShop] THREW:', ne.message, e && e.stack);
      return { error: ne };
    }
  }

  // 加入已有店铺（成为员工）—— v5-fix：catch 时打印错误 + 规范化 error 对象
  async function joinShop(joinCode, displayName) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    try {
      var result = await client.rpc('join_shop', {
        p_join_code: joinCode,
        p_display_name: displayName
      });
      if (result && result.error)
        console.error('[SupaAuth.joinShop] RPC ERROR:', result.error.code, result.error.message, result.error.details);
      return result;
    } catch (e) {
      var ne2 = _normError(e);
      console.error('[SupaAuth.joinShop] THREW:', ne2.message, e && e.stack);
      return { error: ne2 };
    }
  }

  // 监听认证状态变化
  function onAuthChange(callback) {
    if (!client) return;
    client.auth.onAuthStateChange(callback);
  }

  return {
    init: init,
    getClient: getClient,
    getSession: getSession,
    getUser: getUser,
    getProfile: getProfile,
    ensureProfileForCurrentUser: ensureProfileForCurrentUser,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    resetPassword: resetPassword,
    updateUserPassword: updateUserPassword,
    getRecoveryTokenFromUrl: getRecoveryTokenFromUrl,
    createShop: createShop,
    joinShop: joinShop,
    onAuthChange: onAuthChange
  };
})();
