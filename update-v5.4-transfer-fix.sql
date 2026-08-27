-- =========================================================================
-- update-v5.4-transfer-fix.sql  —  过渡功能一次性修复脚本（v5.4.2）
-- v5.4.2: 移除 records.staff 列引用（实际表只有 staff_id UUID，无 staff TEXT）
-- =========================================================================

-- 1. 安全添加 transfer_from / transfer_status 列
DO $colfix$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='records' AND column_name='transfer_from'
  ) THEN
    ALTER TABLE records ADD COLUMN transfer_from TEXT NOT NULL DEFAULT '';
    RAISE NOTICE '✅ records.transfer_from 列已添加';
  ELSE
    RAISE NOTICE 'ℹ️  records.transfer_from 列已存在，跳过';
  END IF;

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

-- 2. 老数据 NULL / 空字符串状态统一修复为 approved
--    （transfer_from 为空 = 自己写自己的普通记录，一定是已生效）
UPDATE records
SET    transfer_status = 'approved'
WHERE  transfer_status IS NULL
   OR  transfer_status = ''
   OR  transfer_from  IS NULL
   OR  transfer_from  = '';

-- 3. 过渡筛选索引（优化店长查看全店 pending）
CREATE INDEX IF NOT EXISTS idx_records_transfer_status
  ON records (shop_id, transfer_status);

CREATE INDEX IF NOT EXISTS idx_records_staff_transfer
  ON records (shop_id, staff_id, transfer_status);

-- 4. 清除 records 表上有嵌套递归死锁风险的 SELECT 策略
DO $polfix$
DECLARE
  r RECORD;
  has_deadlock INT;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE  tablename='records' AND schemaname='public' AND cmd='SELECT'
  LOOP
    SELECT COUNT(*) INTO has_deadlock
    FROM   pg_policy pol
    JOIN   pg_class  c ON c.oid = pol.polrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname='public' AND c.relname='records' AND pol.polname=r.policyname
    AND    pol.polcmd='r'
    AND    pg_get_expr(pol.polqual, pol.polrelid) ~* 'SELECT.*shop_id.*FROM\s+profiles';

    IF has_deadlock > 0 THEN
      EXECUTE 'DROP POLICY ' || quote_ident(r.policyname) || ' ON records;';
      RAISE NOTICE '🗑️  已删除死锁策略: %', r.policyname;
    END IF;
  END LOOP;
END $polfix$;

-- 5. 兜底：如果 records 完全没有 SELECT 策略，补最简非递归版
DO $policyensure$
DECLARE
  sel_policy_cnt INT;
BEGIN
  SELECT COUNT(*) INTO sel_policy_cnt
  FROM   pg_policies
  WHERE  tablename='records' AND schemaname='public' AND cmd='SELECT';

  IF sel_policy_cnt = 0 THEN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_my_shop_id') THEN
      EXECUTE $_$
        CREATE OR REPLACE FUNCTION get_my_shop_id() RETURNS UUID AS $func$
        BEGIN
          RETURN (SELECT p.shop_id FROM profiles p
                  WHERE p.user_id = auth.uid() LIMIT 1);
        END;
        $func$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
      $_$;
      RAISE NOTICE '✅ helper 函数 get_my_shop_id 已创建';
    END IF;
    CREATE POLICY records_select_shop ON records
      FOR SELECT USING (shop_id = get_my_shop_id() AND shop_id IS NOT NULL);
    RAISE NOTICE '✅ records SELECT 策略已重建（最简 shop_id 比对，无嵌套递归）';
  END IF;
END $policyensure$;

-- 6. 完成汇总
DO $done$
BEGIN
  RAISE NOTICE '=========================================================================';
  RAISE NOTICE '✅ v5.4.2 过渡功能修复脚本执行完成！';
  RAISE NOTICE '   • transfer_from / transfer_status 列已就绪';
  RAISE NOTICE '   • 老数据 NULL 状态已修复为 approved';
  RAISE NOTICE '   • 过渡筛选索引已建立';
  RAISE NOTICE '   • 请刷新网页，前端红色降级横幅会自动消失';
  RAISE NOTICE '=========================================================================';
END $done$;

-- Supabase Results 面板直接显示结果
SELECT '✅ v5.4.2 执行成功'::TEXT AS step,
       '刷新页面后红色降级横幅会消失'::TEXT AS action
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
