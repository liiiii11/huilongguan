-- ============================================================
-- v5.6.3 彻底修复：profiles RLS 递归问题
-- 
-- 根因分析：
--   profile_select_v2 策略使用 shop_id IN (SELECT get_my_shop_ids())
--   但 get_my_shop_ids() 函数虽然是 SECURITY DEFINER，
--   但在某些场景下仍可能触发 RLS 检查
--
-- 解决方案：
--   1) 简化 profiles 策略，不再依赖子查询
--   2) 使用 auth.uid() 直接匹配
-- ============================================================

-- STEP 1: 删除当前 profiles 策略
DROP POLICY IF EXISTS "profile_select_v2" ON profiles;
DROP POLICY IF EXISTS "profile_insert_v2" ON profiles;
DROP POLICY IF EXISTS "profile_update_v2" ON profiles;
DROP POLICY IF EXISTS "profile_delete_v2" ON profiles;

-- STEP 2: 简化版 profiles 策略（彻底消除递归）
-- SELECT: 只能看自己的 profile
CREATE POLICY "profile_select_v3" ON profiles FOR SELECT
USING (user_id = auth.uid());

-- INSERT: 只能插自己的
CREATE POLICY "profile_insert_v3" ON profiles FOR INSERT
WITH CHECK (user_id = auth.uid());

-- UPDATE: 只能改自己的（或店长改本店员工）
-- 注意：这里用 is_my_shop_manager() SECURITY DEFINER 函数
CREATE POLICY "profile_update_v3" ON profiles FOR UPDATE
USING (
  user_id = auth.uid()
  OR (shop_id IS NOT NULL AND is_my_shop_manager(shop_id))
)
WITH CHECK (
  user_id = auth.uid()
  OR (shop_id IS NOT NULL AND is_my_shop_manager(shop_id))
);

-- DELETE: 只能店长删
CREATE POLICY "profile_delete_v3" ON profiles FOR DELETE
USING (
  shop_id IS NOT NULL AND is_my_shop_manager(shop_id)
);

-- STEP 3: 验证策略
SELECT '===== profiles v3 策略验证 =====' AS info;

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY cmd;

-- STEP 4: 测试函数是否正常
SELECT 'get_my_shop_ids 测试:' AS test;
SELECT * FROM get_my_shop_ids();

SELECT 'is_my_shop_manager 测试（用一个有效 shop_id 替换）:' AS test;
-- SELECT is_my_shop_manager('00000000-0000-0000-0000-000000000000');

SELECT '✅ v5.6.3 profiles RLS 简化完成' AS result;
