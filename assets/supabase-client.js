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
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    createShop: createShop,
    joinShop: joinShop,
    onAuthChange: onAuthChange
  };
})();
