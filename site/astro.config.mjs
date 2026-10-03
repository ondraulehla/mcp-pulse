import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  site: 'https://mcp-pulse.ulehla.dev',
  trailingSlash: 'never',
  build: { format: 'file' },
  vite: { server: { fs: { allow: ['..'] } } }
});
