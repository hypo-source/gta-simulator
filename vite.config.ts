import { defineConfig } from 'vite';

// command 변수를 통해 현재가 'build' 인지 'serve'(dev) 인지 판단합니다.
export default defineConfig(({ command }) => {
  // 공통 설정 (server 등)을 객체로 정의
  const config = {
    server: {
      host: true, // 0.0.0.0 로 바인딩
      port: 5173,
    },
    // 기본적으로 루트('/') 사용
    base: '/',
  };

  // 만약 빌드(npm run build) 중이라면, GitHub 저장소 이름을 base로 설정
  if (command === 'build') {
    config.base = '/gta-simulator/'; // 여기에 실제 GitHub 저장소 이름을 넣으세요.
  }

  return config;
});