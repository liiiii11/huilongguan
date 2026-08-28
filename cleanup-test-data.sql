-- ============================================================
-- 测试数据清理脚本
-- 使用说明：清理所有带有"测试"标记的记录
-- ============================================================

-- 1. 查看需要清理的测试记录
SELECT '待清理的测试记录：' AS info;

SELECT id, staff_id, transfer_from, transfer_status, note, amount, created_at
FROM records
WHERE note LIKE '%测试%' 
   OR note LIKE '%test%' 
   OR note LIKE '%Test%';

-- 2. 清理测试记录（取消注释执行）
-- DELETE FROM records 
-- WHERE note LIKE '%测试%' OR note LIKE '%test%' OR note LIKE '%Test%';

-- 3. 验证清理结果
SELECT '清理后剩余测试记录数：' AS info;
SELECT COUNT(*) AS remaining_test_records
FROM records
WHERE note LIKE '%测试%' OR note LIKE '%test%' OR note LIKE '%Test%';

-- 4. 如果需要重置所有记录（谨慎使用）
-- TRUNCATE TABLE records CASCADE;

SELECT '✅ 测试数据清理脚本就绪' AS result;
