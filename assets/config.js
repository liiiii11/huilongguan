/**
 * Supabase 配置
 *
 * 设置方法：
 * 1. 访问 https://supabase.com 注册并创建新项目
 * 2. 在项目 Dashboard > Settings > API 中找到：
 *    - Project URL（项目地址）
 *    - anon public key（公开匿名密钥）
 * 3. 将下面的值替换为你的项目信息
 *
 * 注意：anon key 是公开密钥，配合 RLS 策略使用是安全的，
 *       但绝不要在这里放入 service_role key！
 */
var SUPABASE_CONFIG = {
  url: 'https://owwfegsopyiwyunfiupo.supabase.co',
  anonKey: 'sb_publishable_NiibITtIAR4LOBTCgYIeqw_ktAmwHVC'
};

// 检查是否已配置 Supabase
function isSupabaseConfigured() {
  return SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey &&
    SUPABASE_CONFIG.url.indexOf('supabase.co') >= 0;
}
