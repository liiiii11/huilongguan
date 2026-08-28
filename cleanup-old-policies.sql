-- ============================================================
-- 清理旧 RLS 策略（保留 v2 新策略）
-- 解决新旧策略冲突导致的 RLS 问题
-- ============================================================

-- 1. 检查函数是否存在
SELECT 
  'get_my_shop_ids' AS function_name,
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_my_shop_ids') THEN '✅ 存在' ELSE '❌ 不存在' END AS status
UNION ALL
SELECT 
  'is_my_shop_manager',
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_my_shop_manager') THEN '✅ 存在' ELSE '❌ 不存在' END
UNION ALL
SELECT 
  'get_my_display_name',
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_my_display_name') THEN '✅ 存在' ELSE '❌ 不存在' END;

-- 2. 删除 profiles 表的旧策略（保留 v2 系列）
DROP POLICY IF EXISTS "profile_select_shop" ON profiles;
DROP POLICY IF EXISTS "profile_select_self" ON profiles;
DROP POLICY IF EXISTS "profile_insert_self" ON profiles;
DROP POLICY IF EXISTS "profile_update_self_or_manager" ON profiles;
DROP POLICY IF EXISTS "profile_update_self" ON profiles;
DROP POLICY IF EXISTS "profile_delete_manager" ON profiles;

-- 3. 删除 staff 表的旧策略
DROP POLICY IF EXISTS "staff_select_own" ON staff;
DROP POLICY IF EXISTS "staff_insert_manager" ON staff;
DROP POLICY IF EXISTS "staff_update_manager" ON staff;
DROP POLICY IF EXISTS "staff_delete_manager" ON staff;

-- 4. 删除 records 表的旧策略
DROP POLICY IF EXISTS "record_select_own" ON records;
DROP POLICY IF EXISTS "record_insert_own" ON records;
DROP POLICY IF EXISTS "record_update_own" ON records;
DROP POLICY IF EXISTS "record_delete_own" ON records;

-- 5. 删除 shops 表的旧策略
DROP POLICY IF EXISTS "shop_select_member" ON shops;

-- 6. 删除 types 表的旧策略
DROP POLICY IF EXISTS "type_select_own" ON types;
DROP POLICY IF EXISTS "type_insert_manager" ON types;
DROP POLICY IF EXISTS "type_update_manager" ON types;
DROP POLICY IF EXISTS "type_delete_manager" ON types;

-- 7. 删除 subtypes 表的旧策略
DROP POLICY IF EXISTS "subtype_select_own" ON subtypes;
DROP POLICY IF EXISTS "subtype_insert_manager" ON subtypes;
DROP POLICY IF EXISTS "subtype_update_manager" ON subtypes;
DROP POLICY IF EXISTS "subtype_delete_manager" ON subtypes;

-- 8. 验证最终策略状态
SELECT '===== 最终策略验证 =====' AS info
UNION ALL
SELECT 'profiles: ' || 
  STRING_AGG(policyname || ' (' || cmd || ')', ', ' ORDER BY cmd)
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'profiles'
UNION ALL
SELECT 'staff: ' || 
  STRING_AGG(policyname || ' (' || cmd || ')', ', ' ORDER BY cmd)
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'staff'
UNION ALL
SELECT 'records: ' || 
  STRING_AGG(policyname || ' (' || cmd || ')', ', ' ORDER BY cmd)
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'records'
UNION ALL
SELECT 'shops: ' || 
  STRING_AGG(policyname || ' (' || cmd || ')', ', ' ORDER BY cmd)
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'shops'
UNION ALL
SELECT 'types: ' || 
  STRING_AGG(policyname || ' (' || cmd || ')', ', ' ORDER BY cmd)
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'types'
UNION ALL
SELECT 'subtypes: ' || 
  STRING_AGG(policyname || ' (' || cmd || ')', ', ' ORDER BY cmd)
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'subtypes';
