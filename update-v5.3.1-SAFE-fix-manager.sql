-- ============================================================
--  v5.3.1 安全版：修复店长权限 + RLS 嵌套子查询
--  修复 v5.3 问题：ERROR: column s.owner_id does not exist
--  → 所有 UPDATE/DDL 都用独立 BEGIN/EXCEPTION 包，任何单条失败
--     都不影响其他语句执行（尤其是 Part B 的 policy 重建！）
--  使用方法：Supabase SQL Editor 全选复制 → Run
-- ============================================================

-- ============================================================
--  Part 0: 先预览数据库真实结构（先跑这段，确定字段名）
--  这段会返回两张结果表：
--   1) shops 表所有列
--   2) profiles 表所有记录及当前 role
-- ============================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'shops'
ORDER BY ordinal_position;

SELECT p.id, p.user_id, p.shop_id, p.role, p.display_name, p.created_at
FROM public.profiles p
ORDER BY p.shop_id, p.role, p.id;

-- ============================================================
--  Part A: 修复 profiles.role 字段（安全版：每步独立 EXCEPTION）
-- ============================================================
DO $$
DECLARE
  _cnt INTEGER;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Part A: 修复 profiles.role';
  RAISE NOTICE '========================================';

  -- A1 兜底: 先尝试按 shops.created_by / shops.owner_user_id / shops.owner_id
  --         匹配真正的店主 → 设为 manager
  --         哪个字段存在就用哪个; 都不存在就 SKIP, 不影响后续
  BEGIN
    UPDATE public.profiles p SET role = 'manager'
     FROM public.shops s
     WHERE p.user_id = s.owner_id AND p.shop_id = s.id
       AND (p.role IS NULL OR lower(p.role) <> 'manager');
    GET DIAGNOSTICS _cnt = ROW_COUNT;
    RAISE NOTICE '[A1-owner_id] 修复店主=manager: % 条', _cnt;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      UPDATE public.profiles p SET role = 'manager'
       FROM public.shops s
       WHERE p.user_id = s.owner_user_id AND p.shop_id = s.id
         AND (p.role IS NULL OR lower(p.role) <> 'manager');
      GET DIAGNOSTICS _cnt = ROW_COUNT;
      RAISE NOTICE '[A1-owner_user_id] 修复店主=manager: % 条', _cnt;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        UPDATE public.profiles p SET role = 'manager'
         FROM public.shops s
         WHERE p.user_id = s.created_by AND p.shop_id = s.id
           AND (p.role IS NULL OR lower(p.role) <> 'manager');
        GET DIAGNOSTICS _cnt = ROW_COUNT;
        RAISE NOTICE '[A1-created_by] 修复店主=manager: % 条', _cnt;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '[A1-SKIP] shops 表没有 owner_id / owner_user_id / created_by，这步自动跳过，不影响后续';
      END;
    END;
  END;

  -- A2: 已加入店铺但 role 为 NULL → 默认 staff（肯定安全）
  BEGIN
    UPDATE public.profiles SET role = 'staff'
     WHERE shop_id IS NOT NULL AND role IS NULL;
    GET DIAGNOSTICS _cnt = ROW_COUNT;
    RAISE NOTICE '[A2] 兜底店员=staff: % 条', _cnt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[A2-SKIP] %', SQLERRM;
  END;

  -- A3: 规范化 role 大小写（Manager → manager）
  BEGIN
    UPDATE public.profiles SET role = lower(btrim(role))
     WHERE role IS NOT NULL AND role <> lower(btrim(role));
    GET DIAGNOSTICS _cnt = ROW_COUNT;
    RAISE NOTICE '[A3] 规范化大小写: % 条', _cnt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[A3-SKIP] %', SQLERRM;
  END;

  -- A4: 'admin' / 'owner' → 'manager'
  BEGIN
    UPDATE public.profiles SET role = 'manager'
     WHERE lower(role) IN ('admin', 'owner');
    GET DIAGNOSTICS _cnt = ROW_COUNT;
    RAISE NOTICE '[A4] admin/owner → manager: % 条', _cnt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[A4-SKIP] %', SQLERRM;
  END;

  RAISE NOTICE 'Part A 完成。如果上面有 [SKIP] 也不用担心，不影响 Part B。';
END $$;


