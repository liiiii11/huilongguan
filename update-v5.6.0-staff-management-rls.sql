-- =====================================================================
-- update-v5.6.0-staff-management-rls.sql  ——  店长可删除员工（软删：账号移除出店，但历史销售/过渡数据永久保留）
--
-- 数据删除范围（严格对齐用户需求）：
--   ✅ 从 staff 表 DELETE 对应员工行（从员工列表里消失）
--   ✅ 将该员工绑定的 profiles.shop_id 置为 NULL（下次登录即跳到「创建/加入店铺」，等于"账号没有了"）
--   ❌ records 表完全不动 —— 员工"自己录入的销售记录"、"过渡给别人的业绩"、"别人过渡给他的业绩"，
--      全部永久保留不删不改，仅 staff 引用值可能变成 "历史名字"（但数据仍完整可用，店长日历/汇总仍能看到）
--
-- 需要的 RLS 权限：
--   · staff DELETE：仅本人所在店铺的店长/管理员/Owner（USING 校验 shop_id 归属 + 身份）
--   · staff INSERT/SELECT/UPDATE：兜底，员工列表正常读取与新增
--   · profiles UPDATE：允许店长 UPDATE 任意本店 profiles.shop_id
--     允许员工本人 UPDATE 自己的 profile（含 shop_id，供员工主动退店扩展）
--   · profiles/shops/staff 的 SELECT：兜底本店铺可见
-- =====================================================================

-- =====================================================
-- 1. staff 表完整 RLS 策略（SELECT/INSERT/UPDATE/DELETE 覆盖）
-- =====================================================
DO $staff$
BEGIN
  -- 确保 RLS 启用
  IF NOT (SELECT c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='staff') THEN
    ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '✅ staff RLS 已启用';
  END IF;

  -- SELECT：本店铺任意成员可见
  DROP POLICY IF EXISTS "staff_select_own" ON staff;
  EXECUTE $p$
    CREATE POLICY "staff_select_own" ON staff FOR SELECT
      USING (
        shop_id IS NOT NULL AND
        shop_id IN (SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL)
      );
  $p$;

  -- INSERT：仅店长/管理员/Owner 可新增员工（或者员工本人由 join_shop RPC 绕过）
  DROP POLICY IF EXISTS "staff_insert_manager" ON staff;
  EXECUTE $p$
    CREATE POLICY "staff_insert_manager" ON staff FOR INSERT
      WITH CHECK (
        shop_id IS NOT NULL AND (
          EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.user_id = auth.uid()
              AND p.shop_id = staff.shop_id
              AND p.role::TEXT IN ('manager','admin','owner')
          )
          OR
          -- SECURITY DEFINER 的 join_shop/create_shop RPC 会绕过，这里兜底给本人注册
          EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.user_id = auth.uid()
              AND p.shop_id = staff.shop_id
              AND (staff.profile_id IS NULL OR staff.profile_id = p.id)
          )
        )
      );
  $p$;

  -- UPDATE：仅店长可改员工 name / sort_order
  DROP POLICY IF EXISTS "staff_update_manager" ON staff;
  EXECUTE $p$
    CREATE POLICY "staff_update_manager" ON staff FOR UPDATE
      USING (
        shop_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid()
            AND p.shop_id = staff.shop_id
            AND p.role::TEXT IN ('manager','admin','owner')
        )
      )
      WITH CHECK (
        shop_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid()
            AND p.shop_id = staff.shop_id
            AND p.role::TEXT IN ('manager','admin','owner')
        )
      );
  $p$;

  -- DELETE：仅店长可删除员工（防止员工互相删）—— DataLayer.removeStaff 前端再叠一层"不能删自己"
  DROP POLICY IF EXISTS "staff_delete_manager" ON staff;
  EXECUTE $p$
    CREATE POLICY "staff_delete_manager" ON staff FOR DELETE
      USING (
        shop_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid()
            AND p.shop_id = staff.shop_id
            AND p.role::TEXT IN ('manager','admin','owner')
        )
      );
  $p$;

  RAISE NOTICE '✅ staff 表 4 条 RLS 策略 (S/I/U/D) 已启用';
END $staff$;

