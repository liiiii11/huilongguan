/**
 * 数据抽象层 (DataLayer)
 *
 * 设计原则：
 * - 内存缓存为主，保证 UI 读取同步快速（loadRecords/loadStaff/loadTypes 同步返回）
 * - 写操作先更新缓存再异步推送到 Supabase，保证 UI 即时响应
 * - 向下兼容 localStorage 单用户模式（Supabase 未配置时自动降级）
 * - 对 app.js 透明：返回的数据结构与原 localStorage 格式一致
 */
var DataLayer = (function () {
  'use strict';

  /* ===== 模式判断 ===== */
  var useSupabase = false;
  var supa = null;

  /* ===== 内存缓存（格式与原 localStorage 完全一致）===== */
  var cache = {
    records: [],       // [{id, date, typeId, subtype, amount, commission, note, staff, images, createdAt, _staffId, _typeId, _subtypeId}]
    types: [],         // [{id, name, color, subtypes: [{name, calcMode, rate, fixed, _id, _typeId}]}]
    staff: [],         // ['张三', '李四']  ← 兼容旧格式（字符串数组）
    staffObjects: [],  // [{id, name, profile_id, sort_order}]  ← 内部使用
    profile: null,     // {id, user_id, shop_id, role, display_name}
    shop: null         // {id, name, join_code}
  };

  /* ===== localStorage Keys（降级模式）===== */
  var SK_RECORDS = 'sales_records_v5';
  var SK_TYPES = 'sales_types_v5';
  var SK_STAFF = 'sales_staff_v5';

  /* ===== 初始化（v5-fix：最外层 try/catch，任何异常都降级返回，绝不向外抛错卡死 loading）===== */
  async function init() {
    try {
      useSupabase = SupaAuth.init();
      if (!useSupabase) {
        loadFromLocalStorage();
        return { mode: 'local' };
      }

      var session = await SupaAuth.getSession();
      if (!session) return { mode: 'auth' };

      // v5.4-fix: profile=null（读不到 profiles 记录）先自动兜底重建，避免 mode='auth' 卡死
      //          场景：后台手动删了 profiles 员工记录，但 auth.users 仍然存在
      var profile = await SupaAuth.getProfile();
      if (!profile) {
        console.warn('[DataLayer.init] profile is null → 尝试兜底 ensureProfileForCurrentUser');
        var ensureResult = null;
        try {
          ensureResult = typeof SupaAuth.ensureProfileForCurrentUser === 'function'
            ? await SupaAuth.ensureProfileForCurrentUser()
            : null;
        } catch (eEnsure) {
          console.error('[DataLayer.init] ensureProfile THREW:', eEnsure && eEnsure.message);
        }
        if (ensureResult && ensureResult.data) {
          profile = ensureResult.data;
          console.info('[DataLayer.init] profiles 兜底重建成功，shop_id=' + (profile.shop_id || 'NULL'));
        } else {
          // 兜底也失败 → 返回 mode='auth' 并带错误原因，前端显示带 action 的 toast
          var failErr = (ensureResult && ensureResult.error) ? ensureResult.error : null;
          var failMsg = (failErr && failErr.message) || 'profiles 记录缺失且自动重建失败';
          console.error('[DataLayer.init] profile=null 且重建兜底也失败', failMsg);
          return { mode: 'auth', authSubcode: 'profile_rebuild_failed', authMsg: failMsg, needsSql: (failErr && !!failErr.needsSql) };
        }
      }
      if (!profile.shop_id) return { mode: 'setup' };

      cache.profile = profile;

      // v5-fix: shops 查询单独 try/catch，失败不阻塞整体
      try {
        var shopResult = await SupaAuth.getClient()
          .from('shops')
          .select('*')
          .eq('id', profile.shop_id)
          .single();
        if (shopResult && shopResult.data) cache.shop = shopResult.data;
        else if (shopResult && shopResult.error)
          console.error('[DataLayer.init] shops query failed:', shopResult.error.code, shopResult.error.message);
      } catch (e) {
        console.error('[DataLayer.init] shops query THREW:', e.message);
      }

      // v5-fix: loadAllFromSupabase 也包 try/catch（即使内部 allSettled，也做双重保险）
      try {
        await loadAllFromSupabase();
      } catch (e) {
        console.error('[DataLayer.init] loadAllFromSupabase THREW, continuing with empty cache:', e.message);
      }

      return { mode: 'ready' };

    } catch (e) {
      // v5-fix: 整体兜底 —— 绝对不抛异常，根据当前缓存状态返回最合理的 mode
      console.error('[DataLayer.init] FATAL, fallback degraded mode:', e.message, e && e.stack);
      try {
        if (cache.profile && cache.profile.shop_id) return { mode: 'ready', degraded: true, initError: e.message };
        if (cache.profile) return { mode: 'setup', degraded: true, initError: e.message };
        loadFromLocalStorage();
        return { mode: 'local', degraded: true, initError: e.message };
      } catch (_) {
        return { mode: 'local', degraded: true, initError: e.message };
      }
    }
  }

  /* ===== 从 Supabase 加载全部数据到缓存（v5-fix：allSettled + 每路容错，失败就降级为空数组）===== */
  async function loadAllFromSupabase() {
    var shopId = cache.profile.shop_id;
    var client = SupaAuth.getClient();

    // v5-fix: Promise.all → Promise.allSettled，任何一路 reject 都不会整体崩
    var settled = await Promise.allSettled([
      client.from('staff').select('*').eq('shop_id', shopId).order('sort_order'),
      client.from('types').select('*, subtypes(*)').eq('shop_id', shopId).order('sort_order'),
      client.from('records').select('*, type:types(*), subtype:subtypes(*), staff:staff(*)')
        .eq('shop_id', shopId).order('record_date', { ascending: false })
    ]);
    // v5-fix: helper：任何一路 rejected / error → 返回 []，打印详细错误
    function _safe(s, fallback) {
      if (!s) return fallback;
      if (s.status === 'rejected') {
        console.error('[loadAllFromSupabase] query REJECTED:', s.reason && s.reason.message);
        return fallback;
      }
      var v = s.value;
      if (v && v.error) {
        console.error('[loadAllFromSupabase] query ERROR:', v.error.code, v.error.message, v.error.details);
        return fallback;
      }
      return v.data || fallback;
    }
    var results = [_safe(settled[0], []), _safe(settled[1], []), _safe(settled[2], [])];

    // --- Staff ---
    cache.staffObjects = results[0] || [];
    cache.staff = cache.staffObjects.map(function (s) { return s.name; });
    if (cache.staff.length === 0) {
      // 如果没有 staff 数据，添加当前用户
      var myName = cache.profile.display_name || '我';
      cache.staff = [myName];
      cache.staffObjects = [{ id: null, name: myName, profile_id: cache.profile.id, sort_order: 0 }];
    } else {
      // 清理：如果列表中有"我"且用户真实名字也在列表中，移除"我"
      var realName = cache.profile.display_name || '';
      var hasMyStaff = cache.staffObjects.some(function (s) {
        return s.profile_id === cache.profile.id;
      });
      if (hasMyStaff && realName && realName !== '我' && cache.staff.indexOf('我') >= 0) {
        cache.staffObjects = cache.staffObjects.filter(function (s) {
          return s.name !== '我' || s.profile_id === cache.profile.id;
        });
        cache.staff = cache.staffObjects.map(function (s) { return s.name; });
      }
    }

    // --- Types (with subtypes) ---
    cache.types = (results[1] || []).map(function (t) {
      return {
        id: t.id,
        name: t.name,
        color: t.color || '#4f46e5',
        subtypes: (t.subtypes || []).map(function (st) {
          return {
            name: st.name,
            calcMode: st.calc_mode,
            rate: parseFloat(st.rate) || 0,
            fixed: parseFloat(st.fixed) || 0,
            _id: st.id,
            _typeId: st.type_id
          };
        })
      };
    });

    // --- Records ---
    cache.records = (results[2] || []).map(function (r) {
      return {
        id: r.id,
        date: r.record_date,
        typeId: r.type_id,
        type: r.type ? r.type.name : '',
        subtype: r.subtype ? r.subtype.name : '',
        subtypeId: r.subtype_id,
        amount: parseFloat(r.amount) || 0,
        commission: parseFloat(r.commission) || 0,
        note: r.note || '',
        staff: r.staff ? r.staff.name : '',
        transferFrom: r.transfer_from || '',
        transferStatus: r.transfer_status || 'approved',
        _staffId: r.staff_id,
        _typeId: r.type_id,
        _subtypeId: r.subtype_id,
        images: r.images || [],
        _createdBy: r.created_by,
        createdAt: r.created_at
      };
    });
  }

  /* ===== localStorage 降级加载 ===== */
  function loadFromLocalStorage() {
    try {
      cache.records = JSON.parse(localStorage.getItem(SK_RECORDS)) || [];
    } catch (e) { cache.records = []; }

    try {
      cache.staff = JSON.parse(localStorage.getItem(SK_STAFF));
      if (!cache.staff || cache.staff.length === 0) {
        cache.staff = ['我'];
        localStorage.setItem(SK_STAFF, JSON.stringify(cache.staff));
      }
    } catch (e) { cache.staff = ['我']; }

    try {
      var t = JSON.parse(localStorage.getItem(SK_TYPES));
      if (!t || t.length === 0) {
        t = [
          { id: 't1', name: '主机类', color: '#4f46e5', subtypes: [] },
          { id: 't2', name: '3pp类', color: '#06b6d4', subtypes: [] },
          { id: 't3', name: '音频类', color: '#10b981', subtypes: [] }
        ];
        localStorage.setItem(SK_TYPES, JSON.stringify(t));
      }
      t.forEach(function (type) {
        if (!type.subtypes) type.subtypes = [];
        type.subtypes.forEach(function (st) {
          if (typeof st === 'string') {
            type.subtypes[type.subtypes.indexOf(st)] = { name: st, calcMode: 'rate', rate: 0, fixed: 0 };
          }
        });
      });
      cache.types = t;
    } catch (e) {
      cache.types = [
        { id: 't1', name: '主机类', color: '#4f46e5', subtypes: [] },
        { id: 't2', name: '3pp类', color: '#06b6d4', subtypes: [] },
        { id: 't3', name: '音频类', color: '#10b981', subtypes: [] }
      ];
    }
  }

  /* ===== 同步读取（供 app.js 直接调用，格式与原 localStorage 一致）===== */
  function loadRecords() { return cache.records; }
  function loadStaff() { return cache.staff; }
  function loadTypes() { return cache.types; }
  function getProfile() { return cache.profile; }
  function getShop() { return cache.shop; }

  /* ===== 判断是否店长：宽松匹配 v5.3-fix ===== */
  function isManager() {
    if (!cache.profile) return false;
    var role = cache.profile.role;
    var roleNorm = (role == null) ? '' : String(role).trim().toLowerCase();
    var result = roleNorm === 'manager' || roleNorm === 'admin' || roleNorm === 'owner';
    // v5.3: 调试打印（登录后只打一次，方便排查权限问题）
    if (!window.__isManagerDebugged && cache.profile.id) {
      window.__isManagerDebugged = true;
      console.log('[isManager v5.3] 真实 role=' + JSON.stringify(role) +
                  ' → 规范化="' + roleNorm + '" → 结果=' + result);
    }
    return result;
  }
  function isSupaMode() { return useSupabase; }

  /* ===== 获取当前用户对应的 staff name ===== */
  function getMyStaffName() {
    if (!useSupabase) return cache.staff[0] || '我';
    if (!cache.profile) return cache.staff[0] || '我';
    // 查找与当前用户 profile 关联的 staff
    var myStaff = cache.staffObjects.find(function (s) {
      return s.profile_id === cache.profile.id;
    });
    var name = myStaff ? myStaff.name : (cache.profile.display_name || '');
    // 确保返回的名字在 staff 列表中存在
    if (name && cache.staff.indexOf(name) >= 0) return name;
    // 如果关联的 staff 不在列表中，尝试用 display_name 匹配
    if (cache.profile.display_name && cache.staff.indexOf(cache.profile.display_name) >= 0) {
      return cache.profile.display_name;
    }
    // 都不匹配时返回列表中第一个
    return cache.staff[0] || '我';
  }

  /* ===== 写操作：记录 ===== */

  // 添加记录
  async function addRecord(data) {
    // 判断是否为过渡记录：有过渡人且归属人不是自己
    var isTransfer = data.transferFrom && data.transferFrom !== data.staff;

    // ===== v5.3.2-fix: 过渡记录去重防止重复 =====
    // 如果是过渡记录，检查同一个「过渡人→接收人、日期、类型、金额」的记录
    // 在 10 秒内是否已经存在，防止用户连续点击两次导致重复写入
    if (isTransfer) {
      var now = Date.now();
      var dup = cache.records.find(function (r) {
        if (!r) return false;
        var sameTransfer = (r.transferFrom === data.transferFrom) && (r.staff === data.staff);
        var sameCore = (r.date === data.date)
                    && (r.typeId === data.typeId)
                    && (Math.abs((r.amount || 0) - (data.amount || 0)) < 0.01);
        var recentTemp = (String(r.id).indexOf('tmp_') === 0)
                      && (now - parseInt(String(r.id).replace('tmp_', '')) < 15000);
        return sameTransfer && sameCore && recentTemp;
      });
      if (dup) {
        console.warn('[addRecord v5.3.2] 检测到过渡记录重复，拒绝写入：', dup);
        return { data: null, error: { message: '检测到刚刚已经添加过一条相同的过渡记录，请稍候刷新页面查看。' } };
      }
    }

    var transferStatus = isTransfer ? 'pending' : 'approved';

    // 先更新缓存
    var newRecord = {
      id: useSupabase ? ('tmp_' + Date.now()) : ('r' + Date.now() + Math.floor(Math.random() * 1000)),
      date: data.date,
      typeId: data.typeId,
      subtype: data.subtype || '',
      amount: data.amount,
      commission: data.commission,
      note: data.note || '',
      staff: data.staff,
      transferFrom: data.transferFrom || '',
      transferStatus: transferStatus,
      images: data.images || [],
      createdAt: new Date().toISOString()
    };
    cache.records.push(newRecord);

    if (!useSupabase) {
      localStorage.setItem(SK_RECORDS, JSON.stringify(cache.records));
      return { data: newRecord, error: null };
    }

    // 异步推送到 Supabase
    var shopId = cache.profile.shop_id;
    var staffObj = cache.staffObjects.find(function (s) { return s.name === data.staff; });
    var typeObj = cache.types.find(function (t) { return t.id === data.typeId; });
    var subObj = typeObj ? typeObj.subtypes.find(function (st) { return st.name === data.subtype; }) : null;

    var insertData = {
      shop_id: shopId,
      staff_id: staffObj ? staffObj.id : null,
      type_id: data.typeId,
      subtype_id: subObj ? subObj._id : null,
      record_date: data.date,
      amount: data.amount,
      commission: data.commission,
      note: data.note || '',
      transfer_from: data.transferFrom || '',
      transfer_status: transferStatus,
      images: data.images || [],
      created_by: cache.profile.user_id
    };

    // ===== v5.4-fix P0-3: 多级降级尝试 + 全局警告 =====
    // 尝试顺序：完整字段 → 去掉 transfer_status → 去掉 transfer_from → 两者都去掉
    var missingCols = [];
    var result = await SupaAuth.getClient().from('records').insert(insertData).select('*').single();

    if (result.error && result.error.message) {
      var msg = result.error.message;
      var needRetry = false;
      if (msg.indexOf('transfer_status') >= 0) {
        delete insertData.transfer_status;
        missingCols.push('transfer_status');
        needRetry = true;
      }
      if (msg.indexOf('transfer_from') >= 0) {
        delete insertData.transfer_from;
        missingCols.push('transfer_from');
        needRetry = true;
      }
      if (needRetry) {
        result = await SupaAuth.getClient().from('records').insert(insertData).select('*').single();
        // 如果第二次还有列缺失错误，再降级一次（以防两列同时报错被第一次只捕获了一个）
        if (result.error && result.error.message) {
          var msg2 = result.error.message;
          var needRetry2 = false;
          if (msg2.indexOf('transfer_status') >= 0 && insertData.transfer_status !== undefined) {
            delete insertData.transfer_status;
            if (missingCols.indexOf('transfer_status') < 0) missingCols.push('transfer_status');
            needRetry2 = true;
          }
          if (msg2.indexOf('transfer_from') >= 0 && insertData.transfer_from !== undefined) {
            delete insertData.transfer_from;
            if (missingCols.indexOf('transfer_from') < 0) missingCols.push('transfer_from');
            needRetry2 = true;
          }
          if (needRetry2) {
            result = await SupaAuth.getClient().from('records').insert(insertData).select('*').single();
          }
        }
      }
    }

    // ===== 记录 schema 缺失，触发全局 UI 强提示 =====
    if (missingCols.length > 0) {
      console.warn('[addRecord v5.4] 数据库缺少列：', missingCols,
                   '。请在 Supabase SQL Editor 中运行升级脚本 transfer-schema-fix.sql');
      window.__recordsSchemaMissing = (window.__recordsSchemaMissing || []).concat(
        missingCols.filter(function (c) { return (window.__recordsSchemaMissing || []).indexOf(c) < 0; })
      );
      // 通过自定义事件通知 UI 层显示 banner
      try {
        window.dispatchEvent(new CustomEvent('records-schema-missing', {
          detail: { columns: window.__recordsSchemaMissing }
        }));
      } catch (e) { /* ignore old browsers */ }
    }

    if (!result.error && result.data) {
      // 用真实 ID 替换临时 ID
      var idx = cache.records.findIndex(function (r) { return r.id === newRecord.id; });
      if (idx >= 0) {
        newRecord.id = result.data.id;
        newRecord._staffId = result.data.staff_id;
        newRecord._typeId = result.data.type_id;
        newRecord._subtypeId = result.data.subtype_id;
        newRecord._createdBy = result.data.created_by;
        cache.records[idx] = newRecord;
      }
    } else if (result.error) {
      console.error('保存记录到数据库失败:', result.error);
    }

    return { data: newRecord, error: result.error, schemaMissing: missingCols };
  }

  // 删除记录
  async function removeRecord(id) {
    // 先更新缓存
    cache.records = cache.records.filter(function (r) { return r.id !== id; });

    if (!useSupabase) {
      localStorage.setItem(SK_RECORDS, JSON.stringify(cache.records));
      return { error: null };
    }

    var result = await SupaAuth.getClient().from('records').delete().eq('id', id);
    return { error: result.error };
  }

  /* ===== 过渡审批 ===== */

  // ===== v5.4-fix P1: 获取待审批过渡记录 =====
  // - 普通店员：只显示「别人过渡给我」的 pending 记录
  // - 店长：显示本店所有 pending 过渡（可强制审批/拒绝）
  function getPendingTransfers() {
    if (!useSupabase) return [];
    var myName = getMyStaffName();
    var isMgr = isManager();
    return cache.records.filter(function (r) {
      if (!r.transferFrom || r.transferFrom === r.staff) return false;
      if (r.transferStatus !== 'pending') return false;
      // 店长：全店所有 pending 过渡都能看到
      if (isMgr) return true;
      // 普通店员：只能看到过渡给自己的
      return r.staff === myName;
    });
  }

  // 审批通过
  async function approveTransfer(recordId) {
    // ===== v5.4-fix P0-1: 身份校验 =====
    var idx = cache.records.findIndex(function (r) { return r.id === recordId; });
    if (idx < 0) {
      return { error: { message: '记录不存在' } };
    }
    var record = cache.records[idx];
    var myName = getMyStaffName();
    var isRecipient = record.staff === myName;
    var isMgr = isManager();
    if (!isRecipient && !isMgr) {
      console.warn('[approveTransfer v5.4] 权限拒绝：caller=' + myName +
                   ' recipient=' + record.staff + ' isManager=' + isMgr);
      return { error: { message: '只有被过渡人本人或店长才能审批' } };
    }
    if (record.transferStatus !== 'pending') {
      return { error: { message: '该记录状态已变更，无需重复审批' } };
    }

    // 更新缓存
    cache.records[idx].transferStatus = 'approved';

    if (!useSupabase) return { error: null };

    var result = await SupaAuth.getClient().from('records')
      .update({ transfer_status: 'approved' }).eq('id', recordId);

    // 如果 transfer_status 列不存在，提示用户运行 SQL 更新
    if (result.error && result.error.message && result.error.message.indexOf('transfer_status') >= 0) {
      return { error: { message: '请先在 Supabase 中运行 update-v4.sql 添加 transfer_status 字段' } };
    }

    return { error: result.error };
  }

  // ===== v5.4-fix P0-2: 审批拒绝（不删除，业绩退回给发起者）=====
  async function rejectTransfer(recordId) {
    // ===== P0-1: 身份校验 =====
    var idx = cache.records.findIndex(function (r) { return r.id === recordId; });
    if (idx < 0) {
      return { error: { message: '记录不存在' } };
    }
    var record = cache.records[idx];
    var myName = getMyStaffName();
    var isRecipient = record.staff === myName;
    var isMgr = isManager();
    if (!isRecipient && !isMgr) {
      console.warn('[rejectTransfer v5.4] 权限拒绝：caller=' + myName +
                   ' recipient=' + record.staff + ' isManager=' + isMgr);
      return { error: { message: '只有被过渡人本人或店长才能拒绝' } };
    }
    if (record.transferStatus !== 'pending') {
      return { error: { message: '该记录状态已变更，无需重复操作' } };
    }

    // ===== P0-2: 业绩退回，不删除 =====
    // 把 staff 改回 transferFrom，transferStatus 标记为 rejected
    // 同时清空 transferFrom 让它在发起人那边看起来像一条普通记录
    var originalFrom = record.transferFrom || '';
    cache.records[idx].staff = originalFrom;
    cache.records[idx].transferStatus = 'rejected';
    // 保留 transferFrom 字段作为历史溯源，但不再参与业务计算
    // （getMyOutgoingTransfers/getPendingTransfers 都只认 transferStatus=pending）

    if (!useSupabase) {
      localStorage.setItem(SK_RECORDS, JSON.stringify(cache.records));
      return { error: null };
    }

    var shopId = cache.profile.shop_id;
    var fromStaffObj = cache.staffObjects.find(function (s) { return s.name === originalFrom; });
    var updateData = {
      transfer_status: 'rejected',
      staff_id: fromStaffObj ? fromStaffObj.id : null
    };

    var result = await SupaAuth.getClient().from('records')
      .update(updateData).eq('id', recordId);

    // 如果 transfer_status 列不存在，尝试只更新 staff_id
    if (result.error && result.error.message && result.error.message.indexOf('transfer_status') >= 0) {
      delete updateData.transfer_status;
      result = await SupaAuth.getClient().from('records')
        .update(updateData).eq('id', recordId);
    }
    // 如果 staff_id 也不存在（老 schema），至少把缓存改了
    if (result.error && result.error.message && result.error.message.indexOf('staff_id') >= 0) {
      console.warn('[rejectTransfer v5.4] staff_id 列不存在，仅更新前端缓存');
      return { error: null };
    }

    return { error: result.error };
  }

  // 检查当前用户是否可以删除某条记录
  // 规则：过渡者可以删除，被过渡人不能删除，管理员可以删除
  function canDeleteRecord(record) {
    if (!useSupabase) return true;
    if (isManager()) return true;
    var myName = getMyStaffName();
    // 自己添加给自己的记录可以删
    if (record.staff === myName && (!record.transferFrom || record.transferFrom === myName)) return true;
    // 过渡者（发起人）可以删除
    if (record.transferFrom === myName) return true;
    // 被过渡人不能删除别人过渡给他的记录
    return false;
  }

  /* ===== 写操作：类型 ===== */

  // 保存类型（新增或编辑）
  async function saveType(typeData) {
    if (!useSupabase) {
      // localStorage 模式：直接更新
      var existing = cache.types.find(function (t) { return t.id === typeData.id; });
      if (existing) {
        Object.assign(existing, typeData);
      } else {
        cache.types.push(typeData);
      }
      localStorage.setItem(SK_TYPES, JSON.stringify(cache.types));
      return { data: typeData, error: null };
    }

    var shopId = cache.profile.shop_id;
    var client = SupaAuth.getClient();

    if (typeData.id && !String(typeData.id).startsWith('tmp_') && !String(typeData.id).startsWith('t')) {
      // 编辑已有类型
      await client.from('types').update({
        name: typeData.name,
        color: typeData.color
      }).eq('id', typeData.id);

      // 删除旧子类，重新插入
      await client.from('subtypes').delete().eq('type_id', typeData.id);

      if (typeData.subtypes && typeData.subtypes.length > 0) {
        var subInserts = typeData.subtypes.map(function (st, idx) {
          return {
            type_id: typeData.id,
            shop_id: shopId,
            name: st.name,
            calc_mode: st.calcMode || 'rate',
            rate: st.rate || 0,
            fixed: st.fixed || 0,
            sort_order: idx
          };
        });
        await client.from('subtypes').insert(subInserts);
      }

      // 更新缓存
      var tIdx = cache.types.findIndex(function (t) { return t.id === typeData.id; });
      if (tIdx >= 0) {
        cache.types[tIdx] = typeData;
        // 重新加载子类 ID
        var subResult = await client.from('subtypes').select('*').eq('type_id', typeData.id);
        if (subResult.data) {
          cache.types[tIdx].subtypes = subResult.data.map(function (st) {
            return { name: st.name, calcMode: st.calc_mode, rate: parseFloat(st.rate) || 0, fixed: parseFloat(st.fixed) || 0, _id: st.id, _typeId: st.type_id };
          });
        }
      }
    } else {
      // 新建类型
      var typeResult = await client.from('types').insert({
        shop_id: shopId,
        name: typeData.name,
        color: typeData.color,
        sort_order: cache.types.length
      }).select('*').single();

      if (typeResult.error) return { data: null, error: typeResult.error };

      var newTypeId = typeResult.data.id;

      if (typeData.subtypes && typeData.subtypes.length > 0) {
        var newSubInserts = typeData.subtypes.map(function (st, idx) {
          return {
            type_id: newTypeId,
            shop_id: shopId,
            name: st.name,
            calc_mode: st.calcMode || 'rate',
            rate: st.rate || 0,
            fixed: st.fixed || 0,
            sort_order: idx
          };
        });
        var subResult2 = await client.from('subtypes').insert(newSubInserts).select('*');
        typeData.subtypes = (subResult2.data || []).map(function (st) {
          return { name: st.name, calcMode: st.calc_mode, rate: parseFloat(st.rate) || 0, fixed: parseFloat(st.fixed) || 0, _id: st.id, _typeId: st.type_id };
        });
      }

      typeData.id = newTypeId;
      cache.types.push(typeData);
    }

    return { data: typeData, error: null };
  }

  // 删除类型
  async function removeType(id) {
    cache.types = cache.types.filter(function (t) { return t.id !== id; });

    if (!useSupabase) {
      localStorage.setItem(SK_TYPES, JSON.stringify(cache.types));
      return { error: null };
    }

    // 删除子类（由数据库 CASCADE 自动处理）
    var result = await SupaAuth.getClient().from('types').delete().eq('id', id);
    return { error: result.error };
  }

  /* ===== 写操作：员工 ===== */

  // 添加员工
  async function addStaff(name) {
    if (cache.staff.indexOf(name) >= 0) return { error: { message: '该人员已存在' } };

    cache.staff.push(name);

    if (!useSupabase) {
      localStorage.setItem(SK_STAFF, JSON.stringify(cache.staff));
      return { error: null };
    }

    var result = await SupaAuth.getClient().from('staff').insert({
      shop_id: cache.profile.shop_id,
      name: name,
      sort_order: cache.staffObjects.length
    }).select('*').single();

    if (!result.error && result.data) {
      cache.staffObjects.push(result.data);
    }

    return { error: result.error };
  }

  /* ===== 从 localStorage 迁移到 Supabase ===== */
  async function migrateFromLocalStorage() {
    if (!useSupabase || !cache.profile) return { migrated: 0 };

    var oldRecords = [];
    var oldTypes = [];
    var oldStaff = [];

    try { oldRecords = JSON.parse(localStorage.getItem(SK_RECORDS)) || []; } catch (e) {}
    try { oldTypes = JSON.parse(localStorage.getItem(SK_TYPES)) || []; } catch (e) {}
    try { oldStaff = JSON.parse(localStorage.getItem(SK_STAFF)) || []; } catch (e) {}

    if (oldRecords.length === 0 && oldTypes.length === 0) return { migrated: 0 };

    var shopId = cache.profile.shop_id;
    var client = SupaAuth.getClient();
    var count = 0;

    // 1. 迁移 staff（跳过默认的"我"，因为用户在 Supabase 中已有真实名字）
    var staffIdMap = {}; // oldName → newId
    for (var s of oldStaff) {
      // 跳过"我"这个默认名，避免与用户的真实名字冲突
      if (s === '我') continue;
      if (cache.staff.indexOf(s) >= 0) {
        var existing = cache.staffObjects.find(function (so) { return so.name === s; });
        if (existing) staffIdMap[s] = existing.id;
        continue;
      }
      var sResult = await client.from('staff').insert({
        shop_id: shopId, name: s, sort_order: cache.staffObjects.length
      }).select('*').single();
      if (!sResult.error) {
        staffIdMap[s] = sResult.data.id;
        cache.staffObjects.push(sResult.data);
        cache.staff.push(s);
      }
    }
    // 将旧记录中 staff 为"我"的映射到当前用户真实名字
    var myRealName = getMyStaffName();
    if (myRealName && myRealName !== '我') {
      staffIdMap['我'] = (cache.staffObjects.find(function (so) { return so.name === myRealName; }) || {}).id || null;
    }

    // 2. 迁移 types + subtypes
    var typeIdMap = {}; // oldId → newId
    var subNameMap = {}; // oldTypeId+subName → newSubId
    for (var t of oldTypes) {
      var tResult = await client.from('types').insert({
        shop_id: shopId, name: t.name, color: t.color || '#4f46e5',
        sort_order: cache.types.length
      }).select('*').single();

      if (tResult.error) continue;
      var newTypeId = tResult.data.id;
      typeIdMap[t.id] = newTypeId;

      var subtypes = t.subtypes || [];
      var subInserts = subtypes.map(function (st, idx) {
        var normSt = typeof st === 'string' ? { name: st, calcMode: 'rate', rate: 0, fixed: 0 } : st;
        return {
          type_id: newTypeId, shop_id: shopId, name: normSt.name,
          calc_mode: normSt.calcMode || 'rate', rate: normSt.rate || 0,
          fixed: normSt.fixed || 0, sort_order: idx
        };
      });

      if (subInserts.length > 0) {
        var subResult = await client.from('subtypes').insert(subInserts).select('*');
        if (subResult.data) {
          subResult.data.forEach(function (nst, idx) {
            var origName = subtypes[idx] ? (typeof subtypes[idx] === 'string' ? subtypes[idx] : subtypes[idx].name) : '';
            subNameMap[t.id + '_' + origName] = nst.id;
          });
        }
      }

      // 更新缓存
      cache.types.push({
        id: newTypeId, name: t.name, color: t.color || '#4f46e5',
        subtypes: subtypes.map(function (st, idx) {
          var normSt = typeof st === 'string' ? { name: st, calcMode: 'rate', rate: 0, fixed: 0 } : st;
          var subId = subResult && subResult.data ? subResult.data[idx].id : null;
          return { name: normSt.name, calcMode: normSt.calcMode || 'rate', rate: normSt.rate || 0, fixed: normSt.fixed || 0, _id: subId, _typeId: newTypeId };
        })
      });
    }

    // 3. 迁移 records
    for (var r of oldRecords) {
      var newTypeId = typeIdMap[r.typeId] || null;
      var subKey = r.typeId + '_' + (r.subtype || '');
      var newSubId = subNameMap[subKey] || null;
      var staffId = staffIdMap[r.staff] || (cache.staffObjects.find(function (so) { return so.name === r.staff; }) || {}).id || null;

      var rResult = await client.from('records').insert({
        shop_id: shopId,
        staff_id: staffId,
        type_id: newTypeId,
        subtype_id: newSubId,
        record_date: r.date,
        amount: r.amount,
        commission: r.commission,
        note: r.note || '',
        transfer_from: r.transferFrom || '',
        transfer_status: 'approved',
        images: r.images || [],
        created_by: cache.profile.user_id
      }).select('*').single();

      if (!rResult.error) count++;
    }

    // 重新加载全部数据确保一致
    await loadAllFromSupabase();

    // 清除 localStorage
    localStorage.removeItem(SK_RECORDS);
    localStorage.removeItem(SK_TYPES);
    localStorage.removeItem(SK_STAFF);

    return { migrated: count };
  }

  // 检查是否有可迁移的本地数据
  function hasLocalData() {
    try {
      var r = JSON.parse(localStorage.getItem(SK_RECORDS) || '[]');
      var t = JSON.parse(localStorage.getItem(SK_TYPES) || '[]');
      return r.length > 0 || t.length > 0;
    } catch (e) {
      return false;
    }
  }

  /* ===== 刷新数据（从 Supabase 重新加载）===== */
  async function refresh() {
    if (!useSupabase) {
      loadFromLocalStorage();
      return;
    }
    await loadAllFromSupabase();
  }

  /* ===== Public API ===== */
  return {
    init: init,
    refresh: refresh,
    // 同步读取
    loadRecords: loadRecords,
    loadStaff: loadStaff,
    loadTypes: loadTypes,
    getProfile: getProfile,
    getShop: getShop,
    isManager: isManager,
    isSupaMode: isSupaMode,
    getMyStaffName: getMyStaffName,
    // 异步写入
    addRecord: addRecord,
    removeRecord: removeRecord,
    saveType: saveType,
    removeType: removeType,
    addStaff: addStaff,
    // 过渡审批
    getPendingTransfers: getPendingTransfers,
    approveTransfer: approveTransfer,
    rejectTransfer: rejectTransfer,
    canDeleteRecord: canDeleteRecord,
    // 迁移
    migrateFromLocalStorage: migrateFromLocalStorage,
    hasLocalData: hasLocalData
  };
})();
