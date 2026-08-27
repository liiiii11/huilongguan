-- ============================================================
--  安全版修复：删除所有旧的递归 RLS policy (v5.2-safe)
--  修复问题：ERROR: 42P01 relation "public.transfers" does not exist
--  → 使用 DO block + EXCEPTION WHEN OTHERS 单条捕获继续，
--     某张表/某条 policy 不存在也不中断其他删除。
--  使用方法：Supabase SQL Editor 全选复制，Run。
--  运行完应该显示："DO"（Success），没有任何 ERROR。
-- ============================================================

DO $$
DECLARE
  _sql text;
BEGIN

  -- ===== profiles 表（关键！导致 42P17 infinite recursion 的元凶）=====
  BEGIN
    DROP POLICY IF EXISTS profile_select_own ON public.profiles;
    RAISE NOTICE '[OK] DROP profile_select_own ON profiles';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP] profile_select_own ON profiles: %', SQLERRM;
  END;

  BEGIN
    DROP POLICY IF EXISTS profile_update_own ON public.profiles;
    RAISE NOTICE '[OK] DROP profile_update_own ON profiles';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP] profile_update_own ON profiles: %', SQLERRM;
  END;

  -- ===== shops 表 =====
  BEGIN
    DROP POLICY IF EXISTS shop_select_own ON public.shops;
    RAISE NOTICE '[OK] DROP shop_select_own ON shops';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP] shop_select_own ON shops: %', SQLERRM;
  END;

  BEGIN
    DROP POLICY IF EXISTS shop_update_own ON public.shops;
    RAISE NOTICE '[OK] DROP shop_update_own ON shops';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP] shop_update_own ON shops: %', SQLERRM;
  END;

  -- ===== staff 表 =====
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS staff_select_own ON public.staff',
    'DROP POLICY IF EXISTS staff_insert_own ON public.staff',
    'DROP POLICY IF EXISTS staff_update_own ON public.staff',
    'DROP POLICY IF EXISTS staff_delete_own ON public.staff'
  ] LOOP
    BEGIN
      EXECUTE _sql;
      RAISE NOTICE '[OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[SKIP] %: %', _sql, SQLERRM;
    END;
  END LOOP;

  -- ===== types 表 =====
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS type_select_own ON public.types',
    'DROP POLICY IF EXISTS type_insert_own ON public.types',
    'DROP POLICY IF EXISTS type_update_own ON public.types',
    'DROP POLICY IF EXISTS type_delete_own ON public.types'
  ] LOOP
    BEGIN
      EXECUTE _sql;
      RAISE NOTICE '[OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[SKIP] %: %', _sql, SQLERRM;
    END;
  END LOOP;

  -- ===== subtypes 表 =====
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS subtype_select_own ON public.subtypes',
    'DROP POLICY IF EXISTS subtype_insert_own ON public.subtypes',
    'DROP POLICY IF EXISTS subtype_update_own ON public.subtypes',
    'DROP POLICY IF EXISTS subtype_delete_own ON public.subtypes'
  ] LOOP
    BEGIN
      EXECUTE _sql;
      RAISE NOTICE '[OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[SKIP] %: %', _sql, SQLERRM;
    END;
  END LOOP;

  -- ===== records 表 =====
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS record_select_own ON public.records',
    'DROP POLICY IF EXISTS record_insert_own ON public.records',
    'DROP POLICY IF EXISTS record_update_own ON public.records',
    'DROP POLICY IF EXISTS record_delete_own ON public.records'
  ] LOOP
    BEGIN
      EXECUTE _sql;
      RAISE NOTICE '[OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[SKIP] %: %', _sql, SQLERRM;
    END;
  END LOOP;

  -- ===== transfers 表（许多用户数据库里可能还没建，自动跳过）=====
  FOREACH _sql IN ARRAY ARRAY[
    'DROP POLICY IF EXISTS transfer_select_own ON public.transfers',
    'DROP POLICY IF EXISTS transfer_insert_own ON public.transfers',
    'DROP POLICY IF EXISTS transfer_update_own ON public.transfers'
  ] LOOP
    BEGIN
      EXECUTE _sql;
      RAISE NOTICE '[OK] %', _sql;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[SKIP] % (表不存在?): %', _sql, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ 所有旧 xxx_own 递归 policy 清理完成';
  RAISE NOTICE '接下来请运行验证 SQL 确认 profile_select_own 已消失：';
  RAISE NOTICE 'SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = ''profiles'' ORDER BY 1;';
  RAISE NOTICE '========================================';
END $$;
