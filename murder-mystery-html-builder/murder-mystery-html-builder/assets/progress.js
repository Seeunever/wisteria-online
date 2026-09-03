(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ProgressEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizedConfig(config) {
    if (!config || typeof config !== 'object' || typeof config.fingerprint !== 'string') {
      throw new Error('无效进度配置');
    }
    if (!Array.isArray(config.roles) || config.roles.length === 0) throw new Error('无效角色配置');
    const seen = new Set();
    const roles = config.roles.map((role) => {
      if (!role || typeof role.id !== 'string' || !role.id || seen.has(role.id)) throw new Error('无效角色配置');
      if (!Number.isInteger(role.stageCount) || role.stageCount < 1) throw new Error('无效角色阶段数');
      seen.add(role.id);
      return {id: role.id, stageCount: role.stageCount};
    });
    const mode = config.mode === 'open-single' ? 'open-single' : 'guided-single';
    return {fingerprint: config.fingerprint, roles, mode};
  }

  function createDefault(config) {
    const normalized = normalizedConfig(config);
    const roles = {};
    for (const role of normalized.roles) {
      roles[role.id] = {unlockedStage: normalized.mode === 'open-single' ? role.stageCount : 1};
    }
    return {version: VERSION, fingerprint: normalized.fingerprint, selectedRole: null, roles};
  }

  function roleConfig(config, roleId) {
    const normalized = normalizedConfig(config);
    const role = normalized.roles.find((candidate) => candidate.id === roleId);
    if (!role) throw new Error('未知角色');
    return {normalized, role};
  }

  function validateState(input, config) {
    const normalized = normalizedConfig(config);
    if (!input || input.version !== VERSION || input.fingerprint !== normalized.fingerprint) {
      throw new Error('进度内容不匹配');
    }
    if (input.selectedRole !== null && !normalized.roles.some((role) => role.id === input.selectedRole)) {
      throw new Error('进度包含未知角色');
    }
    const state = createDefault(normalized);
    state.selectedRole = input.selectedRole;
    for (const role of normalized.roles) {
      const value = input.roles && input.roles[role.id];
      if (!value || !Number.isInteger(value.unlockedStage) || value.unlockedStage < 1 || value.unlockedStage > role.stageCount) {
        throw new Error('进度包含无效阶段');
      }
      state.roles[role.id].unlockedStage = value.unlockedStage;
    }
    return state;
  }

  function selectRole(input, roleId) {
    if (!input.roles || !Object.prototype.hasOwnProperty.call(input.roles, roleId)) throw new Error('未知角色');
    const state = clone(input);
    state.selectedRole = roleId;
    return state;
  }

  function unlockStage(input, roleId, stage, config) {
    const {role} = roleConfig(config, roleId);
    if (!Number.isInteger(stage) || stage < 1 || stage > role.stageCount) throw new Error('无效阶段');
    const state = validateState(input, config);
    const current = state.roles[roleId].unlockedStage;
    if (stage > current + 1) throw new Error('请先完成上一阶段');
    state.roles[roleId].unlockedStage = Math.max(current, stage);
    return state;
  }

  function resetRole(input, roleId, config) {
    const {normalized, role} = roleConfig(config, roleId);
    const state = validateState(input, normalized);
    state.roles[roleId].unlockedStage = normalized.mode === 'open-single' ? role.stageCount : 1;
    return state;
  }

  function resetAll(config) {
    return createDefault(config);
  }

  function toBase64Url(text) {
    if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64url');
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64Url(code) {
    if (typeof Buffer !== 'undefined') return Buffer.from(code, 'base64url').toString('utf8');
    const padded = code.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((code.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function encode(state) {
    return toBase64Url(JSON.stringify(state));
  }

  function decode(code, config) {
    try {
      const parsed = JSON.parse(fromBase64Url(String(code).trim()));
      return validateState(parsed, config);
    } catch (error) {
      if (error && /内容不匹配/.test(error.message)) throw error;
      throw new Error('无效进度码');
    }
  }

  return {VERSION, createDefault, selectRole, unlockStage, resetRole, resetAll, encode, decode};
});
