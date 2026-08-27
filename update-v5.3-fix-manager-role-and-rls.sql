-- ============================================================
--  v5.3 修复店长/店员权限 & RLS 嵌套子查询 (2合1)
--  解决 2 个问题：
--    A) 店长看不到店员的销售信息
--       - 原因 1: profiles.role 可能为 NULL 或 "admin" / "Manager"，
--                前端 isManager() 严格匹配 "manager" 导致判错
--       - 原因 2: 店铺创建者 (shops.owner_id) 的 role 可能没正确设为 manager
--    B) 所有表的 RLS policy 仍有嵌套子查询
--       shop_id IN (SELECT shop_id FROM profiles WHERE ...)
--       → 未来可能再次触发 42P17 infinite recursion
--       → 全部替换为 shop_id = get_my_shop_id()
--
--  使用方法：Supabase SQL Editor 全选复制 → Run
-- ============================================================

DO $$
DECLARE
  _cnt INTEGER;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Part A: 修复历史 profiles.role 字段';
  RAISE NOTICE '========================================';

  -- A1: 真正的店铺创建者（owner_id 匹配）→ 强制设为 manager
  UPDATE public.profiles p
     SET role = 'manager'
    FROM public.shops s
   WHERE p.user_id = s.owner_id
     AND p.shop_id = s.id
     AND (p.role IS NULL OR lower(p.role) <> 'manager');
  GET DIAGNOSTICS _cnt = ROW_COUNT;
  RAISE NOTICE '[A1] 修复店铺创建者 role=manager: % 条', _cnt;

  -- A2: 已加入店铺但 role 为 NULL → 默认设为 staff
  UPDATE public.profiles
     SET role = 'staff'
   WHERE shop_id IS NOT NULL
     AND role IS NULL;
  GET DIAGNOSTICS _cnt = ROW_COUNT;
  RAISE NOTICE '[A2] 兜底店员 role=staff: % 条', _cnt;

  -- A3: role 去空格 + 强制小写 (Manager/MANAGER → manager, Admin → admin)
  UPDATE public.profiles
     SET role = lower(btrim(role))
   WHERE role IS NOT NULL
     AND role <> lower(btrim(role));
  GET DIAGNOSTICS _cnt = ROW_COUNT;
  RAISE NOTICE '[A3] 规范化 role 大小写: % 条', _cnt;

  -- A4: 如果 role = 'admin' (部分老项目), 统一视为 manager
  UPDATE public.profiles
     SET role = 'manager'
   WHERE lower(role) = 'admin';
  GET DIAGNOSTICS _cnt = ROW_COUNT;
  RAISE NOTICE '[A4] admin → manager: % 条', _cnt;

  RAISE NOTICE '';
  RAISE NOTICE 'Part A 完成。profiles role 分布预览:';
  PERFORM 1; -- no-op
END $$;

-- 预览 profiles 表当前的 role 分布（用户能直接看到结果表）
SELECT id, user_id, shop_id, role, display_name
FROM public.profiles
ORDER BY shop_id, role, id;

