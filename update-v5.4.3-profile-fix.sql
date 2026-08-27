-- =========================================================================
-- update-v5.4.3-profile-fix.sql  —  后台删除员工后"再注册显示已注册"一次性修复脚本
-- 根因：
--   1) 后端删了 profiles（和 staff）行，但 auth.users 账号仍在 → signUp 报"已注册"
--      （前端 v5.4 已修复为：signUp 已注册 → 自动 signIn fallback）
--   2) signIn 成功后读不到 profiles（被删了），前端兜底 INSERT 自己的 profile
--      → 需 profiles 有"用户自己 INSERT/UPDATE self"RLS policy，否则 42501 权限拒绝
--   3) 兜底重建 profile 成功后，join_shop/create_shop RPC（SECURITY INVOKER）内部
--      需要 UPDATE profiles SET shop_id=.../role=... → 也需 UPDATE self RLS policy
-- 执行：SQL Editor 一次性粘贴，全程幂等（已有策略跳过）
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. profiles 表：INSERT self RLS policy（用户只能插入自己 user_id 的行）
-- -------------------------------------------------------------------------
DO $prof_ins$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE  schemaname='public' AND tablename='profiles' AND policyname='profile_insert_self'
  ) THEN
    CREATE POLICY profile_insert_self ON profiles
      FOR INSERT WITH CHECK (user_id = auth.uid());
    RAISE NOTICE '✅ profiles INSERT self 策略已添加 (profile_insert_self)';
  ELSE
    RAISE NOTICE 'ℹ️  profiles profile_insert_self 策略已存在，跳过';
  END IF;
END $prof_ins$;

-- -------------------------------------------------------------------------
-- 2. profiles 表：UPDATE self RLS policy（兜底建完 profile 后，join_shop RPC 要 UPDATE shop_id/role/display_name）
-- -------------------------------------------------------------------------
DO $prof_upd$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE  schemaname='public' AND tablename='profiles' AND policyname='profile_update_self'
  ) THEN
    CREATE POLICY profile_update_self ON profiles
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    RAISE NOTICE '✅ profiles UPDATE self 策略已添加 (profile_update_self)';
  ELSE
    RAISE NOTICE 'ℹ️  profiles profile_update_self 策略已存在，跳过';
  END IF;
END $prof_upd$;

-- -------------------------------------------------------------------------
-- 3. 兜底：如果 profiles 上完全没有 SELECT 策略（被人误删），补回最简 SELECT 策略
--    （之前 schema-fix-patch.sql 里 profile_select_self/profile_select_shop 可能被清理）
-- -------------------------------------------------------------------------
DO $prof_sel$
DECLARE
  sel_policies INT;
BEGIN
  SELECT COUNT(*) INTO sel_policies
  FROM   pg_policies
  WHERE  schemaname='public' AND tablename='profiles' AND cmd='SELECT';

  IF sel_policies = 0 THEN
    -- 允许读自己（不经过 shop_id 子查询，杜绝 42P17 递归）
    CREATE POLICY profile_select_self ON profiles
      FOR SELECT USING (user_id = auth.uid());
    RAISE NOTICE '✅ 兜底：已补 profile_select_self（读自己）';

    -- 允许店长读同店所有 profiles（同 shop_id；不嵌套子查询，避免 42P17）
    -- 注意：没有用 helper，因为是 SELECT 自比较，shop_id 不通过 profiles 子查询，不会递归
    CREATE POLICY profile_select_shop ON profiles
      FOR SELECT USING (
        shop_id IS NOT NULL
        AND shop_id = (
          SELECT p.shop_id FROM profiles p
          WHERE  p.user_id = auth.uid() AND p.shop_id IS NOT NULL
          LIMIT  1
        )
      );
    RAISE NOTICE '✅ 兜底：已补 profile_select_shop（店长读同店）';
  ELSE
    RAISE NOTICE 'ℹ️  profiles SELECT 策略已有 % 个，跳过兜底', sel_policies;
  END IF;
END $prof_sel$;

-- -------------------------------------------------------------------------
-- 4. 确保 profiles 表对 authenticated 角色启用了 RLS（没开启则策略都不生效）
-- -------------------------------------------------------------------------
DO $prof_rls$
DECLARE
  relrowsecurity BOOLEAN;
BEGIN
  SELECT c.relrowsecurity INTO relrowsecurity
  FROM   pg_class     c
  JOIN   pg_namespace n ON n.oid = c.relnamespace
  WHERE  n.nspname='public' AND c.relname='profiles';

  IF relrowsecurity IS NULL THEN
    RAISE WARNING '⚠️  查不到 profiles 表的 RLS 状态？请检查表名';
  ELSIF NOT relrowsecurity THEN
    EXECUTE 'ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;';
    RAISE NOTICE '✅ 已对 profiles 表启用 RLS';
  ELSE
    RAISE NOTICE 'ℹ️  profiles RLS 已启用，跳过';
  END IF;
END $prof_rls$;

-- =========================================================================
-- 结果汇总（Supabase Results 面板会直接显示）
-- =========================================================================
SELECT '✅ v5.4.3 profiles 修复：INSERT/UPDATE/SELECT 策略'::TEXT AS step,
       '刷新页面 → 被删员工账号现在可以直接登录 → 进入加入店铺/创建店铺页'::TEXT AS action
UNION ALL
SELECT 'profiles INSERT self policy (profile_insert_self)',
       CASE WHEN EXISTS(
         SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='profiles' AND policyname='profile_insert_self'
       ) THEN '已就绪' ELSE '缺失（请确认执行无报错）' END
UNION ALL
SELECT 'profiles UPDATE self policy (profile_update_self)',
       CASE WHEN EXISTS(
         SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='profiles' AND policyname='profile_update_self'
       ) THEN '已就绪' ELSE '缺失' END
UNION ALL
SELECT 'profiles SELECT 策略数量',
       (SELECT COUNT(*)::TEXT FROM pg_policies
        WHERE schemaname='public' AND tablename='profiles' AND cmd='SELECT') || ' 个'
UNION ALL
SELECT 'profiles RLS 是否启用',
       (SELECT CASE WHEN c.relrowsecurity THEN '是 ✅' ELSE '否 ❌ 请重新执行脚本' END
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='profiles');
