-- ============================================================
--  销售业绩记录工具 - Supabase 数据库初始化脚本
--  使用方法：在 Supabase Dashboard > SQL Editor 中粘贴并运行
-- ============================================================

-- ===== 扩展 =====
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== 自定义类型 =====
CREATE TYPE app_role AS ENUM ('manager', 'staff');
CREATE TYPE calc_mode AS ENUM ('rate', 'fixed');

-- ===== 表结构 =====

-- 店铺表
CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  join_code TEXT UNIQUE NOT NULL DEFAULT upper(substr(md5(random()::text), 1, 6)),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 用户资料表（关联 auth.users）
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'staff',
  display_name TEXT NOT NULL DEFAULT '用户',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- 员工表（店铺下的业绩归属人）
CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 提成大类表
CREATE TABLE IF NOT EXISTS types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#4f46e5',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 提成子类表
CREATE TABLE IF NOT EXISTS subtypes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id UUID REFERENCES types(id) ON DELETE CASCADE,
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  calc_mode calc_mode DEFAULT 'rate',
  rate NUMERIC DEFAULT 0,
  fixed NUMERIC DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 业绩记录表
CREATE TABLE IF NOT EXISTS records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  type_id UUID REFERENCES types(id) ON DELETE SET NULL,
  subtype_id UUID REFERENCES subtypes(id) ON DELETE SET NULL,
  record_date DATE NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  commission NUMERIC NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  transfer_from TEXT DEFAULT '',
  transfer_status TEXT DEFAULT 'approved',
  images JSONB DEFAULT '[]',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===== 索引 =====
CREATE INDEX IF NOT EXISTS idx_profiles_shop ON profiles(shop_id);
CREATE INDEX IF NOT EXISTS idx_staff_shop ON staff(shop_id);
CREATE INDEX IF NOT EXISTS idx_types_shop ON types(shop_id);
CREATE INDEX IF NOT EXISTS idx_subtypes_type ON subtypes(type_id);
CREATE INDEX IF NOT EXISTS idx_subtypes_shop ON subtypes(shop_id);
CREATE INDEX IF NOT EXISTS idx_records_shop ON records(shop_id);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(record_date);
CREATE INDEX IF NOT EXISTS idx_records_staff ON records(staff_id);

-- ===== RPC 函数 =====

-- 创建新店铺（注册后第一个用户成为管理员）
CREATE OR REPLACE FUNCTION create_shop(p_shop_name TEXT, p_display_name TEXT)
RETURNS UUID AS $$
DECLARE
  new_shop_id UUID;
  new_profile_id UUID;
  current_user_id UUID := auth.uid();
BEGIN
  -- 创建店铺
  INSERT INTO shops (name) VALUES (p_shop_name) RETURNING id INTO new_shop_id;

  -- 更新用户资料（已有 trigger 创建的初始 profile）
  UPDATE profiles SET shop_id = new_shop_id, role = 'manager', display_name = p_display_name
  WHERE user_id = current_user_id
  RETURNING id INTO new_profile_id;

  -- 为管理员创建 staff 条目
  INSERT INTO staff (shop_id, name, profile_id, sort_order)
  VALUES (new_shop_id, p_display_name, new_profile_id, 0);

  RETURN new_shop_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 加入已有店铺（通过邀请码）
CREATE OR REPLACE FUNCTION join_shop(p_join_code TEXT, p_display_name TEXT)
RETURNS UUID AS $$
DECLARE
  target_shop_id UUID;
  new_profile_id UUID;
  current_user_id UUID := auth.uid();
BEGIN
  SELECT id INTO target_shop_id FROM shops WHERE join_code = p_join_code;
  IF target_shop_id IS NULL THEN
    RAISE EXCEPTION '邀请码无效';
  END IF;

  -- 更新用户资料
  UPDATE profiles SET shop_id = target_shop_id, role = 'staff', display_name = p_display_name
  WHERE user_id = current_user_id
  RETURNING id INTO new_profile_id;

  -- 为新员工创建 staff 条目
  INSERT INTO staff (shop_id, name, profile_id, sort_order)
  VALUES (target_shop_id, p_display_name, new_profile_id,
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM staff WHERE shop_id = target_shop_id));

  RETURN target_shop_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===== Trigger：注册时自动创建 profile =====
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', '新用户'))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===== 行级安全（RLS）策略 =====

ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE types ENABLE ROW LEVEL SECURITY;
ALTER TABLE subtypes ENABLE ROW LEVEL SECURITY;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;

-- 店铺：同店成员可见
CREATE POLICY "shop_select_own" ON shops FOR SELECT
  USING (id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));

-- 资料：同店成员可见，本人可改
CREATE POLICY "profile_select_own" ON profiles FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));
CREATE POLICY "profile_update_own" ON profiles FOR UPDATE
  USING (user_id = auth.uid());

-- 员工：同店成员可见，同店成员可添加，管理员可管理
CREATE POLICY "staff_select_own" ON staff FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));
CREATE POLICY "staff_insert_own" ON staff FOR INSERT
  WITH CHECK (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));
CREATE POLICY "staff_update_mgr" ON staff FOR UPDATE
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND role = 'manager'));
CREATE POLICY "staff_delete_mgr" ON staff FOR DELETE
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND role = 'manager'));

-- 大类：同店成员可见，同店成员可管理
CREATE POLICY "type_select_own" ON types FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));
CREATE POLICY "type_all_own" ON types FOR ALL
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()))
  WITH CHECK (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));

-- 子类：同店成员可见，同店成员可管理
CREATE POLICY "subtype_select_own" ON subtypes FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));
CREATE POLICY "subtype_all_own" ON subtypes FOR ALL
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()))
  WITH CHECK (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));

-- 记录：同店成员可见
CREATE POLICY "record_select_own" ON records FOR SELECT
  USING (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));

-- 记录：同店成员可创建
CREATE POLICY "record_insert_own" ON records FOR INSERT
  WITH CHECK (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));

-- 记录：同店成员可修改（用于审批过渡记录）
CREATE POLICY "record_update_own" ON records FOR UPDATE
  USING (
    created_by = auth.uid()
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND role = 'manager')
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid())
  );

-- 记录：同店成员可删除（应用层面控制权限）
CREATE POLICY "record_delete_own" ON records FOR DELETE
  USING (
    created_by = auth.uid()
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND role = 'manager')
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid())
  );

-- ===== 完成 =====
-- 执行完成后，请到 Authentication > Providers 确认 Email 已启用
-- 然后到 Settings > API 复制 Project URL 和 anon key 填入 config.js