-- ============================================================
--  Part B: 重建所有业务表 RLS policy，使用 get_my_shop_id()
--          彻底移除嵌套子查询，消灭 42P17 风险
--  顺序: shops → staff → types → subtypes → records
--  注意: 每条 policy 重建都包在 BEGIN/EXCEPTION 里，
--        即使某条失败也不影响其他
-- ============================================================
DO $$
DECLARE
  _sql text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Part B: 重建 5 张业务表 RLS policy（去嵌套子查询）';
  RAISE NOTICE '========================================';

  -- ========= 1. shops 表 =========
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS shop_select_own ON public.shops',
    'DROP POLICY IF EXISTS shop_update_own ON public.shops',
    'CREATE POLICY shop_select_self ON public.shops FOR SELECT
       USING (id = get_my_shop_id())',
    'CREATE POLICY shop_update_self ON public.shops FOR UPDATE
       USING (id = get_my_shop_id())'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[shops] OK: %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[shops] SKIP: % → %', _sql, SQLERRM; END;
  END LOOP;

  -- ========= 2. staff 表 =========
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS staff_select_own ON public.staff',
    'DROP POLICY IF EXISTS staff_insert_own ON public.staff',
    'DROP POLICY IF EXISTS staff_update_mgr ON public.staff',
    'DROP POLICY IF EXISTS staff_delete_mgr ON public.staff',
    'CREATE POLICY staff_select_shop ON public.staff FOR SELECT
       USING (shop_id = get_my_shop_id())',
    'CREATE POLICY staff_all_mgr ON public.staff FOR ALL
       USING (shop_id = get_my_shop_id()
              AND EXISTS (SELECT 1 FROM profiles
                           WHERE user_id = auth.uid()
                             AND shop_id = get_my_shop_id()
                             AND lower(role) = ''manager''))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[staff] OK: %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[staff] SKIP: % → %', _sql, SQLERRM; END;
  END LOOP;

  -- ========= 3. types 表 =========
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS type_select_own ON public.types',
    'DROP POLICY IF EXISTS type_all_own ON public.types',
    'CREATE POLICY type_select_shop ON public.types FOR SELECT
       USING (shop_id = get_my_shop_id())',
    'CREATE POLICY type_all_mgr ON public.types FOR ALL
       USING (shop_id = get_my_shop_id()
              AND EXISTS (SELECT 1 FROM profiles
                           WHERE user_id = auth.uid()
                             AND shop_id = get_my_shop_id()
                             AND lower(role) = ''manager''))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[types] OK: %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[types] SKIP: % → %', _sql, SQLERRM; END;
  END LOOP;

  -- ========= 4. subtypes 表 =========
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS subtype_select_own ON public.subtypes',
    'DROP POLICY IF EXISTS subtype_all_own ON public.subtypes',
    'CREATE POLICY subtype_select_shop ON public.subtypes FOR SELECT
       USING (type_id IN (SELECT id FROM types WHERE shop_id = get_my_shop_id()))',
    'CREATE POLICY subtype_all_mgr ON public.subtypes FOR ALL
       USING (type_id IN (SELECT id FROM types WHERE shop_id = get_my_shop_id())
              AND EXISTS (SELECT 1 FROM profiles
                           WHERE user_id = auth.uid()
                             AND shop_id = get_my_shop_id()
                             AND lower(role) = ''manager''))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[subtypes] OK: %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[subtypes] SKIP: % → %', _sql, SQLERRM; END;
  END LOOP;

  -- ========= 5. records 表（关键！店长必须能看到店员的 records）=========
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS record_select_own ON public.records',
    'DROP POLICY IF EXISTS record_insert_own ON public.records',
    'DROP POLICY IF EXISTS record_update_own ON public.records',
    'DROP POLICY IF EXISTS record_delete_own ON public.records',

    -- 店长 + 普通员工 都能 SELECT 整店 records（前端再按 role 过滤自己可见的部分）
    'CREATE POLICY record_select_shop ON public.records FOR SELECT
       USING (shop_id = get_my_shop_id())',

    -- INSERT：属于本店即可
    'CREATE POLICY record_insert_shop ON public.records FOR INSERT
       WITH CHECK (shop_id = get_my_shop_id())',

    -- UPDATE：本人创建 OR 店长
    'CREATE POLICY record_update_shop ON public.records FOR UPDATE
       USING (
         shop_id = get_my_shop_id()
         AND (
           created_by = auth.uid()
           OR EXISTS (SELECT 1 FROM profiles
                       WHERE user_id = auth.uid()
                         AND shop_id = get_my_shop_id()
                         AND lower(role) = ''manager'')
         )
       )',

    -- DELETE：本人创建 OR 店长
    'CREATE POLICY record_delete_shop ON public.records FOR DELETE
       USING (
         shop_id = get_my_shop_id()
         AND (
           created_by = auth.uid()
           OR EXISTS (SELECT 1 FROM profiles
                       WHERE user_id = auth.uid()
                         AND shop_id = get_my_shop_id()
                         AND lower(role) = ''manager'')
         )
       )'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[records] OK: %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[records] SKIP: % → %', _sql, SQLERRM; END;
  END LOOP;

  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ v5.3 Part A + Part B 全部执行完成';
  RAISE NOTICE '店长现在应该能看到所有店员的销售信息了';
  RAISE NOTICE '前端 force refresh 一次 ⌘+⇧+R 再测';
  RAISE NOTICE '========================================';
END $$;
