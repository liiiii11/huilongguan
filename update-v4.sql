-- ============================================================
--  更新脚本 v4：过渡业绩审批功能
--  使用方法：在 Supabase Dashboard > SQL Editor 中粘贴并运行
--  适用于已执行过 schema.sql + update-v3.sql 的用户
-- ============================================================

-- 1. 添加 transfer_status 字段（pending=待审批, approved=已通过, rejected=已拒绝）
ALTER TABLE records ADD COLUMN IF NOT EXISTS transfer_status TEXT DEFAULT 'approved';

-- 2. 将已有带过渡信息的记录设为已通过（历史数据不需要再审批）
UPDATE records SET transfer_status = 'approved' WHERE transfer_from IS NOT NULL AND transfer_from != '';

-- 3. 添加索引方便查询待审批记录
CREATE INDEX IF NOT EXISTS idx_records_transfer_status ON records(transfer_status);

-- 4. 更新 RLS 策略：允许同店成员更新记录（用于审批过渡记录）
DROP POLICY IF EXISTS "record_update_own" ON records;
CREATE POLICY "record_update_own" ON records FOR UPDATE
  USING (
    created_by = auth.uid()
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND role = 'manager')
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid())
  );

-- 5. 更新 RLS 策略：允许同店成员删除记录（用于拒绝过渡记录）
--    应用层面会控制：过渡者可删除，被过渡人不可删除已通过记录
DROP POLICY IF EXISTS "record_delete_own" ON records;
CREATE POLICY "record_delete_own" ON records FOR DELETE
  USING (
    created_by = auth.uid()
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid() AND role = 'manager')
    OR shop_id IN (SELECT shop_id FROM profiles WHERE user_id = auth.uid())
  );

-- ===== 完成 =====
