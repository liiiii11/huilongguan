-- ============================================================
--  销售业绩记录工具 - 邀请码加入店铺失败 修复补丁
--  修复版本: v5-fix1
--  适用版本: 原 schema.sql / update-v4.sql 之后
--
--  使用方法:
--  1. 打开 Supabase Dashboard → SQL Editor
--  2. 新建查询，粘贴本脚本全文
--  3. 点击「运行」(Run)
--  4. 看到 "Success" 或无红色报错即完成
--
--  修复内容 (按优先级):
--    [P0] 1. profiles 表 RLS 死循环 (shop_id 为 NULL 时读不到自己)
--    [P0] 2. join_shop 邀请码大小写/空格 + profile 空值保护
--    [P1] 3. create_shop 空值保护 (同步)
--    [P1] 4. 其余业务表 RLS 补充 NULL 保护
--    [可选] 5. 历史邀请码统一大写 + 数据清理建议
-- ============================================================

-- ============================================================
--  [P0] 修复 1: profiles 表 RLS 死循环
--  原策略: shop_id IN (子查询返回 NULL) → 永远不通过
--  新策略: 允许本人直接读取自己的 profile (不经过 shop_id 关联)
-- ============================================================

-- 删除旧策略 (幂等: IF EXISTS)
DROP POLICY IF EXISTS "profile_select_own" ON profiles;
DROP POLICY IF EXISTS "profile_update_own" ON profiles;

-- 新 SELECT 策略
--  逻辑: 要么是本人 (允许 shop_id = NULL 时读), 要么是同店成员
CREATE POLICY "profile_select_own" ON profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

-- 新 UPDATE 策略
--  逻辑: 本人只能改自己; 管理员可以改同店任何人
CREATE POLICY "profile_update_own" ON profiles FOR UPDATE
  USING (
    user_id = auth.uid()
    OR
    (
      shop_id IN (
        SELECT shop_id FROM profiles
        WHERE user_id = auth.uid() AND role = 'manager' AND shop_id IS NOT NULL
      )
    )
  );


-- ============================================================
--  [P0] 修复 2: join_shop 函数
--  - 邀请码统一 upper(trim(...)) 匹配
--  - 确保 profile 一定存在 (trigger 失效时手动补)
--  - 校验 new_profile_id 非空
-- ============================================================

CREATE OR REPLACE FUNCTION join_shop(p_join_code TEXT, p_display_name TEXT)
RETURNS UUID AS $$
DECLARE
  target_shop_id UUID;
  new_profile_id UUID;
  current_user_id UUID := auth.uid();
BEGIN
  -- ===== 步骤 1: 邀请码匹配 (统一大写 + 去首尾空格) =====
  SELECT id
    INTO target_shop_id
    FROM shops
   WHERE join_code = upper(trim(COALESCE(p_join_code, '')));

  IF target_shop_id IS NULL THEN
    RAISE EXCEPTION '邀请码无效，请检查大小写或联系管理员获取正确邀请码';
  END IF;

  -- ===== 步骤 2: 确保 profile 存在 (防 trigger 失效) =====
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = current_user_id) THEN
    INSERT INTO profiles (user_id, display_name)
    VALUES (current_user_id, COALESCE(p_display_name, '新用户'));
  END IF;

  -- ===== 步骤 3: 更新 profile (绑定店铺 + 角色) =====
  UPDATE profiles
     SET shop_id      = target_shop_id,
         role         = 'staff',
         display_name = COALESCE(NULLIF(trim(p_display_name), ''), display_name)
   WHERE user_id = current_user_id
   RETURNING id INTO new_profile_id;

  IF new_profile_id IS NULL THEN
    RAISE EXCEPTION '用户资料更新失败，请退出登录后重新登录再试';
  END IF;

  -- ===== 步骤 4: 插入 staff 记录 =====
  -- 防重复: 如果该 profile_id 已经有 staff，不重复插入
  IF NOT EXISTS (
    SELECT 1 FROM staff WHERE profile_id = new_profile_id AND shop_id = target_shop_id
  ) THEN
    INSERT INTO staff (shop_id, name, profile_id, sort_order)
    VALUES (
      target_shop_id,
      COALESCE(NULLIF(trim(p_display_name), ''), '员工'),
      new_profile_id,
      (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM staff WHERE shop_id = target_shop_id)
    );
  END IF;

  RETURN target_shop_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
--  [P1] 修复 3: create_shop 函数 (同步增强)
--  - 确保 profile 存在
--  - 校验 new_profile_id 非空
--  - 防重复 staff 插入
-- ============================================================

CREATE OR REPLACE FUNCTION create_shop(p_shop_name TEXT, p_display_name TEXT)
RETURNS UUID AS $$
DECLARE
  new_shop_id UUID;
  new_profile_id UUID;
  current_user_id UUID := auth.uid();
BEGIN
  -- ===== 步骤 0: 校验 shop 名称 =====
  IF NULLIF(trim(p_shop_name), '') IS NULL THEN
    RAISE EXCEPTION '店铺名称不能为空';
  END IF;

  -- ===== 步骤 1: 确保 profile 存在 =====
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = current_user_id) THEN
    INSERT INTO profiles (user_id, display_name)
    VALUES (current_user_id, COALESCE(p_display_name, '新用户'));
  END IF;

  -- ===== 步骤 2: 创建店铺 =====
  INSERT INTO shops (name)
  VALUES (trim(p_shop_name))
  RETURNING id INTO new_shop_id;

  -- ===== 步骤 3: 更新 profile (管理员身份) =====
  UPDATE profiles
     SET shop_id      = new_shop_id,
         role         = 'manager',
         display_name = COALESCE(NULLIF(trim(p_display_name), ''), display_name)
   WHERE user_id = current_user_id
   RETURNING id INTO new_profile_id;

  IF new_profile_id IS NULL THEN
    RAISE EXCEPTION '用户资料更新失败，请退出登录后重新登录再试';
  END IF;

  -- ===== 步骤 4: 插入管理员 staff 记录 =====
  IF NOT EXISTS (
    SELECT 1 FROM staff WHERE profile_id = new_profile_id AND shop_id = new_shop_id
  ) THEN
    INSERT INTO staff (shop_id, name, profile_id, sort_order)
    VALUES (
      new_shop_id,
      COALESCE(NULLIF(trim(p_display_name), ''), '管理员'),
      new_profile_id,
      0
    );
  END IF;

  RETURN new_shop_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
