-- ============================================================
-- HUILONGGUAN v5.6.2 修复版 B：全表 RLS + 语法修正
-- 修复上一版的 SELECT 子查询括号问题
-- ============================================================

-- STEP 0: 删除所有旧策略
DROP POLICY IF EXISTS "profile_select_shop" ON profiles;
DROP POLICY IF EXISTS "profile_insert_self" ON profiles;
DROP POLICY IF EXISTS "profile_update_self_or_manager" ON profiles;
DROP POLICY IF EXISTS "profile_delete_manager" ON profiles;
DROP POLICY IF EXISTS "profile_select_v2" ON profiles;
DROP POLICY IF EXISTS "profile_insert_v2" ON profiles;
DROP POLICY IF EXISTS "profile_update_v2" ON profiles;
DROP POLICY IF EXISTS "profile_delete_v2" ON profiles;
DROP POLICY IF EXISTS "staff_select_own" ON staff;
DROP POLICY IF EXISTS "staff_insert_manager" ON staff;
DROP POLICY IF EXISTS "staff_update_manager" ON staff;
DROP POLICY IF EXISTS "staff_delete_manager" ON staff;
DROP POLICY IF EXISTS "staff_select_v2" ON staff;
DROP POLICY IF EXISTS "staff_insert_v2" ON staff;
DROP POLICY IF EXISTS "staff_update_v2" ON staff;
DROP POLICY IF EXISTS "staff_delete_v2" ON staff;
DROP POLICY IF EXISTS "record_select_own" ON records;
DROP POLICY IF EXISTS "record_insert_own" ON records;
DROP POLICY IF EXISTS "record_update_own" ON records;
DROP POLICY IF EXISTS "record_delete_own" ON records;
DROP POLICY IF EXISTS "record_select_v2" ON records;
DROP POLICY IF EXISTS "record_insert_v2" ON records;
DROP POLICY IF EXISTS "record_update_v2" ON records;
DROP POLICY IF EXISTS "record_delete_v2" ON records;
DROP POLICY IF EXISTS "shop_select_member" ON shops;
DROP POLICY IF EXISTS "shop_select_v2" ON shops;
DROP POLICY IF EXISTS "type_select_own" ON types;
DROP POLICY IF EXISTS "type_insert_manager" ON types;
DROP POLICY IF EXISTS "type_update_manager" ON types;
DROP POLICY IF EXISTS "type_delete_manager" ON types;
DROP POLICY IF EXISTS "type_select_v2" ON types;
DROP POLICY IF EXISTS "type_insert_v2" ON types;
DROP POLICY IF EXISTS "type_update_v2" ON types;
DROP POLICY IF EXISTS "type_delete_v2" ON types;
DROP POLICY IF EXISTS "subtype_select_own" ON subtypes;
DROP POLICY IF EXISTS "subtype_insert_manager" ON subtypes;
DROP POLICY IF EXISTS "subtype_update_manager" ON subtypes;
DROP POLICY IF EXISTS "subtype_delete_manager" ON subtypes;
DROP POLICY IF EXISTS "subtype_select_v2" ON subtypes;
DROP POLICY IF EXISTS "subtype_insert_v2" ON subtypes;
DROP POLICY IF EXISTS "subtype_update_v2" ON subtypes;
DROP POLICY IF EXISTS "subtype_delete_v2" ON subtypes;

-- STEP 1: 创建 SECURITY DEFINER 辅助函数
CREATE OR REPLACE FUNCTION get_my_shop_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND shop_id IS NOT NULL;
$$;
GRANT EXECUTE ON FUNCTION get_my_shop_ids() TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION is_my_shop_manager(target_shop_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND shop_id = target_shop_id
      AND role::TEXT IN ('manager','admin','owner')
  );
$$;
GRANT EXECUTE ON FUNCTION is_my_shop_manager(uuid) TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION get_my_display_name()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT display_name FROM profiles WHERE user_id = auth.uid() LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION get_my_display_name() TO authenticated, anon, service_role;

-- ============================================================
-- STEP 2: profiles 表
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profile_select_v2" ON profiles FOR SELECT
  USING (user_id = auth.uid() OR (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids())));

CREATE POLICY "profile_insert_v2" ON profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "profile_update_v2" ON profiles FOR UPDATE
  USING (shop_id IS NOT NULL AND (user_id = auth.uid() OR is_my_shop_manager(shop_id)))
  WITH CHECK (shop_id IS NULL OR (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids())));

CREATE POLICY "profile_delete_v2" ON profiles FOR DELETE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

-- ============================================================
-- STEP 3: staff 表
-- ============================================================
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_select_v2" ON staff FOR SELECT
  USING (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids()));

CREATE POLICY "staff_insert_v2" ON staff FOR INSERT
  WITH CHECK (
    shop_id IS NOT NULL AND (
      is_my_shop_manager(shop_id)
      OR (profile_id IS NOT NULL AND profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()))
    )
  );

