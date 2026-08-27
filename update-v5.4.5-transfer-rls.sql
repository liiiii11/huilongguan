-- =====================================================================
-- update-v5.4.5-transfer-rls.sql (v3 — 修复 role 是 ENUM 类型导致 lower() 报错)
-- 解决：「对方审批后，我这边还是待审批；对方刷新后又显示待审批」
--
-- 报错：function lower(app_role) does not exist
-- 原因：profiles.role 列可能是自定义 ENUM 类型（如 CREATE TYPE app_role AS ENUM(...)）
--       lower() 仅支持 text/varchar，不支持自定义 enum。
-- 修复：直接用 ::TEXT 转成字符串比较 IN，不再 lower + coalesce。
--       role 为 NULL 时 ::TEXT 也是 NULL，IN 不匹配 → 店长条件自然 false（正确）。
-- =====================================================================

-- 1) helper 函数：get_my_staff_id(shop_id) —— 当前用户在该店铺的 staff.id
DO $mk_helper$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='get_my_staff_id' AND pronargs=1) THEN
    CREATE OR REPLACE FUNCTION get_my_staff_id(p_shop_id UUID)
    RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT s.id FROM staff s JOIN profiles p ON p.id=s.profile_id
      WHERE  p.user_id = auth.uid() AND s.shop_id = p_shop_id LIMIT 1;
    $$;
    RAISE NOTICE '✅ helper get_my_staff_id(shop_id) 已创建';
  ELSE
    RAISE NOTICE 'ℹ️  get_my_staff_id 已存在，跳过';
  END IF;
END $mk_helper$;

-- 2) records UPDATE RLS：创建者本人 / 当前归属人本人 / 店长 → 三选一允许
DO $upd_rls$
BEGIN
  DROP POLICY IF EXISTS "record_update_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_update_own" ON records FOR UPDATE
      USING (shop_id IS NOT NULL AND (
        created_by = auth.uid()
        OR staff_id = get_my_staff_id(shop_id)
        OR EXISTS (SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id = records.shop_id
            AND p.role::TEXT IN ('manager','admin','owner'))
      ))
      WITH CHECK (shop_id IS NOT NULL AND (
        created_by = auth.uid()
        OR staff_id = get_my_staff_id(shop_id)
        OR EXISTS (SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id = records.shop_id
            AND p.role::TEXT IN ('manager','admin','owner'))
      ));
  $policy$;
  RAISE NOTICE '✅ records UPDATE 策略已重建（创建者/当前归属人/店长 → 允许）';
END $upd_rls$;

-- 3) records DELETE RLS：同上三条件
DO $del_rls$
BEGIN
  DROP POLICY IF EXISTS "record_delete_own" ON records;
  EXECUTE $policy$
    CREATE POLICY "record_delete_own" ON records FOR DELETE
      USING (shop_id IS NOT NULL AND (
        created_by = auth.uid()
        OR staff_id = get_my_staff_id(shop_id)
        OR EXISTS (SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id = records.shop_id
            AND p.role::TEXT IN ('manager','admin','owner'))
      ));
  $policy$;
  RAISE NOTICE '✅ records DELETE 策略已重建（创建者/当前归属人/店长 → 允许）';
END $del_rls$;

-- 4) 验证面板（Results 标签里可直接看）
SELECT 'update-v5.4.5-transfer-rls v3 已执行'::TEXT AS step,
       '刷新浏览器后再试：被过渡人点击「同意/拒绝」必须立即生效，刷新后不会再变回待审批'::TEXT AS action
UNION ALL
SELECT 'helper get_my_staff_id', CASE WHEN EXISTS(
  SELECT 1 FROM pg_proc WHERE proname='get_my_staff_id' AND pronargs=1
) THEN '已就绪' ELSE '缺失' END
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
