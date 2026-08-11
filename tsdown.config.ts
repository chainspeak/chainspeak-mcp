import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', stdio: 'src/adapters/stdio.ts', http: 'src/adapters/http.ts' },
  format: 'esm',
  platform: 'node',
  clean: true,
  dts: true,
})
