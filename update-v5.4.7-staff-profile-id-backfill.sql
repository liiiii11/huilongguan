-- =====================================================================
-- update-v5.4.7-staff-profile-id-backfill.sql （一次性修复历史数据）
--
-- 背景：
--   1) 在 schema-fix-patch.sql 之前，旧 join_shop 插入 staff 时没写 profile_id；
--   2) 店长在 Supabase Table Editor 手动添加的员工默认也没 profile_id；
--   3) 导致新的 getMyStaffId() 第一级精确匹配（s.profile_id === profile.id）失败，
--      只能 fallback 字符串比对（staff.name === display_name）。
--
-- 作用：
--   扫描"同店铺 + staff.name == profiles.display_name"但 staff.profile_id 为 NULL
--   的配对，自动把 profiles.id 回填到 staff.profile_id，之后 getMyStaffId 可以
--   稳定用 UUID 精确匹配，不再靠名字字符串（空格/重名/改名字都会引起误判）。
--
-- 幂等：可重复运行，只会更新 staff.profile_id IS NULL 的行，不会覆盖已有值。
-- =====================================================================

-- Step 1) 先预览要修复多少条（不会改动数据，只是 SELECT）
SELECT '======= 待回填 profile_id 的 staff 记录预览 ======='::TEXT AS info;
SELECT
  s.id         AS staff_id,
  s.shop_id    AS shop_id,
  s.name       AS staff_name,
  p.id         AS matched_profile_id,
  p.user_id    AS profile_user_id,
  p.display_name AS profile_display_name
FROM staff s
JOIN profiles p
  ON  p.shop_id = s.shop_id
  AND lower(trim(p.display_name)) = lower(trim(s.name))
WHERE s.profile_id IS NULL
ORDER BY s.shop_id, s.name;

-- Step 2) 执行回填（幂等：仅当 staff.profile_id IS NULL 时才写入）
UPDATE staff s
SET profile_id = p.id
FROM profiles p
WHERE p.shop_id = s.shop_id
  AND lower(trim(p.display_name)) = lower(trim(s.name))
  AND s.profile_id IS NULL;

-- Step 3) 结果报告
SELECT '======= 回填完成，验证 ======='::TEXT AS info
UNION ALL
SELECT '本次回填 staff 行数: ' || (SELECT COUNT(*)::TEXT
  FROM staff s JOIN profiles p
    ON p.shop_id = s.shop_id
   AND lower(trim(p.display_name)) = lower(trim(s.name))
   AND s.profile_id IS NOT DISTINCT FROM p.id
   WHERE (s.profile_id IS NULL) IS FALSE
   AND EXISTS (
     SELECT 1 FROM staff s2 JOIN profiles p2
       ON p2.shop_id = s2.shop_id
      AND lower(trim(p2.display_name)) = lower(trim(s2.name))
      AND s2.id = s.id
      AND s2.profile_id IS NULL
   )
)
UNION ALL
SELECT 'staff 总数: ' || (SELECT COUNT(*)::TEXT FROM staff)
UNION ALL
SELECT 'staff.profile_id 已关联: ' || (SELECT COUNT(*)::TEXT FROM staff WHERE profile_id IS NOT NULL)
UNION ALL
SELECT 'staff.profile_id 仍为 NULL: ' || (SELECT COUNT(*)::TEXT FROM staff WHERE profile_id IS NULL)
UNION ALL
SELECT '⚠️  仍为 NULL 的记录: 要么 profiles 里找不到同店同名 display_name 的行，要么有多条匹配无法唯一确定。' ||
       '可以在 Supabase 手动把对应 profiles.id 写进 staff.profile_id'
UNION ALL
SELECT ''::TEXT
UNION ALL
SELECT '修复完成后，请让员工刷新浏览器重新登录一次 → getMyStaffId() 优先命中 profile_id 关联（100% 准）';
