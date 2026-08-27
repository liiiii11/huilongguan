-- =====================================================================
-- update-v5.4.5-transfer-rls.sql
-- 解决：「对方审批后，我这边还是待审批；对方刷新后又显示待审批」
-- 根因：records UPDATE/DELETE RLS policy 原来仅允许 (created_by=本人 OR 店长) 更新
--       导致"被过渡人（普通店员）"审批/拒绝自己 STAFF_ID 名下的过渡记录时，
--       UPDATE 0 rows，静默假成功（Supabase 返回 error:null data:[]）。
--       前端 cache 被本地改成 approved，一刷新从 DB 拉真实 pending 又出现。
--
-- 修复：records UPDATE/DELETE RLS 新增条件：staff_id = 当前用户同店 staff 记录 id
--       即：创建者本人 / 当前归属人本人（被过渡人/接收人） / 店长  → 都允许 UPDATE/DELETE
--
-- 使用：Supabase → SQL Editor → 粘贴 → 运行（100% 幂等）
-- =====================================================================

-- 先尝试创建 helper：get_my_staff_id(shop_id) —— 当前用户在指定店铺的 staff 记录 id
-- 方便 RLS 内直接引用，避免多层子查询
DO $mk_helper$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname='get_my_staff_id' AND pronargs=1
  ) THEN
    CREATE OR REPLACE FUNCTION get_my_staff_id(p_shop_id UUID)
    RETURNS UUID
    LANGUAGE sql STABLE
    AS $$
      SELECT s.id
      FROM   staff s
      JOIN   profiles p ON p.id = s.profile_id
      WHERE  p.user_id = auth.uid()
      AND    s.shop_id = p_shop_id
      LIMIT  1;
    $$;
    RAISE NOTICE '✅ helper get_my_staff_id(shop_id) 已创建';
  ELSE
    RAISE NOTICE 'ℹ️  get_my_staff_id 已存在，跳过';
  END IF;
END $mk_helper$;

-- =====================================================
-- 1) records UPDATE RLS 重建
-- =====================================================
DROP POLICY IF EXISTS "record_update_own" ON records;

CREATE POLICY "record_update_own" ON records FOR UPDATE
  USING (
    shop_id IS NOT NULL AND (
      -- ① 创建者本人（发起人 A 可改自己创建的，比如撤销）
      created_by = auth.uid()
      OR
      -- ② 当前归属人本人（接收人 B 可审批/拒绝自己名下的过渡）
      staff_id = get_my_staff_id(shop_id)
      OR
      -- ③ 店长（任何本店铺记录都可改，兜底强制审批/拒绝）
      EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.user_id = auth.uid()
          AND p.shop_id = records.shop_id
          AND lower(COALESCE(p.role, 'staff')) IN ('manager','admin','owner')
      )
    )
  )
  -- WITH CHECK 同 USING：保证 UPDATE 后仍然满足归属规则
  WITH CHECK (
    shop_id IS NOT NULL AND (
      created_by = auth.uid()
      OR staff_id = get_my_staff_id(shop_id)
      OR EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.user_id = auth.uid()
          AND p.shop_id = records.shop_id
          AND lower(COALESCE(p.role, 'staff')) IN ('manager','admin','owner')
      )
    )
  );

RAISE NOTICE '✅ records UPDATE 策略已重建（创建者/当前归属人/店长 → 允许）';

-- =====================================================
-- 2) records DELETE RLS 重建（同上，保持三角色都能删）
-- =====================================================
DROP POLICY IF EXISTS "record_delete_own" ON records;

CREATE POLICY "record_delete_own" ON records FOR DELETE
  USING (
    shop_id IS NOT NULL AND (
      created_by = auth.uid()
      OR staff_id = get_my_staff_id(shop_id)
      OR EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.user_id = auth.uid()
          AND p.shop_id = records.shop_id
          AND lower(COALESCE(p.role, 'staff')) IN ('manager','admin','owner')
      )
    )
  );

RAISE NOTICE '✅ records DELETE 策略已重建（创建者/当前归属人/店长 → 允许）';

-- =====================================================
-- 3) 收尾：验证面板（看策略是否存在 + get_my_staff_id 是否正常）
-- =====================================================
SELECT 'update-v5.4.5-transfer-rls 已执行'::TEXT AS step,
       '刷新浏览器后再试：被过渡人点击"同意/拒绝"必须立即生效，刷新后不会再变回待审批'::TEXT AS action
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