--  [P1] 修复 4: 业务表 RLS 补充 NULL 保护
--  保持与 profiles 策略一致: 当 shop_id 子查询返回空时不至于全挡
--  (注意: 这些表的记录本身都带 shop_id, 所以不像 profiles 那么
--   严重, 但加上 IS NOT NULL 可以避免未来的三值逻辑陷阱)
-- ============================================================

-- --- shops ---
DROP POLICY IF EXISTS "shop_select_own" ON shops;
CREATE POLICY "shop_select_own" ON shops FOR SELECT
  USING (
    id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

-- --- staff ---
DROP POLICY IF EXISTS "staff_select_own" ON staff;
DROP POLICY IF EXISTS "staff_insert_own" ON staff;
DROP POLICY IF EXISTS "staff_update_mgr" ON staff;
DROP POLICY IF EXISTS "staff_delete_mgr" ON staff;

CREATE POLICY "staff_select_own" ON staff FOR SELECT
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "staff_insert_own" ON staff FOR INSERT
  WITH CHECK (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "staff_update_mgr" ON staff FOR UPDATE
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND role = 'manager' AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "staff_delete_mgr" ON staff FOR DELETE
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND role = 'manager' AND shop_id IS NOT NULL
    )
  );

-- --- types ---
DROP POLICY IF EXISTS "type_select_own" ON types;
DROP POLICY IF EXISTS "type_all_own" ON types;

CREATE POLICY "type_select_own" ON types FOR SELECT
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "type_all_own" ON types FOR ALL
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  )
  WITH CHECK (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

-- --- subtypes ---
DROP POLICY IF EXISTS "subtype_select_own" ON subtypes;
DROP POLICY IF EXISTS "subtype_all_own" ON subtypes;

CREATE POLICY "subtype_select_own" ON subtypes FOR SELECT
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "subtype_all_own" ON subtypes FOR ALL
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  )
  WITH CHECK (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

-- --- records ---
DROP POLICY IF EXISTS "record_select_own" ON records;
DROP POLICY IF EXISTS "record_insert_own" ON records;
DROP POLICY IF EXISTS "record_update_own" ON records;
DROP POLICY IF EXISTS "record_delete_own" ON records;

CREATE POLICY "record_select_own" ON records FOR SELECT
  USING (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "record_insert_own" ON records FOR INSERT
  WITH CHECK (
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "record_update_own" ON records FOR UPDATE
  USING (
    created_by = auth.uid()
    OR
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND role = 'manager' AND shop_id IS NOT NULL
    )
    OR
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );

CREATE POLICY "record_delete_own" ON records FOR DELETE
  USING (
    created_by = auth.uid()
    OR
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND role = 'manager' AND shop_id IS NOT NULL
    )
    OR
    shop_id IN (
      SELECT shop_id FROM profiles
      WHERE user_id = auth.uid() AND shop_id IS NOT NULL
    )
  );


-- ============================================================
--  [可选] 修复 5: 历史数据规整 (不影响功能, 建议执行)
-- ============================================================

-- 5a. 统一历史邀请码为大写 (防止之前的触发器生成了小写的极端情况)
UPDATE shops
   SET join_code = upper(join_code)
 WHERE join_code <> upper(join_code);

-- 5b. 清理历史异常: profiles 中 shop_id 有值但没在 staff 表关联的用户
--    (如果之前 join_shop 在 profile 更新成功后、插入 staff 前失败，会导致这种孤儿数据)
--    仅作诊断，不自动修复，执行后查看有无返回行:
--  SELECT p.id, p.user_id, p.display_name, p.shop_id
--    FROM profiles p
--    LEFT JOIN staff s ON s.profile_id = p.id AND s.shop_id = p.shop_id
--   WHERE p.shop_id IS NOT NULL AND s.id IS NULL;


-- ============================================================
--  验证区: 运行完以上修复后，可以解开下面的注释，单独运行验证
-- ============================================================

/*
-- ==== 验证 1: 找一个已知存在的邀请码，测试大小写匹配 ====
--  把 'ABC123' 换成真实邀请码，看能否返回 shop name
SELECT name, join_code
  FROM shops
 WHERE join_code = upper(trim(' abc123 '));  -- 故意写小写 + 前后空格

-- ==== 验证 2: 检查新加入用户能否读到自己的 profile ====
--  (Supabase 中无法直接模拟 auth.uid()，此步建议在前端实际注册测试)

-- ==== 验证 3: 列出所有策略确认已更新 ====
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname;
*/

-- ============================================================
--  修复完成
--  后续操作（前端建议）:
--    1. 在 Supabase Dashboard → Authentication → Providers 确认 Email 已启用
--    2. 让当前已登录的用户退出再重新登录一次 (刷新 session)
--    3. 前端 joinShop 成功后务必重新调用 DataLayer.init() 再跳转
-- ============================================================
