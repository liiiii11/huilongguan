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

  // 获取当前用户资料（含 shop_id, role）
  async function getProfile() {
    if (!client) return null;
    try {
      var user = await getUser();
      if (!user) return null;
      var result = await client
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .single();
      return result.data;
    } catch (e) {
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

  // 创建新店铺（成为管理员）
  async function createShop(shopName, displayName) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    try {
      var result = await client.rpc('create_shop', {
        p_shop_name: shopName,
        p_display_name: displayName
      });
      return result;
    } catch (e) {
      return { error: e };
    }
  }

  // 加入已有店铺（成为员工）
  async function joinShop(joinCode, displayName) {
    if (!client) return { error: { message: 'Supabase 未初始化' } };
    try {
      var result = await client.rpc('join_shop', {
        p_join_code: joinCode,
        p_display_name: displayName
      });
      return result;
    } catch (e) {
      return { error: e };
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