-- =====================================================
-- 2. profiles 表 UPDATE RLS：店长可把任意本店员工 shop_id 置空（移除出店）
-- =====================================================
DO $prof_upd$
BEGIN
  -- 确保 RLS 启用
  IF NOT (SELECT c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='profiles') THEN
    ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '✅ profiles RLS 已启用';
  END IF;

  -- 店长（manager/admin/owner）可 UPDATE 本店任意员工 profile：核心就是能把 shop_id=NULL
  -- 员工本人也可 UPDATE 自己的 profile（改 display_name / 主动退店置 shop_id=NULL）
  DROP POLICY IF EXISTS "profile_update_self_or_manager" ON profiles;
  EXECUTE $p$
    CREATE POLICY "profile_update_self_or_manager" ON profiles FOR UPDATE
      USING (
        shop_id IS NOT NULL AND (
          -- ① 店长 / 管理员 / Owner（同店）
          EXISTS (
            SELECT 1 FROM profiles mgr
            WHERE mgr.user_id = auth.uid()
              AND mgr.shop_id = profiles.shop_id
              AND mgr.role::TEXT IN ('manager','admin','owner')
          )
          OR
          -- ② 员工本人（自己的 profile）
          profiles.user_id = auth.uid()
        )
      )
      WITH CHECK (
        -- WITH CHECK：shop_id 要么仍然是本店，要么被置为 NULL（移除出店）—— 绝对不允许把员工改去别的店铺
        (
          shop_id IS NOT NULL AND
          shop_id IN (SELECT p.shop_id FROM profiles p
            WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL)
        )
        OR
        shop_id IS NULL
      );
  $p$;
  RAISE NOTICE '✅ profiles UPDATE RLS 已启用：店长可将本店员工 shop_id=NULL 移除出店 / 员工本人可改自己资料';
END $prof_upd$;

-- =====================================================
-- 3. profiles SELECT / INSERT 兜底策略（防止被之前脚本删除后又没补上）
-- =====================================================
DO $prof_misc$
BEGIN
  -- SELECT：同店所有人互相可见（员工列表）+ 本人独立可见
  DROP POLICY IF EXISTS "profile_select_shop" ON profiles;
  EXECUTE $p$
    CREATE POLICY "profile_select_shop" ON profiles FOR SELECT
      USING (
        profiles.user_id = auth.uid()
        OR (
          shop_id IS NOT NULL AND
          shop_id IN (SELECT p.shop_id FROM profiles p
            WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL)
        )
      );
  $p$;

  -- INSERT：兜底 SECURITY DEFINER ensureProfile 会绕过，这里留本人可见 + 同店
  DROP POLICY IF EXISTS "profile_insert_self" ON profiles;
  EXECUTE $p$
    CREATE POLICY "profile_insert_self" ON profiles FOR INSERT
      WITH CHECK (
        user_id = auth.uid()
      );
  $p$;
  RAISE NOTICE '✅ profiles SELECT/INSERT RLS 兜底完成';
END $prof_misc$;

-- =====================================================
-- 4. shops 表 SELECT 兜底（防止被之前脚本删除）
-- =====================================================
DO $shops$
BEGIN
  IF NOT (SELECT c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='shops') THEN
    ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '✅ shops RLS 已启用';
  END IF;

  DROP POLICY IF EXISTS "shop_select_member" ON shops;
  EXECUTE $p$
    CREATE POLICY "shop_select_member" ON shops FOR SELECT
      USING (
        id IN (SELECT p.shop_id FROM profiles p
          WHERE p.user_id = auth.uid() AND p.shop_id IS NOT NULL)
      );
  $p$;
  RAISE NOTICE '✅ shops SELECT RLS 兜底完成';
END $shops$;

-- =====================================================
-- Results 验证面板
-- =====================================================
SELECT 'update-v5.6.0-staff-management-rls 已执行 ✅'::TEXT AS step,
       '店长可删除员工：DELETE staff + 置空 profiles.shop_id → 员工下次登录无店铺（"账号没有了"）；records 表完全保留历史销售/过渡数据'::TEXT AS explain
UNION ALL
SELECT 'staff SELECT 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='staff' AND cmd='SELECT') || ' 条'
UNION ALL
SELECT 'staff INSERT 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='staff' AND cmd='INSERT') || ' 条'
UNION ALL
SELECT 'staff UPDATE 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='staff' AND cmd='UPDATE') || ' 条'
UNION ALL
SELECT 'staff DELETE 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='staff' AND cmd='DELETE') || ' 条'
UNION ALL
SELECT 'profiles UPDATE 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND cmd='UPDATE') || ' 条'
UNION ALL
SELECT 'profiles SELECT 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND cmd='SELECT') || ' 条'
UNION ALL
SELECT 'profiles INSERT 策略', (SELECT COUNT(*)::TEXT FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND cmd='INSERT') || ' 条';