CREATE POLICY "staff_update_v2" ON staff FOR UPDATE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id))
  WITH CHECK (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

CREATE POLICY "staff_delete_v2" ON staff FOR DELETE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

-- ============================================================
-- STEP 4: records 表
--   record_update: USING 严格三条件, WITH CHECK 放宽同店
--   用 get_my_display_name() 函数避免括号嵌套问题
-- ============================================================
ALTER TABLE records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "record_select_v2" ON records FOR SELECT
  USING (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids()));

CREATE POLICY "record_insert_v2" ON records FOR INSERT
  WITH CHECK (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids()));

CREATE POLICY "record_update_v2" ON records FOR UPDATE
  USING (
    shop_id IS NOT NULL AND (
      created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM staff s
        WHERE s.id = records.staff_id
          AND s.shop_id = records.shop_id
          AND (
            (s.profile_id IS NOT NULL AND s.profile_id IN (
              SELECT id FROM profiles WHERE user_id = auth.uid()
            ))
            OR lower(trim(s.name)) = lower(trim(get_my_display_name()))
          )
      )
      OR is_my_shop_manager(shop_id)
    )
  )
  WITH CHECK (
    shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids())
  );

CREATE POLICY "record_delete_v2" ON records FOR DELETE
  USING (
    shop_id IS NOT NULL AND (
      created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM staff s
        WHERE s.id = records.staff_id
          AND s.shop_id = records.shop_id
          AND (
            (s.profile_id IS NOT NULL AND s.profile_id IN (
              SELECT id FROM profiles WHERE user_id = auth.uid()
            ))
            OR lower(trim(s.name)) = lower(trim(get_my_display_name()))
          )
      )
      OR is_my_shop_manager(shop_id)
    )
  );

-- ============================================================
-- STEP 5: shops 表
-- ============================================================
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shop_select_v2" ON shops FOR SELECT
  USING (id IN (SELECT get_my_shop_ids()));

-- ============================================================
-- STEP 6: types 表
-- ============================================================
ALTER TABLE types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "type_select_v2" ON types FOR SELECT
  USING (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids()));

CREATE POLICY "type_insert_v2" ON types FOR INSERT
  WITH CHECK (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

CREATE POLICY "type_update_v2" ON types FOR UPDATE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id))
  WITH CHECK (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

CREATE POLICY "type_delete_v2" ON types FOR DELETE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

-- ============================================================
-- STEP 7: subtypes 表
-- ============================================================
ALTER TABLE subtypes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subtype_select_v2" ON subtypes FOR SELECT
  USING (shop_id IS NOT NULL AND shop_id IN (SELECT get_my_shop_ids()));

CREATE POLICY "subtype_insert_v2" ON subtypes FOR INSERT
  WITH CHECK (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

CREATE POLICY "subtype_update_v2" ON subtypes FOR UPDATE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id))
  WITH CHECK (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

CREATE POLICY "subtype_delete_v2" ON subtypes FOR DELETE
  USING (shop_id IS NOT NULL AND is_my_shop_manager(shop_id));

-- ============================================================
-- STEP 8: records 表补列
-- ============================================================
DO $cols$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='records' AND column_name='transfer_from') THEN
    ALTER TABLE records ADD COLUMN transfer_from UUID NULL;
    RAISE NOTICE '✅ records.transfer_from 列已添加';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='records' AND column_name='transfer_status') THEN
    ALTER TABLE records ADD COLUMN transfer_status TEXT NULL DEFAULT 'none';
    RAISE NOTICE '✅ records.transfer_status 列已添加';
  END IF;
END $cols$;

-- ============================================================
-- Results 验证
-- ============================================================
SELECT '============================================================' AS result
UNION ALL
SELECT '✅ HUILONGGUAN v5.6.2-B 修复完成 ✅'
UNION ALL
SELECT '   已修复：SELECT 子查询括号语法错误'
UNION ALL
SELECT '   已新增：get_my_display_name() 辅助函数'
UNION ALL
SELECT '============================================================'
UNION ALL SELECT ''
UNION ALL
SELECT 'profiles: ' ||
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='profiles') || ' 条策略'
UNION ALL
SELECT 'staff:    ' ||
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='staff') || ' 条策略'
UNION ALL
SELECT 'records:  ' ||
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='records') || ' 条策略'
UNION ALL
SELECT 'shops:    ' ||
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='shops') || ' 条策略'
UNION ALL
SELECT 'types:    ' ||
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='types') || ' 条策略'
UNION ALL
SELECT 'subtypes: ' ||
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='subtypes') || ' 条策略'
UNION ALL SELECT ''
UNION ALL
SELECT '✅ get_my_shop_ids() 存在: ' ||
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='get_my_shop_ids') THEN '是' ELSE '否' END
UNION ALL
SELECT '✅ is_my_shop_manager() 存在: ' ||
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='is_my_shop_manager') THEN '是' ELSE '否' END
UNION ALL
SELECT '✅ get_my_display_name() 存在: ' ||
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='get_my_display_name') THEN '是' ELSE '否' END
UNION ALL SELECT ''
UNION ALL
SELECT '下一步：刷新浏览器 → 登录 → 应正常进入主页';
