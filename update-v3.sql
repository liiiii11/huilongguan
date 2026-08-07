-- ============================================================
--  更新脚本 v3：添加业绩过渡人字段
--  使用方法：在 Supabase Dashboard > SQL Editor 中粘贴并运行
--  适用于已执行过 schema.sql 的用户
-- ============================================================

-- 添加 transfer_from 字段到 records 表（记录业绩过渡人）
ALTER TABLE records ADD COLUMN IF NOT EXISTS transfer_from TEXT DEFAULT '';

-- ===== 完成 =====
-- 执行完成后，新添加的业绩记录将自动记录过渡人信息