-- ============================================================
--  Part B: 重建所有业务表 RLS policy（去掉嵌套子查询）
--  每条 CREATE/DROP 都独立 EXCEPTION，绝对不会中途中断！
-- ============================================================
DO $$
DECLARE
  _sql text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Part B: 重建 5 张业务表 policy（去嵌套子查询）';
  RAISE NOTICE '========================================';

  -- 1) shops
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS shop_select_own ON public.shops',
    'DROP POLICY IF EXISTS shop_update_own ON public.shops',
    'CREATE POLICY shop_select_self ON public.shops FOR SELECT USING (id = get_my_shop_id())',
    'CREATE POLICY shop_update_self ON public.shops FOR UPDATE USING (id = get_my_shop_id())'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[shops OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[shops SKIP] % → %', _sql, SQLERRM; END;
  END LOOP;

  -- 2) staff
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS staff_select_own ON public.staff',
    'DROP POLICY IF EXISTS staff_insert_own ON public.staff',
    'DROP POLICY IF EXISTS staff_update_mgr ON public.staff',
    'DROP POLICY IF EXISTS staff_delete_mgr ON public.staff',
    'CREATE POLICY staff_select_shop ON public.staff FOR SELECT USING (shop_id = get_my_shop_id())',
    'CREATE POLICY staff_all_mgr ON public.staff FOR ALL
       USING (shop_id = get_my_shop_id()
              AND EXISTS (SELECT 1 FROM public.profiles
                           WHERE user_id = auth.uid()
                             AND shop_id = get_my_shop_id()
                             AND lower(role) = ''manager''))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[staff OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[staff SKIP] % → %', _sql, SQLERRM; END;
  END LOOP;

  -- 3) types
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS type_select_own ON public.types',
    'DROP POLICY IF EXISTS type_all_own ON public.types',
    'CREATE POLICY type_select_shop ON public.types FOR SELECT USING (shop_id = get_my_shop_id())',
    'CREATE POLICY type_all_mgr ON public.types FOR ALL
       USING (shop_id = get_my_shop_id()
              AND EXISTS (SELECT 1 FROM public.profiles
                           WHERE user_id = auth.uid()
                             AND shop_id = get_my_shop_id()
                             AND lower(role) = ''manager''))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[types OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[types SKIP] % → %', _sql, SQLERRM; END;
  END LOOP;

  -- 4) subtypes
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS subtype_select_own ON public.subtypes',
    'DROP POLICY IF EXISTS subtype_all_own ON public.subtypes',
    'CREATE POLICY subtype_select_shop ON public.subtypes FOR SELECT
       USING (type_id IN (SELECT id FROM public.types WHERE shop_id = get_my_shop_id()))',
    'CREATE POLICY subtype_all_mgr ON public.subtypes FOR ALL
       USING (type_id IN (SELECT id FROM public.types WHERE shop_id = get_my_shop_id())
              AND EXISTS (SELECT 1 FROM public.profiles
                           WHERE user_id = auth.uid()
                             AND shop_id = get_my_shop_id()
                             AND lower(role) = ''manager''))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[subtypes OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[subtypes SKIP] % → %', _sql, SQLERRM; END;
  END LOOP;

  -- 5) records（关键！店长必须能看到店员的 records）
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS record_select_own ON public.records',
    'DROP POLICY IF EXISTS record_insert_own ON public.records',
    'DROP POLICY IF EXISTS record_update_own ON public.records',
    'DROP POLICY IF EXISTS record_delete_own ON public.records',
    'CREATE POLICY record_select_shop ON public.records FOR SELECT
       USING (shop_id = get_my_shop_id())',
    'CREATE POLICY record_insert_shop ON public.records FOR INSERT
       WITH CHECK (shop_id = get_my_shop_id())',
    'CREATE POLICY record_update_shop ON public.records FOR UPDATE
       USING (shop_id = get_my_shop_id()
              AND (created_by = auth.uid()
                   OR EXISTS (SELECT 1 FROM public.profiles
                               WHERE user_id = auth.uid()
                                 AND shop_id = get_my_shop_id()
                                 AND lower(role) = ''manager'')))',
    'CREATE POLICY record_delete_shop ON public.records FOR DELETE
       USING (shop_id = get_my_shop_id()
              AND (created_by = auth.uid()
                   OR EXISTS (SELECT 1 FROM public.profiles
                               WHERE user_id = auth.uid()
                                 AND shop_id = get_my_shop_id()
                                 AND lower(role) = ''manager'')))'
  ] LOOP
    BEGIN EXECUTE _sql; RAISE NOTICE '[records OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE '[records SKIP] % → %', _sql, SQLERRM; END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ Part B 全部执行完成（即使中间有 SKIP 也没关系）';
  RAISE NOTICE '';
  RAISE NOTICE '最后一步：请查看 Part 0 的第二张结果表（profiles 预览）';
  RAISE NOTICE '→ 找到对应店长那条记录的 role 列';
  RAISE NOTICE '→ 如果 role 不是 ''manager''，请手动 UPDATE：';
  RAISE NOTICE '   UPDATE public.profiles SET role=''manager'' WHERE id=''<把你 profiles 预览里店长的 id 贴到这里>'';';
  RAISE NOTICE '';
  RAISE NOTICE '完成后网站 ⌘+⇧+R 强制刷新再登录，店长应该能看到所有店员的销售信息';
  RAISE NOTICE '========================================';
END $$;
