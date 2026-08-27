-- =========================================================================
-- update-v5.4-transfer-fix.sql  —  过渡功能一次性修复脚本（v5.4.1）
-- 执行时机：在 Supabase SQL Editor 中一次性运行，无需担心重复执行
-- 覆盖修复：P0-1 权限（配合前端）、P0-2 拒绝不删除（配合前端）、
--          P0-3 records 表缺列、P1 店长看全店 pending（配合前端）
-- v5.4.1: 修复 PL/pgSQL 嵌套美元引号冲突 + 顶层 RAISE 语法错误
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. records 表：安全添加 transfer_from / transfer_status 列（P0-3）
--    使用 DO block 兼容 PostgreSQL 无原生 "ADD COLUMN IF NOT EXISTS"
-- -------------------------------------------------------------------------
DO $colfix$
BEGIN
  -- 1a. transfer_from：记录过渡发起人（staff name，冗余存储，便于前端直接筛选）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='records' AND column_name='transfer_from'
  ) THEN
    ALTER TABLE records ADD COLUMN transfer_from TEXT NOT NULL DEFAULT '';
    RAISE NOTICE '✅ records.transfer_from 列已添加';
  ELSE
    RAISE NOTICE 'ℹ️  records.transfer_from 列已存在，跳过';
  END IF;

  -- 1b. transfer_status：过渡状态（pending / approved / rejected）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='records' AND column_name='transfer_status'
  ) THEN
    ALTER TABLE records ADD COLUMN transfer_status TEXT NOT NULL DEFAULT 'approved';
    RAISE NOTICE '✅ records.transfer_status 列已添加';
  ELSE
    RAISE NOTICE 'ℹ️  records.transfer_status 列已存在，跳过';
  END IF;
END $colfix$;

-- -------------------------------------------------------------------------
-- 2. 老数据修复：将 NULL / 空字符串状态统一为 approved
--    （之前版本写入的记录没有状态字段，全部视为已正常生效）
-- -------------------------------------------------------------------------
UPDATE records
SET    transfer_status = 'approved'
WHERE  transfer_status IS NULL OR transfer_status = '';

-- 对于 transfer_from 为空字符串的记录，保证其状态一定是 approved
-- （自己写自己的记录永远无需审批）
UPDATE records
SET    transfer_status = 'approved'
WHERE  transfer_from IS NULL OR transfer_from = '' OR transfer_from = staff::TEXT;

-- -------------------------------------------------------------------------
-- 3. 加索引，加速过渡筛选（优化 P1 店长查看全店 pending 的性能）
-- -------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_records_transfer_status
  ON records (shop_id, transfer_status);

CREATE INDEX IF NOT EXISTS idx_records_staff_transfer
  ON records (shop_id, staff_id, transfer_status);

-- =========================================================================
-- 4. RLS 兜底校验（确保 records 表的 select 权限没有递归嵌套）
--    仅当检测到有问题的策略时才重建，正常策略不受影响
-- =========================================================================
DO $polfix$
DECLARE
  r RECORD;
  has_deadlock INT;
BEGIN
  FOR r IN
    SELECT policyname
    FROM   pg_policies
    WHERE  tablename = 'records'
    AND    schemaname = 'public'
    AND    cmd = 'SELECT'
  LOOP
    SELECT COUNT(*) INTO has_deadlock
    FROM   pg_policy pol
    JOIN   pg_class  c   ON c.oid         = pol.polrelid
    JOIN   pg_namespace n ON n.oid         = c.relnamespace
    WHERE  n.nspname    = 'public'
    AND    c.relname    = 'records'
    AND    pol.polname  = r.policyname
    AND    pol.polcmd   = 'r'  -- SELECT
    AND    pg_get_expr(pol.polqual, pol.polrelid)
           ~* 'SELECT.*shop_id.*FROM\s+profiles';

    IF has_deadlock > 0 THEN
      EXECUTE 'DROP POLICY ' || quote_ident(r.policyname) || ' ON records;';
      RAISE NOTICE '🗑️  已删除有嵌套递归风险的 records SELECT 策略: %', r.policyname;
    END IF;
  END LOOP;
END $polfix$;

-- -------------------------------------------------------------------------
-- 5. 如果 records 上没有任何 SELECT 策略，补一个最简的
--    （按 shop_id 过滤，无嵌套；helper 函数单独用 $func$ 标签，避免美元引号嵌套冲突）
-- -------------------------------------------------------------------------
DO $policyensure$
DECLARE
  sel_policy_cnt INT;
BEGIN
  SELECT COUNT(*) INTO sel_policy_cnt
  FROM   pg_policies
  WHERE  tablename  = 'records'
  AND    schemaname = 'public'
  AND    cmd        = 'SELECT';

  IF sel_policy_cnt = 0 THEN
    -- helper 函数（与之前 schema-fix-patch.sql 保持一致）
    -- 注意：这里用 $func$ 做分隔符，和外层 $policyensure$ 绝对不冲突
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'get_my_shop_id'
    ) THEN
      EXECUTE $_$
        CREATE OR REPLACE FUNCTION get_my_shop_id() RETURNS UUID AS $func$
        BEGIN
          RETURN (SELECT p.shop_id
                  FROM   profiles p
                  WHERE  p.user_id = auth.uid()
                  LIMIT  1);
        END;
        $func$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
      $_$;
      RAISE NOTICE '✅ helper 函数 get_my_shop_id 已创建';
    END IF;

    CREATE POLICY records_select_shop ON records
      FOR SELECT USING (shop_id = get_my_shop_id() AND shop_id IS NOT NULL);
    RAISE NOTICE '✅ 已重建最简 records SELECT 策略（shop_id 直接比对，无递归）';
  END IF;
END $policyensure$;

-- -------------------------------------------------------------------------
-- 6. 完成提示（包进 DO block，避免 SQL 顶层直接写 RAISE 报错）
-- -------------------------------------------------------------------------
DO $done$
BEGIN
  RAISE NOTICE '=========================================================================';
  RAISE NOTICE '✅ v5.4 过渡功能修复脚本执行完成！';
  RAISE NOTICE '   • transfer_from / transfer_status 列已就绪';
  RAISE NOTICE '   • 老数据状态已修复';
  RAISE NOTICE '   • 过渡筛选索引已建立';
  RAISE NOTICE '   • 请刷新网页，前端红色降级横幅会自动消失';
  RAISE NOTICE '   • 修复项：审批身份校验/拒绝不删除退回发起人/店长强制处理';
  RAISE NOTICE '=========================================================================';
END $done$;

-- 最后用 SELECT 输出一份可读的"结果单"（Supabase Results 面板会直接显示）
SELECT '✅ v5.4-transfer-fix 执行成功'            AS step,
       '请刷新页面使降级警告横幅消失'                AS action
UNION ALL
SELECT '列：transfer_from / transfer_status',
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE  table_name='records' AND column_name IN ('transfer_from','transfer_status')) || '/2 列就绪'
UNION ALL
SELECT '索引：过渡筛选索引',
       (SELECT COUNT(*) FROM pg_indexes
        WHERE  tablename='records'
        AND    indexname IN ('idx_records_transfer_status','idx_records_staff_transfer')) || '/2 个已建'
UNION ALL
SELECT 'RLS：records SELECT 策略数',
       (SELECT COUNT(*) FROM pg_policies
        WHERE  tablename='records' AND schemaname='public' AND cmd='SELECT')::TEXT || ' 个';
