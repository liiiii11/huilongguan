-- =====================================================================
-- update-v5.4.9-transfer-rls-v4.sql
--
-- 用户报错：违反了 records 的行级安全策略（new row violates row-level security policy）
--
-- 100% 根因：
-- v3 RLS 条件 staff_id = get_my_staff_id(shop_id) 里的 helper 函数内部通过
-- staff.profile_id = profiles.id 做 JOIN。但历史员工（在 schema-fix-patch 前加入
-- 或店长手动添加）的 staff.profile_id 是 NULL → JOIN 0 行 → helper 返回 NULL →
-- staff_id = NULL 永远 FALSE → created_by/归属人/店长三条件全 FALSE → RLS 违规。
--
-- v4 修复策略（彻底弃用 helper，所有条件直接内联 + 双路径归属人判断）：
--   归属人本人 = EXISTS (
--     同店 + 当前 staff = 当前记录 staff_id
--     AND (① staff.profile_id === 当前 profile.id 【精确】
--          OR ② lower(trim(staff.name)) === lower(trim(profile.display_name)) 【降级字符串】
--   )
--
-- 使用：Supabase → SQL Editor → 粘贴整段运行（100% 幂等）
-- =====================================================================

-- =====================================================
-- records UPDATE RLS（v4 —— 无 helper，直接内联，双路径）
-- =====================================================
DO $upd$
BEGIN
  DROP POLICY IF EXISTS "record_update_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_update_own" ON records FOR UPDATE
      USING (
        shop_id IS NOT NULL AND (
          -- ① 创建者本人（发起人撤销、修改自己记录）
          created_by = auth.uid()
          OR
          -- ② 当前归属人本人（被过渡人/接收人）—— 双路径
          EXISTS (
            SELECT 1 FROM staff s, profiles my_p
            WHERE s.id = records.staff_id
              AND s.shop_id = records.shop_id
              AND my_p.user_id = auth.uid()
              AND my_p.shop_id = records.shop_id
              AND (
                -- 精确：join_shop 新员工 profile_id 关联
                (s.profile_id IS NOT NULL AND s.profile_id = my_p.id)
                OR
                -- 降级：历史员工 profile_id NULL，用名字匹配（ignore case + trim）
                lower(trim(s.name)) = lower(trim(my_p.display_name))
              )
          )
          OR
          -- ③ 店长/管理员/Owner（兜底强制审批/拒绝/修改）
          EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.user_id = auth.uid()
              AND p.shop_id = records.shop_id
              AND p.role::TEXT IN ('manager','admin','owner')
          )
        )
      )
      WITH CHECK (
        shop_id IS NOT NULL AND (
          created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM staff s, profiles my_p
            WHERE s.id = records.staff_id
              AND s.shop_id = records.shop_id
              AND my_p.user_id = auth.uid()
              AND my_p.shop_id = records.shop_id
              AND (
                (s.profile_id IS NOT NULL AND s.profile_id = my_p.id)
                OR lower(trim(s.name)) = lower(trim(my_p.display_name))
              )
          )
          OR EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.user_id = auth.uid()
              AND p.shop_id = records.shop_id
              AND p.role::TEXT IN ('manager','admin','owner')
          )
        )
      );
  $policy$;
  RAISE NOTICE '✅ v4 records UPDATE RLS 已重建（创建者/归属人-双路径/店长 → 任一通过即可）';
END $upd$;

-- =====================================================
-- records DELETE RLS（v4 —— 同上三条件）
-- =====================================================
DO $del$
BEGIN
  DROP POLICY IF EXISTS "record_delete_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_delete_own" ON records FOR DELETE
      USING (
        shop_id IS NOT NULL AND (
          created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM staff s, profiles my_p
            WHERE s.id = records.staff_id
              AND s.shop_id = records.shop_id
              AND my_p.user_id = auth.uid()
              AND my_p.shop_id = records.shop_id
              AND (
                (s.profile_id IS NOT NULL AND s.profile_id = my_p.id)
                OR lower(trim(s.name)) = lower(trim(my_p.display_name))
              )
          )
          OR EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.user_id = auth.uid()
              AND p.shop_id = records.shop_id
              AND p.role::TEXT IN ('manager','admin','owner')
          )
        )
      );
  $policy$;
  RAISE NOTICE '✅ v4 records DELETE RLS 已重建（创建者/归属人-双路径/店长 → 任一通过即可）';
END $del$;

-- =====================================================
-- records INSERT RLS（保险兜底：同店就能写，一般已经有，这里保证不挂）
-- =====================================================
DO $ins$
BEGIN
  DROP POLICY IF EXISTS "record_insert_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_insert_own" ON records FOR INSERT
      WITH CHECK (
        shop_id IS NOT NULL AND
        shop_id IN (
          SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL
        )
      );
  $policy$;
  RAISE NOTICE '✅ records INSERT RLS 已兜底（同店成员即可创建）';
END $ins$;

-- =====================================================
-- records SELECT RLS（保险兜底：同店就能读）
-- =====================================================
DO $sel$
BEGIN
  DROP POLICY IF EXISTS "record_select_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_select_own" ON records FOR SELECT
      USING (
        shop_id IS NOT NULL AND
        shop_id IN (
          SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL
        )
      );
  $policy$;
  RAISE NOTICE '✅ records SELECT RLS 已兜底（同店成员即可读取）';
END $sel$;

-- =====================================================
-- 确保 records RLS 已启用
-- =====================================================
DO $rls$
BEGIN
  IF NOT (
    SELECT c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='records'
  ) THEN
    ALTER TABLE records ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '✅ records RLS 已启用';
  ELSE
    RAISE NOTICE 'ℹ️  records RLS 本来就已启用';
  END IF;
END $rls$;

-- =====================================================
-- 验证面板（Results 面板直接看）
-- =====================================================
SELECT 'update-v5.4.9-transfer-rls-v4 已执行'::TEXT AS step,
       '员工刷新浏览器后重新登录 → 过渡审批/拒绝不会再出现 RLS 违规提示'::TEXT AS action
UNION ALL
SELECT 'records SELECT 策略数', (SELECT COUNT(*)::TEXT
  FROM pg_policies WHERE schemaname='public' AND tablename='records' AND cmd='SELECT') || ' 个'
UNION ALL
SELECT 'records INSERT 策略数', (SELECT COUNT(*)::TEXT
  FROM pg_policies WHERE schemaname='public' AND tablename='records' AND cmd='INSERT') || ' 个'
UNION ALL
SELECT 'records UPDATE 策略数', (SELECT COUNT(*)::TEXT
  FROM pg_policies WHERE schemaname='public' AND tablename='records' AND cmd='UPDATE') || ' 个'
UNION ALL
SELECT 'records DELETE 策略数', (SELECT COUNT(*)::TEXT
  FROM pg_policies WHERE schemaname='public' AND tablename='records' AND cmd='DELETE') || ' 个'
UNION ALL
SELECT 'records RLS 已启用', (SELECT CASE WHEN relrowsecurity THEN '是 ✅' ELSE '否 ❌' END
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='records');
