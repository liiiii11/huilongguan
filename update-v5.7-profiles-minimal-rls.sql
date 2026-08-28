-- ============================================================
-- v5.7 终极修复：profiles 表 RLS 递归问题
--
-- 根因分析：
--   profiles 表的 RLS 策略 + get_my_shop_ids() 函数
--   形成了隐式的递归调用链
--
-- 解决方案：
--   完全简化 profiles 表的 RLS 策略
--   只允许用户访问自己的 profile（最简单的策略）
--   移除所有涉及 shop_id 的子查询
-- ============================================================

-- STEP 1: 删除所有 profiles 策略
DROP POLICY IF EXISTS "profile_select_v3" ON profiles;
DROP POLICY IF EXISTS "profile_insert_v3" ON profiles;
DROP POLICY IF EXISTS "profile_update_v3" ON profiles;
DROP POLICY IF EXISTS "profile_delete_v3" ON profiles;
DROP POLICY IF EXISTS "profile_select_v2" ON profiles;
DROP POLICY IF EXISTS "profile_insert_v2" ON profiles;
DROP POLICY IF EXISTS "profile_update_v2" ON profiles;
DROP POLICY IF EXISTS "profile_delete_v2" ON profiles;
DROP POLICY IF EXISTS "profile_select_shop" ON profiles;
DROP POLICY IF EXISTS "profile_insert_self" ON profiles;
DROP POLICY IF EXISTS "profile_update_self_or_manager" ON profiles;
DROP POLICY IF EXISTS "profile_delete_manager" ON profiles;

-- STEP 2: 创建极简 profiles 策略（彻底消除递归）
-- 核心原则：profiles 表只能被创建它的用户访问

-- SELECT: 只能看自己的 profile
CREATE POLICY "profile_select_minimal" ON profiles FOR SELECT
  USING (user_id = auth.uid());

-- INSERT: 只能插自己的
CREATE POLICY "profile_insert_minimal" ON profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- UPDATE: 只能改自己的 profile
CREATE POLICY "profile_update_minimal" ON profiles FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- DELETE: 只能删自己的 profile
CREATE POLICY "profile_delete_minimal" ON profiles FOR DELETE
  USING (user_id = auth.uid());

-- STEP 3: 验证
SELECT '===== profiles 极简 RLS 验证 =====' AS info;

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY cmd;

-- STEP 4: 现在需要确保其他表的函数
-- 如果其他表（staff, records, types, subtypes）的策略使用了 get_my_shop_ids()
-- 这些函数是 SECURITY DEFINER，应该可以正常工作

-- 测试函数是否正常
SELECT 'get_my_shop_ids 测试:' AS test;
SELECT * FROM get_my_shop_ids();

SELECT 'is_my_shop_manager 测试:' AS test;
-- 用一个有效的 shop_id 测试
-- SELECT is_my_shop_manager('00000000-0000-0000-0000-000000000000');

SELECT '✅ v5.7 profiles 极简 RLS 完成' AS result,
       '策略已简化为仅允许用户访问自己的 profile' AS detail;
