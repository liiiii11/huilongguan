-- ============================================================
--  紧急修复补丁：删除 profiles / 所有表中旧的递归 RLS policy
--  直接导致：42P17 infinite recursion detected in policy for relation "profiles"
--  使用方法：Supabase SQL Editor 中全选复制，Run
--  运行后再执行 pg_policies 验证查询，确认旧 policy 已消失
-- ============================================================

-- 1) profiles 表：删除所有旧的、含递归子查询的 policy（保留 update-v5.sql 里的非递归版本）
--    - profile_select_own 是元凶：qual 里有 shop_id IN (SELECT ... FROM profiles)
--    - profile_update_own 也有同样的递归结构
DROP POLICY IF EXISTS profile_select_own ON public.profiles;
DROP POLICY IF EXISTS profile_update_own ON public.profiles;

-- 保险起见：删除其他表中可能存在的同模式旧递归 policy，避免之后查询其他表时也报 42P17
DROP POLICY IF EXISTS shop_select_own ON public.shops;
DROP POLICY IF EXISTS shop_update_own ON public.shops;

DROP POLICY IF EXISTS staff_select_own ON public.staff;
DROP POLICY IF EXISTS staff_insert_own ON public.staff;
DROP POLICY IF EXISTS staff_update_own ON public.staff;
DROP POLICY IF EXISTS staff_delete_own ON public.staff;

DROP POLICY IF EXISTS type_select_own ON public.types;
DROP POLICY IF EXISTS type_insert_own ON public.types;
DROP POLICY IF EXISTS type_update_own ON public.types;
DROP POLICY IF EXISTS type_delete_own ON public.types;

DROP POLICY IF EXISTS subtype_select_own ON public.subtypes;
DROP POLICY IF EXISTS subtype_insert_own ON public.subtypes;
DROP POLICY IF EXISTS subtype_update_own ON public.subtypes;
DROP POLICY IF EXISTS subtype_delete_own ON public.subtypes;

DROP POLICY IF EXISTS record_select_own ON public.records;
DROP POLICY IF EXISTS record_insert_own ON public.records;
DROP POLICY IF EXISTS record_update_own ON public.records;
DROP POLICY IF EXISTS record_delete_own ON public.records;

DROP POLICY IF EXISTS transfer_select_own ON public.transfers;
DROP POLICY IF EXISTS transfer_insert_own ON public.transfers;
DROP POLICY IF EXISTS transfer_update_own ON public.transfers;

-- ============================================================
--  运行完成后，立即执行以下验证 SQL 确认结果：
--  SELECT policyname, tablename, cmd, qual FROM pg_policies
--   WHERE tablename = 'profiles' ORDER BY policyname;
--
--  期望结果：profiles 表仅剩 3 条 SELECT/INSERT/UPDATE policy：
--    profile_select_self      SELECT  qual=(user_id = auth.uid())
--    profile_select_shop      SELECT  qual=(shop_id = get_my_shop_id())
--    profile_insert_self      INSERT  with_check=(user_id = auth.uid())
--    profile_update_self      UPDATE  qual=(user_id = auth.uid())
--  → 再也不应该出现 "profile_select_own"、"shop_id IN (SELECT" 字样
-- ============================================================
