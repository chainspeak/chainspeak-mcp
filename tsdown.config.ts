import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { stdio: 'src/main/stdio.ts', http: 'src/main/http.ts' },
  format: 'esm',
  platform: 'node',
  clean: true,
  dts: false,
})
