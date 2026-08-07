-- ============================================================
--  更新脚本 v2：允许普通员工添加业绩归属人
--  使用方法：在 Supabase Dashboard > SQL Editor 中粘贴并运行
--  适用于已执行过 schema.sql 的用户
-- ============================================================

-- 删除旧的"仅管理员可添加员工"策略
DROP POLICY IF EXISTS staff_insert_mgr ON staff;

-- 新策略：同店所有成员都可以添加员工
CREATE POLICY "staff_insert_own" ON staff FOR INSERT
  WITH CHECK (shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid()));

-- ===== 完成 =====
