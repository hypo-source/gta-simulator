export const WorldConfig = {
  CHUNK_SIZE: 64,
  // Dynamic quality targets (AutoQuality may tweak these at runtime)
  FAR_RADIUS_MAX: 3,
  // Lower radius dramatically reduces draw calls & instances.
  FAR_RADIUS: 2,
  MAX_RENDER_DIST: 220,

  // Window density (higher = fewer windows)
  WINDOW_SKIP_FRONT: 0.28,
  WINDOW_SKIP_SIDE: 0.32,

  // Manual LOD switching distance (player distance from building)
  BUILDING_DETAIL_LOD_DIST: 46,

  // ---- NPC (Step 4) ----
  // Sim NPC: 가까운 거리에서만 실제 로직/애니메이션을 굴립니다.
  NPC_SIM_MAX: 16,
  NPC_SIM_RADIUS: 42,
  // Crowd NPC: 중거리에서 “많아 보이기”용. 로직은 저주기 업데이트.
  NPC_CROWD_MAX: 140,
  NPC_CROWD_RADIUS: 120,
  // Fake NPC: 원거리 장식(업데이트 거의 없음)
  NPC_FAKE_MAX: 260,
  NPC_FAKE_RADIUS: 200,

  // AI 업데이트 스케줄(로직만 저주기, 렌더는 매프레임)
  NPC_SIM_LOGIC_HZ: 15, // 10~20fps 권장
  NPC_CROWD_LOGIC_HZ: 4, // 2~5fps 권장
  NPC_FAKE_REFRESH_HZ: 0.5, // 1~2초에 한 번만 재배치/리프레시
};
