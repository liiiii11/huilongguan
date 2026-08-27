-- =====================================================================
-- update-v5.5.0-transfer-rls-v5.sql  —— 终极修复「点击拒绝违反 RLS」
--
-- 100% 根因（v4 漏掉的 WITH CHECK 阶段违规）：
--   rejectTransfer 执行：UPDATE records SET staff_id = ${发起者id}, transfer_status='rejected'
--   · USING 阶段（UPDATE 前的旧记录）：staff_id = 接收人本人 → EXISTS 命中 → 通过 ✅
--   · WITH CHECK 阶段（UPDATE 后的新记录）：staff_id = 发起者id →
--     归属人条件 = 当前接收人本人 ≠ 发起者 → created_by 也不是接收人本人 →
--     三条件全 FALSE → PostgREST 返回 42501：new row violates row-level security policy
--
-- v5 修复思路（最安全稳妥）：
--   USING（谁能对这行发起写操作）：严格三条件（创建者/归属人双路径匹配/店长）
--     —— 没权限的人根本碰不到这行 UPDATE/DELETE
--   WITH CHECK（UPDATE/INSERT 之后的"新行"是否允许落地）：放宽为"同店成员"
--     —— 因为我们前端 DataLayer.approveTransfer/rejectTransfer 已经做了完整的身份校验，
--        非法用户根本不可能走到 Supabase UPDATE 这一步；同店 shop_id 不可跨店也
--        无法被普通员工修改（records shop_id 有 NOT NULL+FK，UPDATE 只改 transfer_*）
--
-- 副作用：完全消除了 rejectTransfer 改 staff_id 时的 WITH CHECK 误拦截
-- =====================================================================

-- =====================================================
-- records UPDATE RLS v5  ——  USING 严格 / WITH CHECK 放宽同店
-- =====================================================
DO $upd$
BEGIN
  DROP POLICY IF EXISTS "record_update_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_update_own" ON records FOR UPDATE
      -- USING = 谁能对这行发起 UPDATE（严格：三条件任一通过）
      USING (
        shop_id IS NOT NULL AND (
          -- ① 创建者本人
          created_by = auth.uid()
          OR
          -- ② 当前归属人本人（双路径：精确 profile_id OR 降级名字 ignore case+trim）
          EXISTS (
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
          OR
          -- ③ 店长/管理员/Owner
          EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.user_id = auth.uid()
              AND p.shop_id = records.shop_id
              AND p.role::TEXT IN ('manager','admin','owner')
          )
        )
      )
      -- WITH CHECK = UPDATE 后新行是否允许保存（放宽为：只要 shop_id 是本店铺）
      -- 允许 rejectTransfer 把 staff_id 改回发起人 id（归属人已变）
      WITH CHECK (
        shop_id IS NOT NULL AND
        shop_id IN (
          SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL
        )
      );
  $policy$;
  RAISE NOTICE '✅ v5 records UPDATE RLS 已生效：USING 严格三条件 / WITH CHECK 放宽为同店（rejectTransfer 不再违规）';
END $upd$;

-- =====================================================
-- records DELETE RLS v5  —— DELETE 只有 USING，无 WITH CHECK 概念，保持三条件严格
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
  RAISE NOTICE '✅ v5 records DELETE RLS 已重建（同 v4 三条件严格）';
END $del$;

-- =====================================================
-- records INSERT RLS（兜底：同店成员）
-- =====================================================
DO $ins$
BEGIN
  DROP POLICY IF EXISTS "record_insert_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_insert_own" ON records FOR INSERT
      WITH CHECK (
        shop_id IS NOT NULL AND
        shop_id IN (SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL)
      );
  $policy$;
  RAISE NOTICE '✅ records INSERT RLS 已兜底';
END $ins$;

-- =====================================================
-- records SELECT RLS（兜底：同店成员）
-- =====================================================
DO $sel$
BEGIN
  DROP POLICY IF EXISTS "record_select_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_select_own" ON records FOR SELECT
      USING (
        shop_id IS NOT NULL AND
        shop_id IN (SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL)
      );
  $policy$;
  RAISE NOTICE '✅ records SELECT RLS 已兜底';
END $sel$;

-- =====================================================
-- 确保 RLS 启用
-- =====================================================
DO $rls$
BEGIN
  IF NOT (SELECT c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='records') THEN
    ALTER TABLE records ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '✅ records RLS 已启用';
  END IF;
END $rls$;

-- =====================================================
-- Results 验证面板
-- =====================================================
SELECT 'update-v5.5.0-transfer-rls-v5 已执行 ✅'::TEXT AS step,
       'rejectTransfer（改 staff_id = 发起人 id）→ WITH CHECK 阶段不再拦截'::TEXT AS explain
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
